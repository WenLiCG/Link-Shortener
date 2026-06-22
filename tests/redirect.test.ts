import { describe, expect, it } from "vitest";
import { shouldRecordPageView } from "../src/worker/redirect";

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
});
