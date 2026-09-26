import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "server-only": path.resolve(__dirname, "tests/server-only-stub.ts"),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    env: { ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"), APP_URL: "https://checkout.example.com", SESSION_SECRET: "test" },
  },
});
