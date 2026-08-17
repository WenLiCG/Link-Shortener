import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureDnsRecords, ensureWorkerRoutes, ensureZone, listZones } from "../src/worker/cloudflare";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const env = {
  DB: {} as D1Database,
  ASSETS: {} as Fetcher,
  ADMIN_HOST: "link.g60.net",
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

  it("bounds Cloudflare requests and reports timeouts as retryable", async () => {
    let signal: AbortSignal | null | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      signal = init?.signal;
      throw new DOMException("timed out", "TimeoutError");
    });

    await expect(ensureZone(env, "example.com")).rejects.toMatchObject({
      provider: "cloudflare",
      status: null,
      code: "timeout",
      retryable: true,
    });
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it("creates missing dns records", async () => {
    const created: Array<Record<string, unknown>> = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      if (init?.method === "POST") {
        created.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return jsonResponse({ success: true, result: { id: `record-${created.length}` } });
      }
      return jsonResponse({ success: true, result: [] });
    });

    await ensureDnsRecords(env, "zone-1", "example.com");

    expect(fetchMock).toHaveBeenCalledTimes(8);
    expect(created.map((record) => record.name)).toEqual(["example.com", "*.example.com"]);
  });

  it("replaces wrong or unproxied dns records", async () => {
    const updated: Array<Record<string, unknown>> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      if (method === "PATCH") {
        updated.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return jsonResponse({ success: true, result: { id: "updated" } });
      }
      const type = url.searchParams.get("type");
      const name = url.searchParams.get("name");
      return jsonResponse({
        success: true,
        result: type === "A" ? [{ id: `wrong-${name}`, type: "A", name, content: "203.0.113.9", proxied: false }] : [],
      });
    });

    await ensureDnsRecords(env, "zone-1", "example.com");

    expect(updated).toHaveLength(2);
    expect(updated).toEqual([
      expect.objectContaining({ name: "example.com", content: "192.0.2.1", proxied: true }),
      expect.objectContaining({ name: "*.example.com", content: "192.0.2.1", proxied: true }),
    ]);
  });

  it("corrects an existing route bound to another script", async () => {
    const requests: Request[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return request.method === "GET"
        ? jsonResponse({
          success: true,
          result: [
            { id: "r1", pattern: "example.com/*", script: "wrong-worker" },
            { id: "r2", pattern: "*.example.com/*", script: "link-shortener-manager" },
          ],
        })
        : jsonResponse({ success: true, result: { id: "r1" } });
    });

    await ensureWorkerRoutes(env, "zone-1", "example.com");

    const update = requests.find((request) => request.method === "PUT");
    expect(update?.url).toContain("/workers/routes/r1");
    expect(await update?.json()).toMatchObject({
      pattern: "example.com/*",
      script: "link-shortener-manager",
    });
  });

  it("reads every zone page reported by Cloudflare", async () => {
    const pages: number[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const page = Number(new URL(String(input)).searchParams.get("page"));
      pages.push(page);
      return jsonResponse({
        success: true,
        result: [{ id: `zone-${page}`, name: `example-${page}.com`, status: "active" }],
        result_info: { page, total_pages: 11 },
      });
    });

    await expect(listZones(env)).resolves.toHaveLength(11);
    expect(pages).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });
});
