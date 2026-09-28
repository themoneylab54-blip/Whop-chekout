import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Whop Checkout", template: "%s · Whop Checkout" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // Checkout pages switch `lang` to the buyer's language before hydration (src/app/c/lang.tsx).
    <html lang="fr" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
