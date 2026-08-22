import { describe, expect, it } from "vitest";
import { shouldRecordPageView, visitorKeyFromRequest } from "../src/worker/redirect";
import { today } from "../src/worker/shared";

function request(path: string, headers: Record<string, string> = {}, method = "GET"): Request {
  return new Request(`https://example.com${path}`, { method, headers });
}

describe("redirect visit accounting", () => {
  it("counts top-level document navigations", () => {
    expect(shouldRecordPageView(request("/", {
      accept: "text/html,application/xhtml+xml",
      "sec-fetch-dest": "document",
      "sec-fetch-mode": "navigate",
      "user-agent": "Mozilla/5.0",
    }))).toBe(true);
  });

  it("skips browser resource requests", () => {
    expect(shouldRecordPageView(request("/favicon.ico", { accept: "image/avif,image/webp,*/*" }))).toBe(false);
    expect(shouldRecordPageView(request("/assets/app.js", { accept: "*/*", "sec-fetch-mode": "no-cors" }))).toBe(false);
    expect(shouldRecordPageView(request("/image.png", { accept: "image/png", "sec-fetch-dest": "image" }))).toBe(false);
  });

  it("skips prefetches and non-GET requests", () => {
    expect(shouldRecordPageView(request("/", { purpose: "prefetch" }))).toBe(false);
    expect(shouldRecordPageView(request("/", { accept: "text/html" }, "POST"))).toBe(false);
    expect(shouldRecordPageView(request("/", { accept: "text/html" }, "HEAD"))).toBe(false);
  });

  it("skips bots and preview fetches", () => {
    expect(shouldRecordPageView(request("/", { "user-agent": "Googlebot/2.1", accept: "text/html" }))).toBe(false);
    expect(shouldRecordPageView(request("/", { "user-agent": "facebookexternalhit/1.1", accept: "text/html" }))).toBe(false);
  });

  it("skips requests without a user agent", () => {
    expect(shouldRecordPageView(request("/", {
      accept: "text/html",
      "sec-fetch-dest": "document",
      "sec-fetch-mode": "navigate",
    }))).toBe(false);
  });

  it("skips command-line clients", () => {
    expect(shouldRecordPageView(request("/", { "user-agent": "curl/8.0", accept: "text/html" }))).toBe(false);
  });

  it("builds a daily, subject-scoped anonymous visitor key from Cloudflare IP headers", async () => {
    const env = { VISITOR_HASH_SECRET: "test-visitor-secret" } as Env;
    const headers = {
      "cf-connecting-ip": "203.0.113.10",
      "cf-connecting-ipv6": "2001:db8:1::1",
      "user-agent": "Mozilla/5.0",
      "accept-language": "zh-CN,zh;q=0.9",
    };
    const first = await visitorKeyFromRequest(request("/", headers), env, "example.com");
    const second = await visitorKeyFromRequest(request("/other", headers), env, "example.com");
    const otherSubject = await visitorKeyFromRequest(request("/", headers), env, "other.example.com");

    expect(first).toBe(second);
    expect(first).toHaveLength(64);
    expect(first).not.toContain("2001:db8:1::1");
    expect(first).not.toBe(otherSubject);
  });

  it("does not count requests without a trusted Cloudflare IP", async () => {
    const env = { VISITOR_HASH_SECRET: "test-visitor-secret" } as Env;

    await expect(visitorKeyFromRequest(request("/", { "x-forwarded-for": "203.0.113.10" }), env, "example.com"))
      .resolves.toBeNull();
  });

  it("uses Shanghai calendar days for daily visitor accounting", () => {
    expect(today(new Date("2026-07-31T18:00:00.000Z"))).toBe("2026-08-01");
  });
});
