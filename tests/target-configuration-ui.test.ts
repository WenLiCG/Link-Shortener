import { describe, expect, it } from "vitest";
import { initialConfigurationResult } from "../src/app/src/target-configuration";

function target(overrides: Record<string, unknown> = {}) {
  return {
    targetHost: "s.g60.net",
    cloudflareZoneName: "g60.net",
    cloudflareZoneStatus: "active",
    cloudflareNameservers: ["agustin.ns.cloudflare.com", "linda.ns.cloudflare.com"],
    nameserverStatus: "active",
    dnsStatus: "configured",
    ...overrides,
  };
}

describe("target configuration UI state", () => {
  it("keeps an unverified Worker Route unknown even when DNS is configured", () => {
    expect(initialConfigurationResult(target(), "route")).toMatchObject({ status: "unknown" });
  });

  it("shows an active inherited Nameserver as passed", () => {
    expect(initialConfigurationResult(target(), "nameserver")).toMatchObject({
      status: "passed",
      summary: "继承 g60.net 的已激活 Nameserver，无需为子域名单独设置。",
    });
  });
});
