import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleApi } from "../../src/worker/api";
import { assertLoginAllowed, hashPasswordForDocs, recordLoginFailure } from "../../src/worker/auth";

const password = "correct horse battery staple";
const testEnv = env as Env & { PASSWORD_PEPPER: string };

async function configurePassword(): Promise<void> {
  const hash = await hashPasswordForDocs(password, testEnv.PASSWORD_PEPPER);
  await env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES ('ADMIN_PASSWORD_HASH', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).bind(hash).run();
}

async function login(): Promise<string> {
  const response = await SELF.fetch("https://admin.example.com/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.10" },
    body: JSON.stringify({ password }),
  });
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie");
  expect(cookie).toBeTruthy();
  return cookie!.split(";", 1)[0];
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM settings").run();
  await configurePassword();
});

describe("authenticated mutations", () => {
  it("rejects a cross-origin login before checking the password", async () => {
    const response = await SELF.fetch("https://admin.example.com/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://attacker.example" },
      body: JSON.stringify({ password }),
    });
    expect(response.status).toBe(403);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("rejects an explicit cross-origin request", async () => {
    const cookie = await login();
    const response = await SELF.fetch("https://admin.example.com/api/auth/password", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
        origin: "https://attacker.example",
      },
      body: JSON.stringify({ currentPassword: password, newPassword: "another secure password" }),
    });

    expect(response.status).toBe(403);
  });

  it("rejects provider credential fields instead of storing them", async () => {
    const cookie = await login();
    const response = await SELF.fetch("https://admin.example.com/api/registrars", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        cloudflareAccountId: "account-id",
        cloudflareApiToken: "cloudflare-token",
        dynadotApiKey: "dynadot-key",
      }),
    });

    expect(response.status).toBe(400);
    const stored = await env.DB.prepare(
      "SELECT key FROM settings WHERE key IN ('CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'DYNADOT_API_KEY')",
    ).all();
    expect(stored.results).toEqual([]);
  });

  it("rejects an explicit cross-origin logout", async () => {
    const cookie = await login();
    const response = await SELF.fetch("https://admin.example.com/api/auth/logout", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
        origin: "https://attacker.example",
      },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(403);
  });

  it("still stores the non-secret Dynadot Sandbox switch", async () => {
    const cookie = await login();
    const response = await SELF.fetch("https://admin.example.com/api/registrars", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ dynadotSandbox: true }),
    });

    expect(response.status).toBe(200);
    expect(await env.DB.prepare("SELECT value FROM settings WHERE key = 'DYNADOT_SANDBOX'").first("value")).toBe("true");
  });
});

describe("session lifecycle", () => {
  it("distinguishes a missing session from incorrect login credentials", async () => {
    const expired = await SELF.fetch("https://admin.example.com/api/settings/check");
    expect(expired.status).toBe(401);
    await expect(expired.json()).resolves.toMatchObject({ error: { code: "session_expired" } });
    const wrongPassword = await SELF.fetch("https://admin.example.com/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "wrong password" }),
    });
    expect(wrongPassword.status).toBe(401);
    await expect(wrongPassword.json()).resolves.toMatchObject({ error: { code: "unauthorized" } });
  });

  it("reports visitor hash readiness without revealing the secret", async () => {
    const cookie = await login();
    const response = await SELF.fetch("https://admin.example.com/api/settings/check", {
      headers: { cookie },
    });
    const body = await response.json<{ data: { hasVisitorHashSecret?: boolean } }>();

    expect(body.data.hasVisitorHashSecret).toBe(true);
    expect(JSON.stringify(body)).not.toContain(testEnv.VISITOR_HASH_SECRET);
  });

  it("does not accept a visitor hash secret shorter than 32 bytes", async () => {
    const cookie = await login();
    const response = await handleApi(
      new Request("https://admin.example.com/api/settings/check", { headers: { cookie } }),
      {
        DB: env.DB,
        ADMIN_HOST: "admin.example.com",
        SESSION_SECRET: testEnv.SESSION_SECRET,
        VISITOR_HASH_SECRET: "too-short",
      } as unknown as Env,
      {} as ExecutionContext,
    );
    const body = await response.json<{ data: { hasVisitorHashSecret: boolean } }>();

    expect(body.data.hasVisitorHashSecret).toBe(false);
  });

  it("invalidates an existing session after the password hash changes", async () => {
    const cookie = await login();
    const nextHash = await hashPasswordForDocs("replacement password", testEnv.PASSWORD_PEPPER);
    await env.DB.prepare("UPDATE settings SET value = ? WHERE key = 'ADMIN_PASSWORD_HASH'").bind(nextHash).run();

    const response = await SELF.fetch("https://admin.example.com/api/settings/check", {
      headers: { cookie },
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "session_expired" } });
  });

  it("does not hide a server configuration failure as an anonymous session", async () => {
    const cookie = await login();
    await env.DB.prepare("ALTER TABLE settings RENAME TO settings_unavailable").run();
    let response: Response;
    try {
      response = await SELF.fetch("https://admin.example.com/api/me", {
        headers: { cookie },
      });
    } finally {
      await env.DB.prepare("ALTER TABLE settings_unavailable RENAME TO settings").run();
    }

    expect(response.status).toBe(500);
  });
});

describe("login throttling", () => {
  it("allows login and starts a new failure window exactly when the block expires", async () => {
    const request = new Request("https://admin.example.com/api/auth/login", {
      headers: { "cf-connecting-ip": "192.0.2.49" },
    });
    const start = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(start);
    try {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await recordLoginFailure(request, env);
      }
      clock.mockReturnValue(start + 15 * 60_000 - 1);
      await expect(assertLoginAllowed(request, env)).rejects.toMatchObject({ status: 429 });
      clock.mockReturnValue(start + 15 * 60_000);
      await expect(assertLoginAllowed(request, env)).resolves.toBeUndefined();
      await recordLoginFailure(request, env);
      const stored = await env.DB.prepare("SELECT value FROM settings WHERE key LIKE 'login_fail:%'").first<string>("value");
      expect(JSON.parse(stored!)).toEqual({ count: 1, firstAt: start + 15 * 60_000, blockedUntil: 0 });
      await expect(assertLoginAllowed(request, env)).resolves.toBeUndefined();
    } finally {
      clock.mockRestore();
    }
  });

  it("blocks the sixth failed login from the same address", async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await SELF.fetch("https://admin.example.com/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.44" },
        body: JSON.stringify({ password: "wrong password" }),
      });
      statuses.push(response.status);
    }

    expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
  });

  it("clears failures after a successful login", async () => {
    const ip = "192.0.2.45";
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await SELF.fetch("https://admin.example.com/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": ip },
        body: JSON.stringify({ password: "wrong password" }),
      });
    }

    const success = await SELF.fetch("https://admin.example.com/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": ip },
      body: JSON.stringify({ password }),
    });
    expect(success.status).toBe(200);

    const afterSuccess: number[] = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await SELF.fetch("https://admin.example.com/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": ip },
        body: JSON.stringify({ password: "wrong password" }),
      });
      afterSuccess.push(response.status);
    }
    expect(afterSuccess).toEqual([401, 401]);
  });

  it("counts concurrent failures atomically", async () => {
    const request = () => SELF.fetch("https://admin.example.com/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.47" },
      body: JSON.stringify({ password: "wrong password" }),
    });

    const failures = await Promise.all(Array.from({ length: 5 }, request));
    expect(failures.map((response) => response.status)).toEqual([401, 401, 401, 401, 401]);
    expect((await request()).status).toBe(429);
  });
});

describe("password compatibility", () => {
  it("upgrades a valid legacy SHA-256 password after login", async () => {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(password)));
    const legacyHash = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    await env.DB.prepare("UPDATE settings SET value = ? WHERE key = 'ADMIN_PASSWORD_HASH'").bind(legacyHash).run();

    const response = await SELF.fetch("https://admin.example.com/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.46" },
      body: JSON.stringify({ password }),
    });

    expect(response.status).toBe(200);
    const upgraded = await env.DB.prepare("SELECT value FROM settings WHERE key = 'ADMIN_PASSWORD_HASH'").first<string>("value");
    expect(upgraded).toMatch(/^pbkdf2-sha256\$100000\$/);
  });

  it("rejects an oversized replacement password before hashing", async () => {
    const cookie = await login();
    const response = await SELF.fetch("https://admin.example.com/api/auth/password", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ currentPassword: password, newPassword: "x".repeat(257) }),
    });

    expect(response.status).toBe(400);
  });

  it("rejects an oversized login password before hashing", async () => {
    const response = await SELF.fetch("https://admin.example.com/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.48" },
      body: JSON.stringify({ password: "x".repeat(257) }),
    });

    expect(response.status).toBe(400);
  });
});
