/**
 * Creates (or resets the password of) the dashboard admin.
 *   npm run admin:create -- you@example.com 'a-strong-password'
 */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

async function main() {
  const [email, password] = process.argv.slice(2);
  if (!email || !password || password.length < 10) {
    console.error("Usage: npm run admin:create -- <email> <password (10+ caractères)>");
    process.exit(1);
  }
  const db = new PrismaClient();
  const passwordHash = await bcrypt.hash(password, 12);
  await db.adminUser.upsert({
    where: { email: email.toLowerCase() },
    update: { passwordHash },
    create: { email: email.toLowerCase(), passwordHash },
  });
  console.log(`Admin ${email} prêt.`);
  await db.$disconnect();
}

main();
