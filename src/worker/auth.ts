import { setSetting } from "./db";
import { secret } from "./env-utils";
import { HttpError, cookie, getCookie } from "./http";

const SESSION_COOKIE = "lsm_session";
const SESSION_TTL_SECONDS = 60 * 60 * 12;
const PASSWORD_ITERATIONS = 100_000;
const LOGIN_WINDOW_MS = 15 * 60_000;
const LOGIN_FAILURE_LIMIT = 5;
const encoder = new TextEncoder();

function base64UrlEncode(value: string | ArrayBuffer | Uint8Array): string {
  const bytes = typeof value === "string" ? encoder.encode(value) : value instanceof Uint8Array ? value : new Uint8Array(value);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

async function importHmacKey(secretValue: string, usages: Array<"sign" | "verify">): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secretValue), { name: "HMAC", hash: "SHA-256" }, false, usages);
}

async function sign(secretValue: string, payload: string): Promise<string> {
  const key = await importHmacKey(secretValue, ["sign"]);
  return base64UrlEncode(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)));
}

async function verifySignature(secretValue: string, payload: string, signature: string): Promise<boolean> {
  try {
    const key = await importHmacKey(secretValue, ["verify"]);
    return await crypto.subtle.verify("HMAC", key, base64UrlDecode(signature), encoder.encode(payload));
  } catch {
    return false;
  }
}

async function legacySha256(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function derivePassword(password: string, pepper: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(`${password}.${pepper}`), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256),
  );
}

export async function hashPasswordForDocs(password: string, pepper: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const digest = await derivePassword(password, pepper, salt, PASSWORD_ITERATIONS);
  return `pbkdf2-sha256$${PASSWORD_ITERATIONS}$${base64UrlEncode(salt)}$${base64UrlEncode(digest)}`;
}

async function verifyPasswordHash(password: string, pepper: string, encoded: string): Promise<boolean> {
  const [algorithm, iterationsText, saltText, digestText, extra] = encoded.split("$");
  const iterations = Number(iterationsText);
  if (
    algorithm !== "pbkdf2-sha256" ||
    extra ||
    iterations !== PASSWORD_ITERATIONS ||
    !saltText ||
    !digestText
  ) {
    return false;
  }
  try {
    const expected = base64UrlDecode(digestText);
    const actual = await derivePassword(password, pepper, base64UrlDecode(saltText), iterations);
    if (actual.length !== expected.length) {
      return false;
    }
    let different = 0;
    for (let index = 0; index < actual.length; index += 1) {
      different |= actual[index] ^ expected[index];
    }
    return different === 0;
  } catch {
    return false;
  }
}

async function configuredPasswordHash(env: Env): Promise<string> {
  const stored = env.DB
    ? await env.DB.prepare("SELECT value FROM settings WHERE key = 'ADMIN_PASSWORD_HASH' LIMIT 1").first<{ value?: string }>()
    : null;
  const passwordHash = stored?.value || secret(env, "ADMIN_PASSWORD_HASH");
  if (!passwordHash) {
    throw new HttpError(500, "server_error", "尚未配置 ADMIN_PASSWORD_HASH。");
  }
  return passwordHash.trim();
}

export async function verifyPassword(env: Env, password: string): Promise<boolean> {
  const passwordHash = await configuredPasswordHash(env);
  const pepper = secret(env, "PASSWORD_PEPPER");
  if (!pepper) {
    throw new HttpError(500, "server_error", "尚未配置 PASSWORD_PEPPER。");
  }
  if (/^[a-f0-9]{64}$/i.test(passwordHash)) {
    const valid = (await legacySha256(password)).toLowerCase() === passwordHash.toLowerCase();
    if (valid && env.DB) {
      await setSetting(env.DB, "ADMIN_PASSWORD_HASH", await hashPasswordForDocs(password, pepper));
    }
    return valid;
  }
  return verifyPasswordHash(password, pepper, passwordHash);
}

async function passwordVersion(env: Env, sessionSecret: string): Promise<string> {
  return sign(sessionSecret, `password:${await configuredPasswordHash(env)}`);
}

export async function createSessionCookie(env: Env): Promise<string> {
  const sessionSecret = secret(env, "SESSION_SECRET");
  if (!sessionSecret) {
    throw new HttpError(500, "server_error", "尚未配置 SESSION_SECRET。");
  }
  const payload = base64UrlEncode(
    JSON.stringify({
      sub: "admin",
      exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
      passwordVersion: await passwordVersion(env, sessionSecret),
    }),
  );
  const signature = await sign(sessionSecret, payload);
  return cookie(SESSION_COOKIE, `${payload}.${signature}`, SESSION_TTL_SECONDS);
}

export async function requireSession(request: Request, env: Env): Promise<void> {
  const token = getCookie(request, SESSION_COOKIE);
  const sessionSecret = secret(env, "SESSION_SECRET");
  if (!token || !sessionSecret) {
    throw new HttpError(401, "session_expired", "请先登录。");
  }
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra || !(await verifySignature(sessionSecret, payload, signature))) {
    throw new HttpError(401, "session_expired", "登录状态无效。");
  }
  let body: { sub?: string; exp?: number; passwordVersion?: string };
  try {
    body = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload))) as {
      sub?: string;
      exp?: number;
      passwordVersion?: string;
    };
  } catch {
    throw new HttpError(401, "session_expired", "登录状态无效。");
  }
  if (
    body.sub !== "admin" ||
    !body.exp ||
    body.exp <= Math.floor(Date.now() / 1000) ||
    body.passwordVersion !== await passwordVersion(env, sessionSecret)
  ) {
    throw new HttpError(401, "session_expired", "登录已过期。");
  }
}

interface LoginFailure {
  count: number;
  firstAt: number;
  blockedUntil: number;
}

async function loginFailureKey(request: Request, env: Env): Promise<string> {
  const sessionSecret = secret(env, "SESSION_SECRET");
  if (!sessionSecret) {
    throw new HttpError(500, "server_error", "尚未配置 SESSION_SECRET。");
  }
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  return `login_fail:${await sign(sessionSecret, ip)}`;
}

async function readLoginFailure(env: Env, key: string): Promise<LoginFailure | null> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ? LIMIT 1").bind(key).first<{ value?: string }>();
  if (!row?.value) {
    return null;
  }
  try {
    const value = JSON.parse(row.value) as LoginFailure;
    return Number.isFinite(value.count) && Number.isFinite(value.firstAt) && Number.isFinite(value.blockedUntil) ? value : null;
  } catch {
    return null;
  }
}

export async function assertLoginAllowed(request: Request, env: Env): Promise<void> {
  const failure = await readLoginFailure(env, await loginFailureKey(request, env));
  if (failure && failure.count >= LOGIN_FAILURE_LIMIT && failure.blockedUntil > Date.now()) {
    throw new HttpError(429, "rate_limited", "登录失败次数过多，请稍后再试。");
  }
}

export async function recordLoginFailure(request: Request, env: Env): Promise<void> {
  const key = await loginFailureKey(request, env);
  const now = Date.now();
  const initial = JSON.stringify({ count: 1, firstAt: now, blockedUntil: 0 } satisfies LoginFailure);
  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM settings WHERE key LIKE 'login_fail:%' AND updated_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day')",
    ),
    env.DB.prepare(
      `INSERT INTO settings (key, value, updated_at)
       VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       ON CONFLICT(key) DO UPDATE SET
         value = CASE
           WHEN NOT json_valid(settings.value) THEN excluded.value
           WHEN ? - CAST(json_extract(settings.value, '$.firstAt') AS INTEGER) >= ? THEN excluded.value
           ELSE json_set(
             settings.value,
             '$.count', CAST(json_extract(settings.value, '$.count') AS INTEGER) + 1,
             '$.blockedUntil', CASE
               WHEN CAST(json_extract(settings.value, '$.count') AS INTEGER) + 1 >= ? THEN ? + ?
               ELSE 0
             END
           )
         END,
         updated_at = excluded.updated_at`,
    ).bind(key, initial, now, LOGIN_WINDOW_MS, LOGIN_FAILURE_LIMIT, now, LOGIN_WINDOW_MS),
  ]);
}

export async function clearLoginFailures(request: Request, env: Env): Promise<void> {
  await env.DB.prepare("DELETE FROM settings WHERE key = ?").bind(await loginFailureKey(request, env)).run();
}

export function clearSessionCookie(): string {
  return cookie(SESSION_COOKIE, "", 0);
}
