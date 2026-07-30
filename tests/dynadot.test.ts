import { afterEach, describe, expect, it, vi } from "vitest";
import { isDomainInDynadot, setNameservers } from "../src/worker/dynadot";

const env = {
  DB: {
    prepare: () => ({
      bind: () => ({
        first: async () => ({ value: "stale-d1-key" }),
      }),
    }),
  } as unknown as D1Database,
  DYNADOT_API_KEY: "worker-secret-key",
  DYNADOT_SANDBOX: "false",
} as Env;

describe("dynadot client", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses the Worker secret instead of a legacy D1 key", async () => {
    let requestedUrl = "";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({ DomainInfoResponse: { ResponseCode: 0, Status: "success" } }));
    });

    await expect(isDomainInDynadot(env, "example.com")).resolves.toBe(true);
    expect(new URL(requestedUrl).searchParams.get("key")).toBe("worker-secret-key");
  });

  it("marks timeouts as retryable provider errors", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new DOMException("timed out", "TimeoutError"));

    await expect(isDomainInDynadot(env, "example.com")).rejects.toMatchObject({
      provider: "dynadot",
      status: null,
      code: "timeout",
      retryable: true,
    });
  });

  it("marks HTTP 429 as retryable without exposing the response body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("secret upstream details", { status: 429 }));

    await expect(isDomainInDynadot(env, "example.com")).rejects.toMatchObject({
      provider: "dynadot",
      status: 429,
      code: "http_429",
      retryable: true,
    });
  });

  it("rejects malformed JSON as a retryable provider error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("<html>bad gateway</html>", { status: 200 }));

    await expect(isDomainInDynadot(env, "example.com")).rejects.toMatchObject({
      provider: "dynadot",
      status: 200,
      code: "invalid_response",
      retryable: true,
    });
  });

  it("returns false when the domain is not in the account", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ DomainInfoResponse: { ResponseCode: -1, Status: "error", Error: "not found" } })),
    );

    await expect(isDomainInDynadot(env, "example.com")).resolves.toBe(false);
  });

  it("reports a rejected nameserver update as permanent", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ SetNsResponse: { ResponseCode: -1, Status: "error", Error: "rejected" } })),
    );

    await expect(setNameservers(env, "example.com", ["a.ns", "b.ns"])).rejects.toMatchObject({
      provider: "dynadot",
      status: 200,
      code: "operation_rejected",
      retryable: false,
    });
  });
});
