import { describe, expect, it, vi } from "vitest";

vi.mock("../src/worker/db", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/worker/db")>(),
  getTargetById: vi.fn(),
  markTargetHealthChecking: vi.fn(),
}));

vi.mock("../src/worker/auth", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/worker/auth")>(),
  requireSession: vi.fn(),
}));

vi.mock("../src/worker/target-configuration", () => ({
  checkTargetConfigurationItem: vi.fn(),
  configureTargetConfigurationItem: vi.fn(),
}));

vi.mock("../src/worker/target-health", () => ({
  refreshTargetHealth: vi.fn(),
}));

import { handleApi } from "../src/worker/api";
import { requireSession } from "../src/worker/auth";
import { getTargetById } from "../src/worker/db";
import { checkTargetConfigurationItem, configureTargetConfigurationItem } from "../src/worker/target-configuration";
import { refreshTargetHealth } from "../src/worker/target-health";

const env = { DB: {} } as Env;
const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;

describe("target configuration API", () => {
  it("checks only the requested target configuration item", async () => {
    vi.mocked(requireSession).mockResolvedValue();
    vi.mocked(getTargetById).mockResolvedValue({ id: "target-1" } as Awaited<ReturnType<typeof getTargetById>>);
    vi.mocked(checkTargetConfigurationItem).mockResolvedValue({
      item: "dns",
      status: "passed",
      summary: "已确认橙云 A 记录由当前 Worker 接管。",
      manualSteps: ["无需人工操作。"],
      details: {},
    });

    const response = await handleApi(
      new Request("https://admin.example.com/api/targets/target-1/configuration/dns/check", { method: "POST", body: "{}" }),
      env,
      ctx,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, data: { item: "dns", status: "passed" } });
    expect(configureTargetConfigurationItem).not.toHaveBeenCalled();
  });

  it("rejects a configuration item outside the four supported names", async () => {
    vi.mocked(requireSession).mockResolvedValue();
    await expect(handleApi(
      new Request("https://admin.example.com/api/targets/target-1/configuration/unknown/check", { method: "POST", body: "{}" }),
      env,
      ctx,
    )).rejects.toMatchObject({ status: 404 });
  });

  it("waits for all four configuration checks and returns the synchronized main status", async () => {
    vi.mocked(requireSession).mockResolvedValue();
    vi.mocked(getTargetById).mockResolvedValue({ id: "target-1" } as Awaited<ReturnType<typeof getTargetById>>);
    vi.mocked(refreshTargetHealth).mockResolvedValue({
      status: "ok",
      httpStatus: null,
      error: null,
      configuration: [
        { item: "zone", status: "passed", summary: "Zone 已通过。", manualSteps: [], details: {} },
        { item: "nameserver", status: "passed", summary: "Nameserver 已通过。", manualSteps: [], details: {} },
        { item: "dns", status: "passed", summary: "DNS 已通过。", manualSteps: [], details: {} },
        { item: "route", status: "passed", summary: "Route 已通过。", manualSteps: [], details: {} },
      ],
    });

    const response = await handleApi(
      new Request("https://admin.example.com/api/targets/target-1/check", { method: "POST", body: "{}" }),
      env,
      ctx,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      data: { healthStatus: "ok", configuration: [{ item: "zone", status: "passed" }, { item: "nameserver", status: "passed" }, { item: "dns", status: "passed" }, { item: "route", status: "passed" }] },
    });
  });
});
