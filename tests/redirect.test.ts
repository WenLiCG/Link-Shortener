import { describe, expect, it } from "vitest";
import { shouldRecordPageView, visitorKeyFromRequest } from "../src/worker/redirect";

function request(path: string, headers: Record<string, string> = {}, method = "GET"): Request {
  return new Request(`https://example.com${path}`, { method, headers });
}

describe("redirect visit accounting", () => {
  it("counts top-level document navigations", () => {
    expect(shouldRecordPageView(request("/", {
      accept: "text/html,application/xhtml+xml",
      "sec-fetch-dest": "document",
      "sec-fetch-mode": "navigate",
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
  });

  it("skips bots and preview fetches", () => {
    expect(shouldRecordPageView(request("/", { "user-agent": "Googlebot/2.1", accept: "text/html" }))).toBe(false);
    expect(shouldRecordPageView(request("/", { "user-agent": "facebookexternalhit/1.1", accept: "text/html" }))).toBe(false);
  });

  it("builds a stable anonymous visitor key from the client IP", async () => {
    const env = { SESSION_SECRET: "test-secret" } as Env;
    const headers = {
      "cf-connecting-ip": "203.0.113.10",
      "user-agent": "Mozilla/5.0",
      "accept-language": "zh-CN,zh;q=0.9",
    };
    const first = await visitorKeyFromRequest(request("/", headers), env, "example.com");
    const second = await visitorKeyFromRequest(request("/other", headers), env, "example.com");

    expect(first).toBe(second);
    expect(first).toHaveLength(64);
    expect(first).not.toContain("203.0.113.10");
  });
});
