import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureDnsRecords, ensureWorkerRoutes, ensureZone } from "../src/worker/cloudflare";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const env = {
  DB: {} as D1Database,
  ASSETS: {} as Fetcher,
  ADMIN_HOST: "localhost",
  DYNADOT_SANDBOX: "false",
  VISIT_EVENT_RETENTION_DAYS: "30",
  CLOUDFLARE_API_TOKEN: "token",
  CLOUDFLARE_ACCOUNT_ID: "account",
  WORKER_SCRIPT_NAME: "link-shortener-manager",
} satisfies Env;

describe("cloudflare client", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reuses an existing zone", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        success: true,
        result: [{ id: "zone-1", name: "example.com", status: "active", name_servers: ["a.ns", "b.ns"] }],
      }),
    );
    await expect(ensureZone(env, "example.com")).resolves.toMatchObject({ id: "zone-1", nameServers: ["a.ns", "b.ns"] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("creates missing dns records", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ success: true, result: [] }))
      .mockResolvedValueOnce(jsonResponse({ success: true, result: { id: "record-1" } }))
      .mockResolvedValueOnce(jsonResponse({ success: true, result: [] }))
      .mockResolvedValueOnce(jsonResponse({ success: true, result: { id: "record-2" } }));
    await ensureDnsRecords(env, "zone-1", "example.com");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("does not duplicate existing routes", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ success: true, result: [{ id: "r1", pattern: "example.com/*" }] }))
      .mockResolvedValueOnce(jsonResponse({ success: true, result: { id: "r2" } }));
    await ensureWorkerRoutes(env, "zone-1", "example.com");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
