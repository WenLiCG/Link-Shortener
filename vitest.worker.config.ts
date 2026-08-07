import path from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(path.join(root, "migrations")),
          ADMIN_HOST: "admin.example.com",
          SESSION_SECRET: "test-session-secret",
          PASSWORD_PEPPER: "test-password-pepper",
          CLOUDFLARE_ACCOUNT_ID: "test-account",
          CLOUDFLARE_API_TOKEN: "test-cloudflare-token",
          VISITOR_HASH_SECRET: "0123456789abcdef0123456789abcdef",
          VERIFICATION_SIGNING_SECRET: "test-verification-secret",
          TURNSTILE_SITE_KEY: "1x00000000000000000000BB",
          TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
          SETTINGS_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
        },
      },
    })),
  ],
  test: {
    include: ["tests/worker/**/*.test.ts"],
    setupFiles: ["./tests/worker/apply-migrations.ts"],
  },
});
