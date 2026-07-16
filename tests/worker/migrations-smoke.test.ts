import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("D1 migrations", () => {
  it("creates the current schema", async () => {
    const row = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'redirect_domains'",
    ).first<{ name: string }>();
    expect(row?.name).toBe("redirect_domains");
  });
});
