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

async function recordVisit(id: string, day: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO traffic_daily_visitors
     (subject_type, subject_id, day, visitor_key, first_seen_at)
     VALUES ('redirect_domain', ?, ?, ?, ?)`,
  ).bind(id, day, `${id}-${day}`, `${day}T00:00:00.000Z`).run();
}

async function expectDomains(filters: { days?: number; visitedFrom?: string; visitedTo?: string }, expected: string[]): Promise<void> {
  expect((await listDomains(env.DB, filters)).map((domain) => domain.id).sort()).toEqual(expected.sort());
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM traffic_daily_visitors").run();
  await env.DB.prepare("DELETE FROM redirect_domains").run();
});

describe("domain list date filters", () => {
  it("filters domains by their visitor days instead of their creation dates", async () => {
    await Promise.all(["today", "yesterday", "week", "old", "thirtyDays", "thirtyOneDays", "future"].map((id) => insertDomain(id, daysAgo(100))));
    await recordVisit("today", today());
    await recordVisit("yesterday", daysAgo(1));
    await recordVisit("week", daysAgo(6));
    await recordVisit("old", daysAgo(7));
    await recordVisit("thirtyDays", daysAgo(29));
    await recordVisit("thirtyOneDays", daysAgo(30));
    await recordVisit("future", daysAgo(-1));

    await expectDomains({ days: 0 }, ["today"]);
    await expectDomains({ days: -1 }, ["yesterday"]);
    await expectDomains({ days: 7 }, ["today", "yesterday", "week"]);
    await expectDomains({ days: 30 }, ["today", "yesterday", "week", "old", "thirtyDays"]);
  });

  it("filters domains within an inclusive visitor date range", async () => {
    await Promise.all(["before", "first", "last", "after"].map((id) => insertDomain(id, "2026-01-01T00:00:00.000Z")));
    await recordVisit("before", "2026-08-09");
    await recordVisit("first", "2026-08-10");
    await recordVisit("last", "2026-08-11");
    await recordVisit("after", "2026-08-12");

    await expectDomains({ visitedFrom: "2026-08-10", visitedTo: "2026-08-11" }, ["first", "last"]);
  });

  it("uses one visitor interval for membership and traffic totals", async () => {
    await insertDomain("spanning", "2026-01-01T00:00:00.000Z");
    await insertDomain("inside", "2026-01-01T00:00:00.000Z");
    await recordVisit("spanning", "2026-08-09");
    await recordVisit("spanning", "2026-08-12");
    await recordVisit("inside", "2026-08-09");
    await recordVisit("inside", "2026-08-10");
    await recordVisit("inside", "2026-08-11");
    await recordVisit("inside", "2026-08-12");

    const domains = await listDomains(env.DB, { visitedFrom: "2026-08-10", visitedTo: "2026-08-11" });

    expect(domains.map((domain) => domain.id)).toEqual(["inside"]);
    expect(domains[0]?.traffic).toBe(2);
    expect(domains[0]?.lastAccessedAt).toBe("2026-08-11T00:00:00.000Z");
  });
});
