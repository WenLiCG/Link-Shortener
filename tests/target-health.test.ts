import { afterEach, describe, expect, it, vi } from "vitest";
import { getTargetById, markTargetHealthChecking, updateTargetHealth } from "../src/worker/db";
import { checkTargetHealth, refreshTargetHealth } from "../src/worker/target-health";

vi.mock("../src/worker/db", () => ({
  getTargetById: vi.fn(),
  listStaleTargetIds: vi.fn(),
  markTargetHealthChecking: vi.fn(),
  updateTargetHealth: vi.fn(),
}));

vi.mock("../src/worker/target-configuration", () => ({
  checkTargetConfiguration: vi.fn().mockResolvedValue([
    { item: "zone", status: "passed", summary: "Zone 已通过。", manualSteps: [], details: {} },
    { item: "nameserver", status: "passed", summary: "Nameserver 已通过。", manualSteps: [], details: {} },
    { item: "dns", status: "passed", summary: "DNS 已通过。", manualSteps: [], details: {} },
    { item: "route", status: "passed", summary: "Route 已通过。", manualSteps: [], details: {} },
  ]),
}));

describe("target health", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("marks successful http responses as ok", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    await expect(checkTargetHealth("example.com")).resolves.toMatchObject({
      status: "ok",
      httpStatus: 204,
      error: null,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/",
      expect.objectContaining({ method: "HEAD", redirect: "manual" }),
    );
  });

  it("marks network errors as failed without leaking request details", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("fetch failed for https://secret.example/path"));
    await expect(checkTargetHealth("bad.example.com")).resolves.toMatchObject({
      status: "failed",
      httpStatus: null,
      error: "health_check_failed",
    });
  });

  it("requires the managed HEAD response to be 204", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 302 }));

    await expect(checkTargetHealth("example.com")).resolves.toMatchObject({
      status: "failed",
      httpStatus: 302,
      error: "HTTP 302",
    });
  });

  it("falls back to GET only when HEAD is unsupported and requires 200", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 405 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    await expect(checkTargetHealth("example.com")).resolves.toMatchObject({
      status: "ok",
      httpStatus: 200,
      error: null,
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://example.com/",
      expect.objectContaining({ method: "GET", redirect: "manual" }),
    );
  });

  it("uses the four live configuration checks instead of an unsupported same-zone fetch", async () => {
    vi.mocked(getTargetById).mockResolvedValue({
      id: "target-1",
      targetHost: "example.com",
      dnsStatus: "configured",
      nameserverStatus: "active",
      cloudflareZoneId: "zone-1",
    } as Awaited<ReturnType<typeof getTargetById>>);
    vi.mocked(markTargetHealthChecking).mockResolvedValue();
    vi.mocked(updateTargetHealth).mockResolvedValue();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 530 }));

    const refreshed = await refreshTargetHealth({ DB: {} as D1Database } as Env, "target-1");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(refreshed).toMatchObject({ status: "ok", httpStatus: null, error: null });
    expect(updateTargetHealth).toHaveBeenCalledWith(
      expect.anything(),
      "target-1",
      expect.objectContaining({ status: "ok", httpStatus: null, error: null }),
    );
  });
});
