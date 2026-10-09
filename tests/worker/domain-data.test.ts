import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { cleanupVisits, createRedirectDomain, findDomainByHost, getDomainDetail, getTargetById, listTargets, summaryStats } from "../../src/worker/db";
import { daysAgo, today } from "../../src/worker/shared";
import { runScheduled } from "../../src/worker/automation";

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM traffic_daily_visitors").run();
  await env.DB.prepare("DELETE FROM redirect_domains").run();
  await env.DB.prepare("DELETE FROM short_links").run();
  await env.DB.prepare("DELETE FROM target_services").run();
});

describe("domain reads and retained traffic", () => {
  it("counts target references independently across domains and short links", async () => {
    await env.DB.prepare("INSERT INTO target_services (id, name, target_host) VALUES ('used', 'Used', 'used.example'), ('empty', 'Empty', 'empty.example')").run();
    await env.DB.prepare("INSERT INTO redirect_domains (id, domain, target_service_id) VALUES ('a', 'a.example', 'used'), ('b', 'b.example', 'used')").run();
    await env.DB.prepare("INSERT INTO short_links (id, code, target_service_id, original_url) VALUES ('s1', 'a', 'used', 'https://destination.example/'), ('s2', 'b', 'used', 'https://destination.example/'), ('s3', 'c', 'used', 'https://destination.example/')").run();
    const targets = await listTargets(env.DB);
    expect(targets.find((target) => target.id === "used")?.usageCount).toBe(5);
    expect(targets.find((target) => target.id === "empty")?.usageCount).toBe(0);
    expect((await getTargetById(env.DB, "used"))?.usageCount).toBe(5);
    expect(await getTargetById(env.DB, "missing")).toBeNull();
  });

  it("selects the closest active domain and falls back past hidden subdomains", async () => {
    await env.DB.prepare(
      `INSERT INTO redirect_domains (id, domain, status, list_visible)
       VALUES ('root', 'example.com', 'active', 1),
              ('child', 'sub.example.com', 'active', 1),
              ('hidden', 'hidden.sub.example.com', 'active', 0)`,
    ).run();
    expect((await findDomainByHost(env.DB, "WWW.SUB.EXAMPLE.COM"))?.id).toBe("child");
    expect((await findDomainByHost(env.DB, "hidden.sub.example.com"))?.id).toBe("child");
    expect((await findDomainByHost(env.DB, "other.example.com"))?.id).toBe("root");
    expect((await findDomainByHost(env.DB, `${Array(110).fill("a").join(".")}.example.com`))?.id).toBe("root");
    expect(await findDomainByHost(env.DB, "notexample.com")).toBeNull();
    expect(await findDomainByHost(env.DB, "localhost")).toBeNull();
  });

  it("counts hidden waiting and failed domains in the global summary", async () => {
    await env.DB.prepare(
      `INSERT INTO redirect_domains (id, domain, status, list_visible)
       VALUES ('active', 'active.example', 'active', 1),
              ('waiting', 'waiting.example', 'waiting_nameserver', 0),
              ('failed', 'failed.example', 'failed', 0)`,
    ).run();
    expect(await summaryStats(env.DB)).toMatchObject({ totalDomains: 3, activeDomains: 1, waitingDomains: 1, failedDomains: 1 });
  });

  it("creates a basic record and returns only that domain's traffic in its detail", async () => {
    const created = await createRedirectDomain(env.DB, {
      domain: "detail.example", redirectMode: "direct", directTargetHost: "https://destination.example/path",
      targetServiceId: null, targetForwardHost: null, groupId: null, hideReferer: true,
    });
    expect(created.domain.domain).toBe("detail.example");
    expect(created.jobId).toBeTruthy();
    expect(created.domain).not.toHaveProperty("geography");
    for (const [subject, key] of [[created.domain.id, "one"], [created.domain.id, "two"], ["other", "three"]]) {
      await env.DB.prepare(
        `INSERT INTO traffic_daily_visitors (subject_type, subject_id, day, visitor_key, first_seen_at)
         VALUES ('redirect_domain', ?, ?, ?, ?)`,
      ).bind(subject, today(), key, `${today()}T01:00:00.000Z`).run();
    }
    const detail = await getDomainDetail(env.DB, created.domain.id);
    expect(detail?.traffic).toBe(2);
    expect(detail?.recentVisits.map((visit) => visit.id)).toEqual(["1", "2"]);
    expect(detail?.lastAccessedAt).toBe(`${today()}T01:00:00.000Z`);
    expect(await getDomainDetail(env.DB, "missing")).toBeNull();
  });

  it.each([30, 1, 0, -1, 1.5, NaN])("cleans exactly the configured Shanghai calendar days (%s)", async (retention) => {
    for (const offset of [0, 1, 29, 30]) {
      for (const subject of ["redirect_domain", "short_link"]) {
        await env.DB.prepare(
          `INSERT INTO traffic_daily_visitors (subject_type, subject_id, day, visitor_key, first_seen_at)
           VALUES (?, 'retained', ?, 'visitor', ?)`,
        ).bind(subject, daysAgo(offset), `${daysAgo(offset)}T00:00:00.000Z`).run();
      }
    }
    await cleanupVisits(env.DB, retention);
    const rows = await env.DB.prepare("SELECT DISTINCT day FROM traffic_daily_visitors ORDER BY day DESC").all<{ day: string }>();
    const expected = retention === 1 ? [today()] : [today(), daysAgo(1), daysAgo(29)];
    expect(rows.results.map((row) => row.day)).toEqual(expected);
  });

  it("runs scheduled cleanup with an empty queue after legacy tables are removed", async () => {
    await env.DB.prepare("DELETE FROM domain_jobs").run();
    await env.DB.prepare("DELETE FROM target_services").run();
    await env.DB.prepare(
      `INSERT INTO traffic_daily_visitors (subject_type, subject_id, day, visitor_key, first_seen_at)
       VALUES ('redirect_domain', 'expired', ?, 'visitor', ?)`,
    ).bind(daysAgo(31), `${daysAgo(31)}T00:00:00.000Z`).run();
    await runScheduled(env);
    expect(await env.DB.prepare("SELECT COUNT(*) AS total FROM traffic_daily_visitors").first("total")).toBe(0);
  });
});
