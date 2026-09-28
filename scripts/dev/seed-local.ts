/**
 * Local demo data (never run against production): one admin, one connected store in
 * test mode with shipping, a promo code, an order bump, and 60 days of checkouts.
 *   npx tsx scripts/dev/seed-local.ts
 */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { encrypt } from "../../src/lib/crypto";
import { defaultCheckoutLayout, defaultThankYouLayout, defaultTheme } from "../../src/lib/layout";

const db = new PrismaClient();

async function main() {
  const url = new URL(process.env.DATABASE_URL ?? "");
  if (!["localhost", "127.0.0.1"].includes(url.hostname)) throw new Error("Seed refusé : base non locale");
  await db.adminUser.upsert({
    where: { email: "admin@local.test" },
    update: { passwordHash: await bcrypt.hash("local-admin-pass", 12) },
    create: { email: "admin@local.test", passwordHash: await bcrypt.hash("local-admin-pass", 12) },
  });
  const existing = await db.store.findFirst({ where: { shopDomain: "demo-boutique.myshopify.com" } });
  if (existing) await db.store.delete({ where: { id: existing.id } });
  const store = await db.store.create({
    data: {
      name: "Maison Lumière",
      shopDomain: "demo-boutique.myshopify.com",
      shopifyAccessToken: encrypt("shpat_demo"),
      shopCurrency: "EUR",
      scriptTagId: "gid://shopify/ScriptTag/1",
      whopApiKey: encrypt("whop_demo"),
      whopAccountId: "biz_demo",
      whopProductId: "prod_demo",
      whopConnectedAt: new Date(),
      lastWebhookAt: new Date(),
      testMode: true,
      theme: defaultTheme("Maison Lumière"),
      checkoutLayout: defaultCheckoutLayout(),
      thankYouLayout: defaultThankYouLayout(),
      publishedAt: new Date(Date.now() - 5 * 86400_000),
    },
  });
  await db.shippingRate.createMany({
    data: [
      { storeId: store.id, name: "Colissimo", deliveryTime: "2 à 3 jours ouvrés", countries: ["FR", "BE"], priceCents: 490, freeOverCents: 6000, position: 0 },
      { storeId: store.id, name: "Chronopost Express", deliveryTime: "24 h", countries: ["FR"], priceCents: 990, position: 1 },
    ],
  });
  await db.discountCode.create({ data: { storeId: store.id, code: "BIENVENUE10", type: "PERCENT", value: 10 } }).catch(() => undefined);
  await db.addOn.create({ data: { storeId: store.id, title: "Emballage cadeau", priceCents: 390 } }).catch(() => undefined);

  const products = [
    { title: "Bougie Ambre", price: 2900, cost: 900, img: "https://picsum.photos/seed/bougie/200" },
    { title: "Diffuseur Cèdre", price: 3900, cost: 1300, img: "https://picsum.photos/seed/diffuseur/200" },
    { title: "Coffret Découverte", price: 5900, cost: 2100, img: "https://picsum.photos/seed/coffret/200" },
  ];
  const sources = [{ utm_source: "facebook", utm_campaign: "automne" }, { utm_source: "tiktok", utm_campaign: "ugc" }, {}, { utm_source: "google", utm_campaign: "marque" }];
  const methods = ["card", "apple_pay", "paypal", "klarna"];
  let n = 0;
  for (let d = 59; d >= 0; d--) {
    const perDay = 3 + ((d * 7) % 5);
    for (let i = 0; i < perDay; i++) {
      n++;
      const p = products[(d + i) % products.length];
      const qty = 1 + ((d + i) % 3 === 0 ? 1 : 0);
      const createdAt = new Date(Date.now() - d * 86400_000 - i * 3600_000);
      const paid = (d + i) % 3 !== 0;
      const subtotal = p.price * qty;
      const shipping = subtotal >= 6000 ? 0 : 490;
      const email = `client${n % 40}@exemple.fr`;
      await db.checkoutSession.create({
        data: {
          storeId: store.id,
          currency: "EUR",
          test: false,
          createdAt,
          lines: [{ variantId: `gid://shopify/ProductVariant/${100 + products.indexOf(p)}`, productId: `gid://shopify/Product/${10 + products.indexOf(p)}`, productHandle: "p", title: p.title, variantTitle: null, sku: null, imageUrl: p.img, quantity: qty, unitPriceCents: p.price, compareAtCents: Math.round(p.price * 1.25), inventory: null, requiresShipping: true, unitCostCents: p.cost }],
          subtotalCents: subtotal,
          shippingCents: shipping,
          totalCents: subtotal + shipping,
          email: paid || i % 2 ? email : null,
          visitorId: `v${n}`,
          userAgent: i % 2 ? "Mozilla/5.0 (iPhone)" : "Mozilla/5.0 (Macintosh)",
          utm: sources[(d + i) % sources.length],
          preparedAt: paid || i % 2 ? createdAt : null,
          payClickedAt: paid ? createdAt : null,
          ...(paid
            ? {
                status: "PAID",
                paidAt: new Date(createdAt.getTime() + (3 + (i % 9)) * 60_000),
                whopPaymentId: `pay_demo_${n}`,
                whopFeeCents: Math.round((subtotal + shipping) * 0.03),
                paymentMethodType: methods[(d + i) % methods.length],
                shopifyOrderId: `gid://shopify/Order/${5000 + n}`,
                shopifyOrderName: `#${1000 + n}`,
                shippingAddress: { firstName: "Camille", lastName: "Durand", address1: "12 rue des Lilas", city: "Lyon", zip: "69003", countryCode: n % 5 === 0 ? "BE" : "FR" },
                termsAcceptedAt: createdAt,
                ...(n % 17 === 0 ? { refundedCents: subtotal, refundMirroredCents: subtotal } : {}),
              }
            : {}),
        },
      });
    }
  }
  console.log(`Store ${store.id} créé avec ${n} checkouts. Admin : admin@local.test / local-admin-pass`);
}

main().finally(() => db.$disconnect());
