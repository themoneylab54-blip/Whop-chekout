import type { NextConfig } from "next";

// Pages must never be framed by another site (clickjacking on the pay button or the dashboard).
const noFraming = [
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
];

const nextConfig: NextConfig = {
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
      { source: "/c/:path*", headers: noFraming },
      { source: "/dashboard/:path*", headers: noFraming },
      { source: "/login", headers: noFraming },
      { source: "/setup", headers: noFraming },
    ];
  },
};

export default nextConfig;
