// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { isEditForm, LOCK_ATTR, lockEditForms } from "@/components/dashboard/readOnlyDom";
import { refusalPath } from "@/lib/store-guard";

/*
 * Viewer read-only mode (ReadOnlyScope): the forms that change something get their controls locked,
 * navigation forms (GET filters, search) stay usable; and where a refused action sends the user back.
 */

function mount(html: string): HTMLElement {
  document.body.innerHTML = `<div id="root">${html}</div>`;
  return document.getElementById("root")!;
}

describe("lockEditForms", () => {
  it("locks server-action and POST forms, leaves GET forms and allowed forms alone", () => {
    const root = mount(`
      <form id="action" method="POST" action=""><input type="hidden" name="$ACTION_ID_abc" /><input name="name" value="Boutique" /><input type="checkbox" name="testMode" /><select name="tz"><option>Paris</option></select><textarea name="note"></textarea><button type="submit">Enregistrer</button></form>
      <form id="client" action="javascript:throw new Error('React form')"><input name="q2" /><button>Go</button></form>
      <form id="post" action="/api/stripe/connect/start" method="post"><input type="hidden" name="store" value="s1" /><button type="submit">Se connecter</button></form>
      <form id="filters" action="/dashboard/stores/s1/orders"><input name="q" /><select name="status"><option>PAID</option></select><button>Filtrer</button></form>
      <form id="allowed" method="post" data-readonly-allow><input name="x" /><button>OK</button></form>
    `);
    expect(lockEditForms(root)).toBeGreaterThan(0);
    const $ = <T extends Element>(sel: string) => root.querySelector(sel) as T;
    // Text stays selectable: read-only, not disabled; the rest disabled.
    expect($<HTMLInputElement>("#action [name=name]").readOnly).toBe(true);
    expect($<HTMLInputElement>("#action [name=name]").disabled).toBe(false);
    expect($<HTMLInputElement>("#action [name=testMode]").disabled).toBe(true);
    expect($<HTMLSelectElement>("#action select").disabled).toBe(true);
    expect($<HTMLTextAreaElement>("#action textarea").readOnly).toBe(true);
    expect($<HTMLButtonElement>("#action button").disabled).toBe(true);
    expect($<HTMLButtonElement>("#action button").title).toMatch(/Lecture seule/);
    // The hidden action id is left as is.
    expect($<HTMLInputElement>("#action [type=hidden]").hasAttribute(LOCK_ATTR)).toBe(false);
    expect($<HTMLButtonElement>("#client button").disabled).toBe(true);
    expect($<HTMLButtonElement>("#post button").disabled).toBe(true);
    // Navigation keeps working.
    expect($<HTMLInputElement>("#filters [name=q]").readOnly).toBe(false);
    expect($<HTMLSelectElement>("#filters select").disabled).toBe(false);
    expect($<HTMLButtonElement>("#filters button").disabled).toBe(false);
    expect($<HTMLButtonElement>("#allowed button").disabled).toBe(false);
    // Idempotent.
    expect(lockEditForms(root)).toBe(0);
  });

  it("a re-enabled control is locked again; a server-action button inside a GET form too", () => {
    const root = mount(`
      <form id="a" method="post"><button id="b">Enregistrer</button></form>
      <form id="g"><button id="nav">Voir</button><button id="act" formaction="javascript:throw 1">Relancer</button></form>
    `);
    lockEditForms(root);
    const b = document.getElementById("b") as HTMLButtonElement;
    b.disabled = false; // a React prop change
    expect(lockEditForms(root)).toBe(1);
    expect(b.disabled).toBe(true);
    expect((document.getElementById("nav") as HTMLButtonElement).disabled).toBe(false);
    expect((document.getElementById("act") as HTMLButtonElement).disabled).toBe(true);
  });

  it("isEditForm", () => {
    const root = mount(`<form id="g" method="get"></form><form id="p" method="post"></form><form id="d"></form>`);
    expect(isEditForm(root.querySelector("#g")!)).toBe(false);
    expect(isEditForm(root.querySelector("#d")!)).toBe(false);
    expect(isEditForm(root.querySelector("#p")!)).toBe(true);
  });
});

describe("refusalPath", () => {
  it("the referring page when it is the store's, else its overview", () => {
    expect(refusalPath("s1", "https://app.test/dashboard/stores/s1/offers?tab=a&error=old&field=x")).toBe("/dashboard/stores/s1/offers?tab=a");
    expect(refusalPath("s1", "https://app.test/dashboard/stores/s1")).toBe("/dashboard/stores/s1");
    expect(refusalPath("s1", "https://app.test/dashboard/stores/s2/offers")).toBe("/dashboard/stores/s1");
    expect(refusalPath("s1", "https://app.test/dashboard/stores/s10/offers")).toBe("/dashboard/stores/s1");
    expect(refusalPath("s1", null)).toBe("/dashboard/stores/s1");
    expect(refusalPath("s1", "::not a url")).toBe("/dashboard/stores/s1");
  });
});
