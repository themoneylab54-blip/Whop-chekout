import type { ReactNode } from "react";
import { CreditCard, Paintbrush, ShieldCheck, ShoppingBag, Zap } from "lucide-react";

const POINTS = [
  { icon: Zap, title: "Checkout en une page", text: "Apple Pay, Google Pay, PayPal et carte, sans friction." },
  { icon: CreditCard, title: "Encaissé sur ton Whop", text: "Tes fonds, ton compte, payouts rapides." },
  { icon: Paintbrush, title: "Design sans code", text: "30+ blocs de conversion, aperçu en direct." },
  { icon: ShieldCheck, title: "Commandes dans Shopify", text: "Créées automatiquement, stock à jour." },
];

/** Split-screen shell for login / setup / onboarding screens. */
export function AuthShell({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children: ReactNode }) {
  return (
    <main className="grid min-h-full lg:grid-cols-[1.05fr_1fr]">
      <section className="bg-mesh relative hidden overflow-hidden p-12 text-white lg:flex lg:flex-col lg:justify-between">
        <div className="bg-grid absolute inset-0 opacity-60 [mask-image:radial-gradient(70%_60%_at_40%_40%,black,transparent)]" />
        <div className="relative flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-white/15 ring-1 ring-white/25 backdrop-blur">
            <ShoppingBag className="h-4.5 w-4.5" />
          </span>
          <span className="text-lg font-semibold tracking-tight">Whop Checkout</span>
        </div>
        <div className="relative max-w-md">
          <h2 className="text-[40px] leading-[1.05] font-semibold tracking-[-0.03em]">
            Le checkout qui transforme tes visiteurs en clients.
          </h2>
          <ul className="mt-10 space-y-5">
            {POINTS.map((p) => (
              <li key={p.title} className="flex gap-3.5">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/12 ring-1 ring-white/20 backdrop-blur-sm">
                  <p.icon className="h-5 w-5" />
                </span>
                <span>
                  <span className="block font-medium">{p.title}</span>
                  <span className="block text-sm text-white/65">{p.text}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
        <p className="relative text-xs text-white/50">Paiements traités par Whop · Commandes synchronisées avec Shopify</p>
      </section>

      <section className="flex items-center justify-center bg-white px-6 py-12">
        <div className="animate-fade-up w-full max-w-[380px]">
          <div className="mb-8 flex items-center gap-2.5 lg:hidden">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-fuchsia-500 text-white">
              <ShoppingBag className="h-4.5 w-4.5" />
            </span>
            <span className="text-lg font-semibold tracking-tight">Whop Checkout</span>
          </div>
          <h1 className="text-[26px] font-semibold tracking-[-0.02em]">{title}</h1>
          {subtitle && <p className="mt-1.5 text-sm text-zinc-500">{subtitle}</p>}
          <div className="mt-7">{children}</div>
        </div>
      </section>
    </main>
  );
}
