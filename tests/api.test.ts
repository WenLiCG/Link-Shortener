import { describe, expect, it, vi } from "vitest";
import { apiError } from "../src/worker/api";
import { HttpError } from "../src/worker/http";

describe("api errors", () => {
  it("returns structured user-safe http errors", async () => {
    const response = apiError(new HttpError(400, "bad_request", "坏请求"));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "bad_request", message: "坏请求" },
    });
  });

  it("redacts every unknown internal error", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = apiError(new Error("database failed at https://secret.example/path"));
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { message: "服务器内部错误。" },
    });
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("secret.example"));
    log.mockRestore();
  });
});
