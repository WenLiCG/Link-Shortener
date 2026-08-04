import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { listShortLinks } from "../../src/worker/db";

async function eventually(query: string, expected: number): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const value = Number(await env.DB.prepare(query).first("total"));
    if (value === expected) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(Number(await env.DB.prepare(query).first("total"))).toBe(expected);
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM traffic_daily_visitors").run();
  await env.DB.prepare("DELETE FROM traffic_daily_stats").run();
  await env.DB.prepare("DELETE FROM visit_daily_stats").run();
  await env.DB.prepare("DELETE FROM visit_events").run();
  await env.DB.prepare("DELETE FROM short_link_daily_uniques").run();
  await env.DB.prepare("DELETE FROM short_links").run();
  await env.DB.prepare("DELETE FROM redirect_domains").run();
  await env.DB.prepare("DELETE FROM target_services").run();
});

describe("redirect traffic writes", () => {
  it("returns a short-link redirect while recording its daily unique asynchronously", async () => {
    await env.DB.prepare(
      "INSERT INTO target_services (id, name, target_host) VALUES ('target-short', 'short', 'short.example.com')",
    ).run();
    await env.DB.prepare(
      `INSERT INTO short_links (id, target_service_id, code, original_url)
       VALUES ('short-1', 'target-short', 'abc', 'https://destination.example/path')`,
    ).run();

    const response = await SELF.fetch("https://short.example.com/abc", {
      redirect: "manual",
      headers: {
        accept: "text/html",
        "cf-connecting-ip": "192.0.2.40",
        "sec-fetch-dest": "document",
        "sec-fetch-mode": "navigate",
        "user-agent": "Mozilla/5.0",
      },
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://destination.example/path");
    await eventually("SELECT COUNT(*) AS total FROM traffic_daily_visitors WHERE subject_id = 'short-1'", 1);
    expect(Number(await env.DB.prepare("SELECT visit_count AS total FROM short_links WHERE id = 'short-1'").first("total"))).toBe(0);
    expect((await listShortLinks(env.DB)).find((link) => link.id === "short-1")?.visitCount).toBe(1);
  });

  it("records a page navigation but ignores an asset request", async () => {
    await env.DB.prepare(
      `INSERT INTO redirect_domains
       (id, domain, redirect_mode, direct_target_host, status, list_visible)
       VALUES ('domain-visit', 'entry.example.com', 'direct', 'https://destination.example/', 'active', 1)`,
    ).run();
    const headers = {
      accept: "text/html",
      "cf-connecting-ip": "192.0.2.41",
      "sec-fetch-dest": "document",
      "sec-fetch-mode": "navigate",
      "user-agent": "Mozilla/5.0",
    };

    expect((await SELF.fetch("https://entry.example.com/", { redirect: "manual", headers })).status).toBe(302);
    expect((await SELF.fetch("https://entry.example.com/another-page", { redirect: "manual", headers })).status).toBe(302);
    expect((await SELF.fetch("https://entry.example.com/app.js", {
      redirect: "manual",
      headers: { ...headers, "sec-fetch-dest": "script", "sec-fetch-mode": "no-cors" },
    })).status).toBe(302);

    await eventually("SELECT COUNT(*) AS total FROM traffic_daily_visitors WHERE subject_id = 'domain-visit'", 1);
    expect(Number(await env.DB.prepare("SELECT COUNT(*) AS total FROM visit_events WHERE redirect_domain_id = 'domain-visit'").first("total"))).toBe(0);
    expect(Number(await env.DB.prepare("SELECT COUNT(*) AS total FROM traffic_daily_stats WHERE subject_id = 'domain-visit'").first("total"))).toBe(0);
    expect(Number(await env.DB.prepare("SELECT COUNT(*) AS total FROM visit_daily_stats WHERE redirect_domain_id = 'domain-visit'").first("total"))).toBe(0);
  });
});
