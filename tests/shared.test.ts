import { describe, expect, it } from "vitest";
import { buildTargetUrl, domainMatchesHost, isValidDomain, normalizeDomain } from "../src/worker/shared";

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
});
