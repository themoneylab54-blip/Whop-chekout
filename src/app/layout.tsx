import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Whop Checkout", template: "%s · Whop Checkout" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr">
      <body>{children}</body>
    </html>
  );
}
