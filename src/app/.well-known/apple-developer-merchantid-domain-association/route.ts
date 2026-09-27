import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

const APPLE_PAY_SETTING = "apple_pay_domain_association";

/** Apple fetches this file to verify the checkout domain for Apple Pay (content provided by Whop). */
export async function GET() {
  const setting = await db.appSetting.findUnique({ where: { key: APPLE_PAY_SETTING } });
  if (!setting) return new Response("Not found", { status: 404 });
  return new Response(setting.value, {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=300" },
  });
}
