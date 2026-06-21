import { describe, expect, it } from "vitest";
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

  it("redacts secret-like internal errors", async () => {
    const response = apiError(new Error("missing API TOKEN value"));
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { message: "服务器配置错误。" },
    });
  });
});
