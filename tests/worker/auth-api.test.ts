import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { hashPasswordForDocs } from "../../src/worker/auth";

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
  it("invalidates an existing session after the password hash changes", async () => {
    const cookie = await login();
    const nextHash = await hashPasswordForDocs("replacement password", testEnv.PASSWORD_PEPPER);
    await env.DB.prepare("UPDATE settings SET value = ? WHERE key = 'ADMIN_PASSWORD_HASH'").bind(nextHash).run();

    const response = await SELF.fetch("https://admin.example.com/api/settings/check", {
      headers: { cookie },
    });

    expect(response.status).toBe(401);
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
