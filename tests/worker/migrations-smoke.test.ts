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
    const legacy = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('traffic_daily_stats', 'visit_daily_stats', 'visit_events')",
    ).all();
    expect(legacy.results).toEqual([]);
  });

  it("corrects the historical visitor backfill at the CST midnight boundary", async () => {
    // Recreate the historical source removed by 0022 so the backfill remains covered.
    const createEvents = testEnv.TEST_MIGRATIONS[0].queries.find((query) => query.includes("CREATE TABLE IF NOT EXISTS visit_events"));
    expect(createEvents).toBeTruthy();
    await env.DB.prepare(createEvents!).run();
    for (const prefix of ["0013_", "0015_"]) {
      const queries = testEnv.TEST_MIGRATIONS.find((entry) => entry.name.startsWith(prefix))!.queries;
      for (const query of queries.filter((sql) => sql.startsWith("ALTER TABLE visit_events"))) {
        await env.DB.prepare(query).run();
      }
    }
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
    await env.DB.prepare(
      "INSERT INTO visit_daily_uniques (redirect_domain_id, day, visitor_key) VALUES ('migration-domain', '2026-07-01', 'archived')",
    ).run();
    await env.DB.prepare(
      "INSERT INTO short_links (id, target_service_id, code, original_url) VALUES ('archive-link', 'migration-target', 'archive', 'https://example.com/')",
    ).run();
    await env.DB.prepare(
      "INSERT INTO short_link_daily_uniques (short_link_id, day, visitor_key) VALUES ('archive-link', '2026-07-01', 'archived')",
    ).run();
    for (const query of testEnv.TEST_MIGRATIONS.find((entry) => entry.name.startsWith("0022_"))!.queries) {
      await env.DB.prepare(query).run();
    }
    const preserved = await env.DB.prepare(
      "SELECT COUNT(*) AS total FROM traffic_daily_visitors WHERE subject_id IN ('migration-domain', 'current-only')",
    ).first("total");
    expect(preserved).toBe(3);
    expect(await env.DB.prepare("SELECT visitor_key FROM visit_daily_uniques WHERE redirect_domain_id = 'migration-domain'").first("visitor_key")).toBe("archived");
    expect(await env.DB.prepare("SELECT visitor_key FROM short_link_daily_uniques WHERE short_link_id = 'archive-link'").first("visitor_key")).toBe("archived");
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
