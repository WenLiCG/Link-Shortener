import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { listDomains } from "../../src/worker/db";
import { daysAgo, today } from "../../src/worker/shared";

async function insertDomain(id: string, createdAt: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO redirect_domains
     (id, domain, redirect_mode, direct_target_host, list_visible, created_at)
     VALUES (?, ?, 'direct', 'https://example.com/', 1, ?)`,
  ).bind(id, `${id}.example.com`, createdAt).run();
}

async function expectDomains(filters: { days: number }, expected: string[]): Promise<void> {
  expect((await listDomains(env.DB, filters)).map((domain) => domain.id).sort()).toEqual(expected.sort());
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM redirect_domains").run();
});

describe("domain list date filters", () => {
  it("filters domains by today, yesterday, and seven calendar days", async () => {
    await insertDomain("today", today());
    await insertDomain("yesterday", daysAgo(1));
    await insertDomain("week", daysAgo(6));
    await insertDomain("old", daysAgo(7));
    await insertDomain("thirtyDays", daysAgo(29));
    await insertDomain("thirtyOneDays", daysAgo(30));

    await expectDomains({ days: 0 }, ["today"]);
    await expectDomains({ days: -1 }, ["yesterday"]);
    await expectDomains({ days: 7 }, ["today", "yesterday", "week"]);
    await expectDomains({ days: 30 }, ["today", "yesterday", "week", "old", "thirtyDays"]);
  });
});
