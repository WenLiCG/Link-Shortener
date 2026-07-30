import { afterEach, describe, expect, it, vi } from "vitest";
import { isDomainInDynadot } from "../src/worker/dynadot";

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
});
