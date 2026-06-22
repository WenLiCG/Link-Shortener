import { describe, expect, it } from "vitest";
import { buildTargetUrl, domainMatchesHost, isValidDomain, noRefererHtml, normalizeDomain } from "../src/worker/shared";

describe("domain helpers", () => {
  it("normalizes protocol, wildcard, path and case", () => {
    expect(normalizeDomain("HTTPS://*.Example.COM/a?x=1")).toBe("example.com");
  });

  it("validates root domains", () => {
    expect(isValidDomain("example.com")).toBe(true);
    expect(isValidDomain("sub.example.com")).toBe(true);
    expect(isValidDomain("localhost")).toBe(false);
    expect(isValidDomain("-bad.com")).toBe(false);
  });

  it("matches apex and wildcard subdomains", () => {
    expect(domainMatchesHost("example.com", "example.com")).toBe(true);
    expect(domainMatchesHost("example.com", "www.example.com")).toBe(true);
    expect(domainMatchesHost("example.com", "a.b.example.com")).toBe(true);
    expect(domainMatchesHost("example.com", "notexample.com")).toBe(false);
  });

  it("builds target urls and preserves explicit path and query", () => {
    expect(buildTargetUrl("https://Short.EXAMPLE.com/a?x=1")).toBe("https://short.example.com/a?x=1");
    expect(buildTargetUrl("short.example.com/path")).toBe("https://short.example.com/path");
  });

  it("uses a single scripted no-referrer redirect with noscript fallback", async () => {
    const response = noRefererHtml("https://target.example/path");
    const html = await response.text();
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(html).toContain("window.location.replace");
    expect(html).toContain("<noscript><meta http-equiv=\"refresh\"");
    expect(html).not.toContain("<head><meta charset=\"utf-8\"><meta name=\"referrer\" content=\"no-referrer\"><meta http-equiv=\"refresh\"");
  });
});
