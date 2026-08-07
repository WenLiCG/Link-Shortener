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

  it("corrects the historical visitor backfill at the CST midnight boundary", async () => {
    await env.DB.prepare(
      "INSERT INTO target_services (id, name, target_host) VALUES ('migration-target', 'Migration target', 'migration-target.example')",
    ).run();
    await env.DB.prepare(
      "INSERT INTO redirect_domains (id, domain, target_service_id) VALUES ('migration-domain', 'migration.example', 'migration-target')",
    ).run();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO visit_events (id, redirect_domain_id, host, path, target_host, visitor_key, visited_at)
         VALUES ('migration-before', 'migration-domain', 'migration.example', '/', 'migration-target.example', 'before-midnight', '2026-07-31T15:59:59.000Z')`,
      ),
      env.DB.prepare(
        `INSERT INTO visit_events (id, redirect_domain_id, host, path, target_host, visitor_key, visited_at)
         VALUES ('migration-after', 'migration-domain', 'migration.example', '/', 'migration-target.example', 'after-midnight', '2026-07-31T16:00:00.000Z')`,
      ),
      env.DB.prepare(
        `INSERT INTO traffic_daily_visitors (subject_type, subject_id, day, visitor_key, first_seen_at)
         VALUES ('redirect_domain', 'migration-domain', '2026-07-31', 'before-midnight', '2026-07-31T15:59:59.000Z')`,
      ),
      env.DB.prepare(
        `INSERT INTO traffic_daily_visitors (subject_type, subject_id, day, visitor_key, first_seen_at)
         VALUES ('redirect_domain', 'migration-domain', '2026-07-31', 'after-midnight', '2026-07-31T16:00:00.000Z')`,
      ),
      env.DB.prepare(
        `INSERT INTO traffic_daily_visitors (subject_type, subject_id, day, visitor_key, first_seen_at)
         VALUES ('short_link', 'current-only', '2026-08-02', 'preserve-me', '2026-08-02T00:00:00.000Z')`,
      ),
    ]);

    const migration = testEnv.TEST_MIGRATIONS.find((entry) => entry.name.startsWith("0021_"));
    expect(migration).toBeTruthy();
    for (const query of migration!.queries) {
      await env.DB.prepare(query).run();
    }

    const rows = await env.DB.prepare(
      "SELECT subject_type, day, visitor_key FROM traffic_daily_visitors WHERE subject_id IN ('migration-domain', 'current-only') ORDER BY subject_type, day, visitor_key",
    ).all<{ subject_type: string; day: string; visitor_key: string }>();
    expect(rows.results).toEqual([
      { subject_type: "redirect_domain", day: "2026-07-31", visitor_key: "before-midnight" },
      { subject_type: "redirect_domain", day: "2026-08-01", visitor_key: "after-midnight" },
      { subject_type: "short_link", day: "2026-08-02", visitor_key: "preserve-me" },
    ]);
  });

  it("indexes the visitor day used by cleanup", async () => {
    const columns = await env.DB.prepare("PRAGMA index_info('idx_traffic_visitors_day')").all<{ name: string }>();
    expect(columns.results.map((column) => column.name)).toEqual(["day"]);
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
