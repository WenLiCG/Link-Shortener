import { describe, expect, it } from "vitest";
import { hashPasswordForDocs, verifyPassword } from "../src/worker/auth";

describe("auth", () => {
  it("hashes and verifies passwords with salted PBKDF2", async () => {
    const hash = await hashPasswordForDocs("secret-pass", "test-password-pepper");
    expect(hash).toMatch(/^pbkdf2-sha256\$100000\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);

    const env = {
      ADMIN_PASSWORD_HASH: hash,
      PASSWORD_PEPPER: "test-password-pepper",
    } as Env;
    await expect(verifyPassword(env, "secret-pass")).resolves.toBe(true);
    await expect(verifyPassword(env, "wrong-pass")).resolves.toBe(false);
  });

  it("requires the password pepper before accepting a legacy hash", async () => {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("secret-pass")));
    const legacyHash = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");

    await expect(verifyPassword({ ADMIN_PASSWORD_HASH: legacyHash } as Env, "secret-pass")).rejects.toMatchObject({
      status: 500,
      code: "server_error",
    });
  });
});
