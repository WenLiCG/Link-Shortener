import { env } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const testEnv = env as Env & { TEST_MIGRATIONS: D1Migration[] };

describe("D1 migrations", () => {
  it("creates the current schema", async () => {
    const row = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'redirect_domains'",
    ).first<{ name: string }>();
    expect(row?.name).toBe("redirect_domains");
    const traffic = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'traffic_daily_visitors'",
    ).first<{ name: string }>();
    expect(traffic?.name).toBe("traffic_daily_visitors");
  });

  it("removes only stored provider credentials", async () => {
    const values = {
      ADMIN_PASSWORD_HASH: "keep-password",
      DYNADOT_SANDBOX: "true",
      CUSTOM_SETTING: "keep-custom",
      CLOUDFLARE_ACCOUNT_ID: "remove-account",
      CLOUDFLARE_API_TOKEN: "remove-token",
      DYNADOT_API_KEY: "remove-key",
    };
    for (const [key, value] of Object.entries(values)) {
      await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").bind(key, value).run();
    }

    const migration = testEnv.TEST_MIGRATIONS.find((entry) => entry.name.startsWith("0017_"));
    expect(migration).toBeTruthy();
    for (const query of migration!.queries) {
      await env.DB.prepare(query).run();
    }

    const rows = await env.DB.prepare("SELECT key FROM settings ORDER BY key").all<{ key: string }>();
    expect(rows.results.map((row) => row.key)).toEqual([
      "ADMIN_PASSWORD_HASH",
      "CUSTOM_SETTING",
      "DYNADOT_SANDBOX",
    ]);
  });
});
