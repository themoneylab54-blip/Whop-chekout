import { afterAll, describe, expect, it, vi } from "vitest";

/*
 * Builder image uploads against a real Postgres: upload (admin route) → public serve (ETag, 304)
 * → usage → delete, the per-store cap and store isolation. Test data is prefixed med_ and deleted.
 */

const hasDb = !!process.env.DATABASE_URL;

/** Signed in unless a test says otherwise (the media routes answer 401 JSON, never a redirect). */
const auth = vi.hoisted(() => ({ admin: "admin" as string | null }));
vi.mock("@/lib/auth", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth")>()),
  requireAdmin: async () => "admin",
  currentAdminId: async () => auth.admin,
  currentUser: async () => (auth.admin ? (await import("../session-stub")).ownerUser(auth.admin) : null),
}));

/** Shaped like Next's redirect error (the clone action ends with one). */
class Redirect extends Error {
  constructor(public url: string) {
    super("NEXT_REDIRECT");
  }
}
vi.mock("next/navigation", async (orig) => ({
  ...(await orig<typeof import("next/navigation")>()),
  redirect: (url: string) => {
    throw new Redirect(url);
  },
}));
vi.mock("next/cache", async (orig) => ({ ...(await orig<typeof import("next/cache")>()), revalidatePath: () => undefined }));

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

describe.skipIf(!hasDb)("builder media uploads (integration)", async () => {
  const { db } = await import("@/lib/db");
  const media = await import("@/lib/media");
  const upload = await import("@/app/dashboard/stores/[storeId]/media/route");
  const one = await import("@/app/dashboard/stores/[storeId]/media/[mediaId]/route");
  const pub = await import("@/app/api/public/media/[mediaId]/route");
  const created: string[] = [];

  async function store() {
    const s = await db.store.create({ data: { name: `med_${Math.random().toString(36).slice(2, 8)}` } });
    created.push(s.id);
    return s;
  }
  const post = (storeId: string, body: Buffer, type: string, name = "logo.png") => {
    const fd = new FormData();
    fd.append("file", new File([new Uint8Array(body)], name, { type }));
    return upload.POST(new Request(`http://x/dashboard/stores/${storeId}/media`, { method: "POST", body: fd }), { params: Promise.resolve({ storeId }) });
  };

  afterAll(async () => {
    await db.store.deleteMany({ where: { id: { in: created } } });
  });

  it("uploads, serves publicly (cacheable, ETag / 304), reports usage and deletes", async () => {
    const s = await store();
    const res = await post(s.id, PNG, "image/png");
    expect(res.status).toBe(201);
    const { media: m } = (await res.json()) as { media: { id: string; url: string; width: number; height: number; size: number } };
    expect(m.url).toBe(`/api/public/media/${m.id}`);
    expect([m.width, m.height, m.size]).toEqual([1, 1, PNG.length]);

    const got = await pub.GET(new Request(`http://checkout.seyuna.test${m.url}`), { params: Promise.resolve({ mediaId: m.id }) });
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe("image/png");
    expect(got.headers.get("cache-control")).toContain("immutable");
    expect(got.headers.get("cache-control")).toContain("s-maxage=31536000");
    expect(got.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await got.arrayBuffer()).equals(PNG)).toBe(true);
    const etag = got.headers.get("etag")!;
    const again = await pub.GET(new Request(`http://x${m.url}`, { headers: { "If-None-Match": etag } }), { params: Promise.resolve({ mediaId: m.id }) });
    expect(again.status).toBe(304);
    // A query string (cache buster) would bypass the CDN copy: 308 to the bare path, no bytes served.
    const busted = await pub.GET(new Request(`http://checkout.seyuna.test${m.url}?v=2&t=1`), { params: Promise.resolve({ mediaId: m.id }) });
    expect(busted.status).toBe(308);
    expect(busted.headers.get("location")).toBe(m.url);
    expect(busted.headers.get("cache-control")).toContain("public");
    expect(await busted.text()).toBe("");
    // Ids are lowercase: an upper-case id redirects to the canonical path too.
    const upper = await pub.GET(new Request(`http://x/api/public/media/${m.id.toUpperCase()}`), { params: Promise.resolve({ mediaId: m.id.toUpperCase() }) });
    expect([upper.status, upper.headers.get("location")]).toEqual([308, m.url]);
    // Not an id: no redirect, a plain 404.
    expect((await pub.GET(new Request("http://x/api/public/media/..%2Fx?v=1"), { params: Promise.resolve({ mediaId: "../x" }) })).status).toBe(404);
    // A bare "?" is no query: served directly.
    expect((await pub.GET(new Request(`http://x${m.url}?`), { params: Promise.resolve({ mediaId: m.id }) })).status).toBe(200);

    const list = (await (await upload.GET(new Request("http://x"), { params: Promise.resolve({ storeId: s.id }) })).json()) as { media: { id: string }[] };
    expect(list.media.map((x) => x.id)).toEqual([m.id]);

    // Used by the draft header → reported before deletion.
    await db.store.update({ where: { id: s.id }, data: { draftTheme: { headerMode: "banner", bannerUrl: m.url } } });
    const usage = (await (await one.GET(new Request("http://x"), { params: Promise.resolve({ storeId: s.id, mediaId: m.id }) })).json()) as { usage: { draft: boolean; published: boolean; versions: number } };
    expect(usage.usage).toEqual({ draft: true, published: false, versions: 0 });

    // Another store can't delete it.
    const other = await store();
    const foreign = await one.DELETE(new Request("http://x", { method: "DELETE" }), { params: Promise.resolve({ storeId: other.id, mediaId: m.id }) });
    expect(foreign.status).toBe(404);

    const del = await one.DELETE(new Request("http://x", { method: "DELETE" }), { params: Promise.resolve({ storeId: s.id, mediaId: m.id }) });
    expect(del.status).toBe(200);
    const gone = await pub.GET(new Request(`http://x${m.url}`), { params: Promise.resolve({ mediaId: m.id }) });
    expect(gone.status).toBe(404);
    // A browser revalidating its cached copy gets the 404 too, not a 304.
    const stale = await pub.GET(new Request(`http://x${m.url}`, { headers: { "If-None-Match": etag } }), { params: Promise.resolve({ mediaId: m.id }) });
    expect(stale.status).toBe(404);
    // The draft no longer points to the deleted image.
    const after = await db.store.findUniqueOrThrow({ where: { id: s.id }, select: { draftTheme: true } });
    expect(after.draftTheme).toEqual({ headerMode: "banner", bannerUrl: "" });
  });

  const del = (storeId: string, mediaId: string, query = "") =>
    one.DELETE(new Request(`http://x/dashboard/stores/${storeId}/media/${mediaId}${query}`, { method: "DELETE" }), { params: Promise.resolve({ storeId, mediaId }) });

  it("refuses to delete an image the published checkout shows (409), then allows it once replaced", async () => {
    const s = await store();
    const saved = await media.saveMedia(s.id, PNG, "image/png");
    if (!saved.ok) throw new Error("upload failed");
    const url = saved.media.url;
    await db.store.update({
      where: { id: s.id },
      data: {
        theme: { headerMode: "logo", logoUrl: url },
        draftTheme: { headerMode: "logo", logoUrl: url },
        draftCheckoutLayout: { blocks: [{ id: "b1", type: "image", props: { url, alt: "" } }] },
      },
    });
    const refused = await del(s.id, saved.media.id);
    expect(refused.status).toBe(409);
    const body = (await refused.json()) as { error: string; message: string; usage: { published: boolean } };
    expect(body.error).toBe("in_use");
    expect(body.usage.published).toBe(true);
    expect(body.message).toMatch(/checkout publié/);
    // ?versions=1 never overrides the live checkout.
    expect((await del(s.id, saved.media.id, "?versions=1")).status).toBe(409);
    expect(await db.storeMedia.count({ where: { id: saved.media.id } })).toBe(1);

    // Published design no longer uses it, but a saved version does: 409 until confirmed.
    await db.store.update({ where: { id: s.id }, data: { theme: { headerMode: "name" } } });
    await db.layoutVersion.create({ data: { storeId: s.id, label: "v1", theme: { logoUrl: url }, checkoutLayout: { blocks: [] }, thankYouLayout: { blocks: [] } } });
    const versions = await del(s.id, saved.media.id);
    expect(versions.status).toBe(409);
    expect(((await versions.json()) as { usage: { versions: number } }).usage.versions).toBe(1);
    expect((await del(s.id, saved.media.id, "?versions=1")).status).toBe(200);
    // Every draft field that showed it is emptied (theme and layout).
    const after = await db.store.findUniqueOrThrow({ where: { id: s.id }, select: { draftTheme: true, draftCheckoutLayout: true } });
    expect(after.draftTheme).toEqual({ headerMode: "logo", logoUrl: "" });
    expect(after.draftCheckoutLayout).toEqual({ blocks: [{ id: "b1", type: "image", props: { url: "", alt: "" } }] });
  });

  it("refuses to delete an image a running A/B test shows (variant B or pinned control A), even with ?versions=1", async () => {
    const s = await store();
    const saved = await media.saveMedia(s.id, PNG, "image/png");
    if (!saved.ok) throw new Error("upload failed");
    const url = saved.media.url;
    const v = await db.layoutVersion.create({ data: { storeId: s.id, label: "B", theme: { headerMode: "logo", logoUrl: url }, checkoutLayout: { blocks: [] }, thankYouLayout: { blocks: [] } } });
    const other = await db.layoutVersion.create({ data: { storeId: s.id, label: "x", theme: {}, checkoutLayout: { blocks: [] }, thankYouLayout: { blocks: [] } } });
    const exp = await db.experiment.create({ data: { storeId: s.id, name: "t", versionId: v.id, versionIdA: other.id } });
    const b = await del(s.id, saved.media.id, "?versions=1");
    expect(b.status).toBe(409);
    expect(((await b.json()) as { usage: { published: boolean } }).usage.published).toBe(true);
    // Control A pinned to that version instead.
    await db.experiment.update({ where: { id: exp.id }, data: { versionId: other.id, versionIdA: v.id } });
    expect((await del(s.id, saved.media.id, "?versions=1")).status).toBe(409);
    // Test stopped: a saved version like any other (deletable once confirmed).
    await db.experiment.update({ where: { id: exp.id }, data: { status: "STOPPED" } });
    expect((await del(s.id, saved.media.id)).status).toBe(409);
    expect((await del(s.id, saved.media.id, "?versions=1")).status).toBe(200);
  });

  it("publishing never makes a deleted image live (undo / restored version brought it back)", async () => {
    const actions = await import("@/app/dashboard/actions");
    const s = await store();
    const kept = await media.saveMedia(s.id, PNG, "image/png");
    if (!kept.ok) throw new Error("upload failed");
    const gone = "/api/public/media/0123456789abcdef0123456789abcdef";
    await db.store.update({
      where: { id: s.id },
      data: {
        draftTheme: { headerMode: "banner", bannerUrl: `https://app.example.com${gone}`, logoUrl: kept.media.url },
        draftCheckoutLayout: { blocks: [{ id: "b1", type: "image", props: { url: gone, alt: "" } }] },
        draftThankYouLayout: { blocks: [] },
      },
    });
    // A deleted image emptied (two fields): the builder is told to reload the published design.
    expect(await actions.publishDesignAction(s.id, "v")).toEqual({ ok: true, stripped: 1 });
    const after = await db.store.findUniqueOrThrow({ where: { id: s.id }, select: { theme: true, checkoutLayout: true } });
    const theme = after.theme as { bannerUrl: string; logoUrl: string };
    expect(theme.bannerUrl).toBe("");
    expect(theme.logoUrl).toBe(kept.media.url);
    expect((after.checkoutLayout as { blocks: { props: { url: string } }[] }).blocks[0].props.url).toBe("");
    const version = await db.layoutVersion.findFirstOrThrow({ where: { storeId: s.id } });
    expect(JSON.stringify(version.theme)).not.toContain(gone);
  });

  /** The flash message a redirecting server action ends with. */
  async function flashOf(run: () => Promise<unknown>): Promise<{ ok?: string; error?: string; field?: string }> {
    try {
      await run();
    } catch (err) {
      if (!(err instanceof Redirect)) throw err;
      const q = new URL(err.url, "http://x").searchParams;
      return { ok: q.get("ok") ?? undefined, error: q.get("error") ?? undefined, field: q.get("field") ?? undefined };
    }
    throw new Error("no redirect");
  }
  const form = (fields: Record<string, string>) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    return fd;
  };
  const layouts = { checkoutLayout: { blocks: [] }, thankYouLayout: { blocks: [] } };

  it("an A/B test never serves a deleted image: refused variant, emptied control, emptied on promotion", async () => {
    const actions = await import("@/app/dashboard/actions");
    const s = await store();
    const kept = await media.saveMedia(s.id, PNG, "image/png");
    if (!kept.ok) throw new Error("upload failed");
    const gone = "/api/public/media/0123456789abcdef0123456789abcdef";
    // The published design still names a deleted image (a delete raced an earlier write).
    await db.store.update({ where: { id: s.id }, data: { theme: { headerMode: "banner", bannerUrl: gone, logoUrl: kept.media.url }, ...layouts } });
    const bad = await db.layoutVersion.create({ data: { storeId: s.id, label: "B cassée", theme: { logoUrl: `https://app.example.com${gone}?v=2` }, ...layouts } });
    const good = await db.layoutVersion.create({ data: { storeId: s.id, label: "B", theme: { headerMode: "logo", logoUrl: kept.media.url }, ...layouts } });

    const refused = await flashOf(() => actions.startExperimentAction(s.id, form({ versionId: bad.id, split: "50" })));
    expect(refused.field).toBe("versionId");
    expect(refused.error).toMatch(/image supprimée/);
    expect(await db.experiment.count({ where: { storeId: s.id } })).toBe(0);
    expect(await db.layoutVersion.count({ where: { storeId: s.id } })).toBe(2);

    expect((await flashOf(() => actions.startExperimentAction(s.id, form({ versionId: good.id, split: "50" })))).ok).toBeTruthy();
    const exp = await db.experiment.findFirstOrThrow({ where: { storeId: s.id, status: "RUNNING" } });
    const control = await db.layoutVersion.findUniqueOrThrow({ where: { id: exp.versionIdA! } });
    expect(control.theme).toEqual({ headerMode: "banner", bannerUrl: "", logoUrl: kept.media.url });
    // Running: the variant's image can't be deleted.
    expect((await del(s.id, kept.media.id, "?versions=1")).status).toBe(409);

    // The image disappears anyway (row removed behind the app's back): promoting B empties it.
    await db.storeMedia.delete({ where: { id: kept.media.id } });
    await flashOf(() => actions.stopExperimentAction(s.id, exp.id, true));
    const after = await db.store.findUniqueOrThrow({ where: { id: s.id }, select: { theme: true } });
    expect(after.theme).toEqual({ headerMode: "logo", logoUrl: "" });
    expect((await db.experiment.findUniqueOrThrow({ where: { id: exp.id } })).status).toBe("STOPPED");
  });

  it("an add-on's image counts as published: it can't be deleted while the add-on shows it", async () => {
    const s = await store();
    const saved = await media.saveMedia(s.id, PNG, "image/png");
    if (!saved.ok) throw new Error("upload failed");
    const addOn = await db.addOn.create({ data: { storeId: s.id, title: "Emballage", priceCents: 300, imageUrl: `https://pay.shop.example${saved.media.url}?v=1` } });
    expect(await media.mediaUsage(s.id, saved.media.id)).toEqual({ published: true, draft: false, versions: 0 });
    const res = await del(s.id, saved.media.id, "?versions=1");
    expect(res.status).toBe(409);
    expect(((await res.json()) as { message: string }).message).toMatch(/option/);
    await db.addOn.update({ where: { id: addOn.id }, data: { imageUrl: null } });
    expect((await del(s.id, saved.media.id)).status).toBe(200);
  });

  it("usage is case-insensitive, as mediaIdOf: an upper-case reference still counts", async () => {
    const s = await store();
    const saved = await media.saveMedia(s.id, PNG, "image/png");
    if (!saved.ok) throw new Error("upload failed");
    const up = `https://Pay.Shop.example/API/public/media/${saved.media.id.toUpperCase()}`;
    await db.store.update({ where: { id: s.id }, data: { theme: { logoUrl: up }, draftTheme: { bannerUrl: up } } });
    await db.layoutVersion.create({ data: { storeId: s.id, label: "V", theme: { logoUrl: up }, ...layouts } });
    expect(await media.mediaUsage(s.id, saved.media.id)).toEqual({ published: true, draft: true, versions: 1 });
    await db.store.update({ where: { id: s.id }, data: { theme: {} } });
    await db.addOn.create({ data: { storeId: s.id, title: "Opt", priceCents: 100, imageUrl: up } });
    expect((await media.mediaUsage(s.id, saved.media.id)).published).toBe(true);
    // Nor is it treated as missing (and emptied) on publish / clone.
    expect(await media.missingMediaIds(db, s.id, { logoUrl: up })).toEqual([]);
  });

  it("duplicating a store empties images the source no longer has (design and add-ons)", async () => {
    const actions = await import("@/app/dashboard/actions");
    const s = await store();
    const kept = await media.saveMedia(s.id, PNG, "image/png");
    if (!kept.ok) throw new Error("upload failed");
    const gone = "/api/public/media/0123456789abcdef0123456789abcdef";
    await db.store.update({ where: { id: s.id }, data: { theme: { headerMode: "banner", bannerUrl: gone, logoUrl: kept.media.url }, ...layouts } });
    await db.addOn.create({ data: { storeId: s.id, title: "Option", priceCents: 100, imageUrl: `${gone}/` } });
    let target = "";
    try {
      await actions.cloneStoreAction(s.id);
    } catch (err) {
      if (!(err instanceof Redirect)) throw err;
      target = err.url;
    }
    const copyId = /\/dashboard\/stores\/([^/?#]+)/.exec(target)?.[1];
    expect(copyId).toBeTruthy();
    created.push(copyId!);
    const copy = await db.store.findUniqueOrThrow({ where: { id: copyId! }, select: { theme: true, addOns: { select: { imageUrl: true } } } });
    const theme = copy.theme as { bannerUrl: string; logoUrl: string };
    expect(theme.bannerUrl).toBe("");
    const logo = media.mediaIdOf(theme.logoUrl);
    expect(logo).toBeTruthy();
    expect(logo).not.toBe(kept.media.id);
    expect(await db.storeMedia.count({ where: { id: logo!, storeId: copyId! } })).toBe(1);
    expect(copy.addOns).toEqual([{ imageUrl: "" }]);
  });

  it("refuses an image whose pixel size can't be read (media_dims)", async () => {
    const s = await store();
    // A JPEG with no frame header (SOF): its decoded size is unknown.
    const noSof = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...Array(14).fill(0), 0xff, 0xd9, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(await media.saveMedia(s.id, noSof, "image/jpeg")).toEqual({ ok: false, error: "media_dims" });
    expect(await db.storeMedia.count({ where: { storeId: s.id } })).toBe(0);
  });

  it("answers 401 JSON (not a login redirect) when the session is gone", async () => {
    const s = await store();
    auth.admin = null;
    try {
      const res = await post(s.id, PNG, "image/png");
      expect(res.status).toBe(401);
      expect(((await res.json()) as { message: string }).message).toBe("Session expirée, reconnectez-vous.");
      expect((await upload.GET(new Request("http://x"), { params: Promise.resolve({ storeId: s.id }) })).status).toBe(401);
      expect((await del(s.id, "cmabc123def456")).status).toBe(401);
      expect((await one.GET(new Request("http://x"), { params: Promise.resolve({ storeId: s.id, mediaId: "cmabc123def456" }) })).status).toBe(401);
    } finally {
      auth.admin = "admin";
    }
  });

  it("refuses an image too large in pixels (header dimensions), whatever its file size", async () => {
    const s = await store();
    const huge = Buffer.from(PNG);
    huge.writeUInt32BE(6001, 16);
    const res = await post(s.id, huge, "image/png");
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe("media_dims");
    const tall = Buffer.from(PNG);
    tall.writeUInt32BE(5000, 16);
    tall.writeUInt32BE(5001, 20);
    expect((await post(s.id, tall, "image/png")).status).toBe(422);
    expect(await db.storeMedia.count({ where: { storeId: s.id } })).toBe(0);
  });

  it("duplicating a store copies its images and points the copy's design to them", async () => {
    const actions = await import("@/app/dashboard/actions");
    const s = await store();
    const a = await media.saveMedia(s.id, PNG, "image/png");
    const b = await media.saveMedia(s.id, PNG, "image/png");
    if (!a.ok || !b.ok) throw new Error("upload failed");
    await db.store.update({
      where: { id: s.id },
      data: {
        theme: { headerMode: "banner", bannerUrl: a.media.url, logoUrl: "https://cdn.example.com/logo.png" },
        checkoutLayout: { blocks: [{ id: "b1", type: "image", props: { url: b.media.url, alt: "" } }] },
        thankYouLayout: { blocks: [] },
      },
    });
    let target = "";
    try {
      await actions.cloneStoreAction(s.id);
    } catch (err) {
      if (!(err instanceof Redirect)) throw err;
      target = err.url;
    }
    const copyId = /\/dashboard\/stores\/([^/?#]+)/.exec(target)?.[1];
    expect(copyId).toBeTruthy();
    created.push(copyId!);
    const copy = await db.store.findUniqueOrThrow({ where: { id: copyId! }, select: { theme: true, checkoutLayout: true } });
    const rows = await db.storeMedia.findMany({ where: { storeId: copyId! }, select: { id: true, bytes: true } });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => Buffer.from(r.bytes).equals(PNG))).toBe(true);
    const ids = new Set(rows.map((r) => r.id));
    const theme = copy.theme as { bannerUrl: string; logoUrl: string };
    const banner = media.mediaIdOf(theme.bannerUrl)!;
    const image = media.mediaIdOf((copy.checkoutLayout as { blocks: { props: { url: string } }[] }).blocks[0].props.url)!;
    expect(ids.has(banner) && ids.has(image)).toBe(true);
    expect([banner, image]).not.toContain(a.media.id);
    expect([banner, image]).not.toContain(b.media.id);
    expect(theme.logoUrl).toBe("https://cdn.example.com/logo.png");
    // Deleting the original's images leaves the copy intact.
    await db.storeMedia.deleteMany({ where: { storeId: s.id } });
    expect((await pub.GET(new Request("http://x"), { params: Promise.resolve({ mediaId: banner }) })).status).toBe(200);
  });

  it("refuses fake images, SVG and oversize files, and stores nothing", async () => {
    const s = await store();
    expect((await post(s.id, Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"), "image/svg+xml", "x.svg")).status).toBe(415);
    expect((await post(s.id, Buffer.from("<html>not an image</html>"), "image/png")).status).toBe(415);
    expect((await post(s.id, Buffer.concat([PNG, Buffer.alloc(media.MAX_MEDIA_BYTES)]), "image/png")).status).toBe(413);
    expect(await db.storeMedia.count({ where: { storeId: s.id } })).toBe(0);
  });

  it("caps a store at 50 images", async () => {
    const s = await store();
    await db.storeMedia.createMany({
      data: Array.from({ length: media.MAX_MEDIA_PER_STORE }, () => ({ storeId: s.id, mime: "image/png", bytes: new Uint8Array(PNG), size: PNG.length })),
    });
    const res = await post(s.id, PNG, "image/png");
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("media_count");
    expect(await db.storeMedia.count({ where: { storeId: s.id } })).toBe(media.MAX_MEDIA_PER_STORE);
  });

  it("deletes a store's images with the store", async () => {
    const s = await store();
    const saved = await media.saveMedia(s.id, PNG, "image/png");
    expect(saved.ok).toBe(true);
    await db.store.delete({ where: { id: s.id } });
    expect(await db.storeMedia.count({ where: { storeId: s.id } })).toBe(0);
  });
});
