import { describe, expect, it } from "vitest";
import { hashPasswordForDocs, verifyPassword } from "../src/worker/auth";

describe("auth", () => {
  it("verifies sha256 password hash", async () => {
    const hash = await hashPasswordForDocs("secret-pass");
    const env = { ADMIN_PASSWORD_HASH: hash } as Env;
    await expect(verifyPassword(env, "secret-pass")).resolves.toBe(true);
    await expect(verifyPassword(env, "wrong-pass")).resolves.toBe(false);
  });
});
