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

  it.each(["caller", "request"])("keeps %s cancellation active while reading the response body", async (source) => {
    const caller = new AbortController();
    const timeout = new AbortController();
    const timeoutMock = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => new Response(new ReadableStream({
      start(stream) {
        init?.signal?.addEventListener("abort", () => stream.error(init.signal?.reason), { once: true });
        queueMicrotask(() => (source === "caller" ? caller : timeout).abort(new DOMException("expired", "TimeoutError")));
      },
    })));

    await expect(isDomainInDynadot(env, "example.com", caller.signal)).rejects.toMatchObject({
      status: 200, code: "timeout", retryable: true,
    });
    expect(timeoutMock).toHaveBeenCalledWith(10_000);
    expect(source === "caller" ? timeout.signal.aborted : caller.signal.aborted).toBe(false);
  });

  it("does not submit a nameserver change after the job expires", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await expect(setNameservers(env, "example.com", ["a.ns", "b.ns"], AbortSignal.abort())).rejects.toMatchObject({ code: "timeout" });
    expect(fetchMock).not.toHaveBeenCalled();
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
