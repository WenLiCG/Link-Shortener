import { describe, expect, it, vi } from "vitest";

vi.mock("../src/worker/db", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/worker/db")>(),
  getTargetById: vi.fn(),
}));

vi.mock("../src/worker/auth", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/worker/auth")>(),
  requireSession: vi.fn(),
}));

vi.mock("../src/worker/target-configuration", () => ({
  checkTargetConfigurationItem: vi.fn(),
  configureTargetConfigurationItem: vi.fn(),
}));

import { handleApi } from "../src/worker/api";
import { requireSession } from "../src/worker/auth";
import { getTargetById } from "../src/worker/db";
import { checkTargetConfigurationItem, configureTargetConfigurationItem } from "../src/worker/target-configuration";

const env = { DB: {} } as Env;
const ctx = {} as ExecutionContext;

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
});
