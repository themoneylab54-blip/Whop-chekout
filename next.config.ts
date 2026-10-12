import type { NextConfig } from "next";

// Pages must never be framed by another site (clickjacking on the pay button or the dashboard).
const noFraming = [
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
];

const nextConfig: NextConfig = {
  experimental: {
    // The builder saves whole layouts through a server action (saveBuilderAction): up to 300
    // reviews of 5 000 characters per reviews block, duplicated blocks, translations… go well past
    // the 1 MB default. Below the proxy's 10 MB body limit (proxyClientMaxBodySize).
    serverActions: { bodySizeLimit: "8mb" },
  },
  async headers() {
    return [
      {
        // The storefront loader is fetched cross-origin from every connected shop.
        source: "/loader.js",
        headers: [
          { key: "Access-Control-Allow-Origin", value: "*" },
          { key: "Cache-Control", value: "public, max-age=300" },
        ],
      },
      {
        // Self-hosted theme fonts: Stripe's iframes (js.stripe.com) load them cross-origin (Elements `fonts.cssSrc`).
        source: "/fonts/:path*",
        headers: [{ key: "Access-Control-Allow-Origin", value: "*" }],
      },
      {
        // Whop's script, vendored: its name changes with its version, so it is cached for good (that
        // file only: its license next to it keeps its name).
        source: "/vendor/:file(whop-checkout-\\d+\\.\\d+\\.\\d+\\.js)",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
      },
      { source: "/c/:path*", headers: noFraming },
      { source: "/dashboard/:path*", headers: noFraming },
      { source: "/login", headers: noFraming },
      { source: "/setup", headers: noFraming },
      { source: "/invite/:path*", headers: noFraming },
    ];
  },
};

export default nextConfig;
