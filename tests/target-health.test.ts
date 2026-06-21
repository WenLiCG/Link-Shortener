import { afterEach, describe, expect, it, vi } from "vitest";
import { checkTargetHealth } from "../src/worker/target-health";

describe("target health", () => {
  afterEach(() => {
    vi.restoreAllMocks();
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
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("fetch failed"));
    await expect(checkTargetHealth("bad.example.com")).resolves.toMatchObject({
      status: "failed",
      httpStatus: null,
      error: "fetch failed",
    });
  });
});
