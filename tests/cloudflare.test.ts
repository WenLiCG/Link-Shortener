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

function envWithStoredValue(value: string): Env {
  return {
    ...env,
    DB: {
      prepare: () => ({
        bind: () => ({
          first: async () => ({ value }),
        }),
      }),
    } as unknown as D1Database,
  };
}

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

  it("uses Worker secrets instead of legacy D1 credential values", async () => {
    const requests: Request[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      requests.push(new Request(input, init));
      return requests.length === 1
        ? jsonResponse({ success: true, result: [] })
        : jsonResponse({ success: true, result: { id: "zone-1", name: "example.com", status: "pending", name_servers: [] } });
    });

    await ensureZone(envWithStoredValue("stale-d1-value"), "example.com");

    expect(requests[0].headers.get("authorization")).toBe("Bearer token");
    expect(await requests[1].json()).toMatchObject({ account: { id: "account" } });
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
