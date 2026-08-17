import { afterEach, describe, expect, it, vi } from "vitest";
import { findAddressRecordsForHost, findBestZoneForHost, findWorkerRouteForHost, ensureWorkerDnsRecordForHost, ensureWorkerRouteForHost } from "../src/worker/cloudflare";
import { getTargetById, updateTargetAutomation } from "../src/worker/db";
import { isDomainInDynadot, setNameservers } from "../src/worker/dynadot";
import { checkTargetConfigurationItem, configureTargetConfigurationItem } from "../src/worker/target-configuration";

vi.mock("../src/worker/cloudflare", () => ({
  ensureWorkerDnsRecordForHost: vi.fn(),
  ensureWorkerRouteForHost: vi.fn(),
  findAddressRecordsForHost: vi.fn(),
  findBestZoneForHost: vi.fn(),
  findWorkerRouteForHost: vi.fn(),
}));

vi.mock("../src/worker/db", () => ({
  getTargetById: vi.fn(),
  updateTargetAutomation: vi.fn(),
}));

vi.mock("../src/worker/dynadot", () => ({
  isDomainInDynadot: vi.fn(),
  setNameservers: vi.fn(),
}));

const env = { WORKER_SCRIPT_NAME: "multi-domain-redirect-manager" } as Env;

function target(overrides: Record<string, unknown> = {}) {
  return {
    id: "target-1",
    targetHost: "s.g60.net",
    cloudflareZoneId: "zone-1",
    cloudflareZoneName: "g60.net",
    cloudflareZoneStatus: "active",
    cloudflareNameservers: ["agustin.ns.cloudflare.com", "linda.ns.cloudflare.com"],
    nameserverStatus: "active",
    dnsStatus: "configured",
    dynadotStatus: "inherited_zone",
    ...overrides,
  } as NonNullable<Awaited<ReturnType<typeof getTargetById>>>;
}

function zone(overrides: Record<string, unknown> = {}) {
  return {
    id: "zone-1",
    name: "g60.net",
    status: "active",
    nameServers: ["agustin.ns.cloudflare.com", "linda.ns.cloudflare.com"],
    ...overrides,
  };
}

describe("target configuration", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("confirms an inherited subdomain Nameserver without changing registrar NS", async () => {
    vi.mocked(getTargetById).mockResolvedValue(target());
    vi.mocked(findBestZoneForHost).mockResolvedValue(zone());

    await expect(checkTargetConfigurationItem(env, "target-1", "nameserver")).resolves.toMatchObject({
      status: "passed",
      summary: "继承 g60.net 的已激活 Nameserver，无需为子域名单独设置。",
    });
    expect(setNameservers).not.toHaveBeenCalled();
  });

  it("reports conflicting DNS records as failed", async () => {
    vi.mocked(getTargetById).mockResolvedValue(target());
    vi.mocked(findBestZoneForHost).mockResolvedValue(zone());
    vi.mocked(findAddressRecordsForHost).mockResolvedValue([
      { id: "old", type: "CNAME", name: "s.g60.net", content: "old.example.com", proxied: true },
    ]);

    await expect(checkTargetConfigurationItem(env, "target-1", "dns")).resolves.toMatchObject({
      status: "failed",
      summary: "DNS 记录未由当前 Worker 接管。",
    });
  });

  it("confirms only an exact Worker Route bound to the configured script", async () => {
    vi.mocked(getTargetById).mockResolvedValue(target());
    vi.mocked(findBestZoneForHost).mockResolvedValue(zone());
    vi.mocked(findWorkerRouteForHost).mockResolvedValue({
      id: "route-1",
      pattern: "s.g60.net/*",
      script: "multi-domain-redirect-manager",
    });

    await expect(checkTargetConfigurationItem(env, "target-1", "route")).resolves.toMatchObject({ status: "passed" });
  });

  it("repairs only the requested DNS item", async () => {
    vi.mocked(getTargetById).mockResolvedValue(target());
    vi.mocked(findBestZoneForHost).mockResolvedValue(zone());
    vi.mocked(findAddressRecordsForHost).mockResolvedValue([]);
    vi.mocked(ensureWorkerDnsRecordForHost).mockResolvedValue();
    vi.mocked(ensureWorkerRouteForHost).mockResolvedValue();
    vi.mocked(isDomainInDynadot).mockResolvedValue(false);
    vi.mocked(updateTargetAutomation).mockResolvedValue();

    await expect(configureTargetConfigurationItem(env, "target-1", "dns")).resolves.toMatchObject({ item: "dns" });
    expect(ensureWorkerDnsRecordForHost).toHaveBeenCalledWith(env, "zone-1", "s.g60.net");
    expect(ensureWorkerRouteForHost).not.toHaveBeenCalled();
    expect(setNameservers).not.toHaveBeenCalled();
  });
});
