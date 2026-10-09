import { describe, expect, it, vi } from "vitest";
import { apiError } from "../src/worker/api";
import { HttpError, ok } from "../src/worker/http";

describe("api errors", () => {
  it("prevents browser and edge caching of API responses", () => {
    expect(ok({}).headers.get("cache-control")).toBe("no-store");
  });

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
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret.example");
    expect(response.headers.get("x-request-id")).toBeTruthy();
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({
      event: "api_error", requestId: response.headers.get("x-request-id"), category: "internal_error",
    });
    log.mockRestore();
  });

  it("logs a database category and safe code without query parameters or secrets", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = apiError(new Error("D1_ERROR: SQLITE_CONSTRAINT failed query with token=private-value"));
    expect(response.status).toBe(500);
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({
      category: "database_error", code: "SQLITE_CONSTRAINT", requestId: response.headers.get("x-request-id"),
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain("private-value");
    log.mockRestore();
  });
});
