import { HttpError, cookie, getCookie } from "./http";
import { configuredValue, secret } from "./env-utils";

const SESSION_COOKIE = "lsm_session";
const SESSION_TTL_SECONDS = 60 * 60 * 12;

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function textToBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function base64UrlEncode(value: string | ArrayBuffer | Uint8Array): string {
  const bytes = typeof value === "string" ? textToBytes(value) : value instanceof Uint8Array ? value : new Uint8Array(value);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1] ?? 0;
    const third = bytes[index + 2] ?? 0;
    const chunk = (first << 16) | (second << 8) | third;
    output += alphabet[(chunk >> 18) & 63];
    output += alphabet[(chunk >> 12) & 63];
    if (index + 1 < bytes.length) {
      output += alphabet[(chunk >> 6) & 63];
    }
    if (index + 2 < bytes.length) {
      output += alphabet[chunk & 63];
    }
  }
  return output;
}

function base64UrlDecode(value: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 4) {
    const first = alphabet.indexOf(value[index] ?? "A");
    const second = alphabet.indexOf(value[index + 1] ?? "A");
    const third = alphabet.indexOf(value[index + 2] ?? "A");
    const fourth = alphabet.indexOf(value[index + 3] ?? "A");
    const chunk = (first << 18) | (second << 12) | ((third < 0 ? 0 : third) << 6) | (fourth < 0 ? 0 : fourth);
    bytes.push((chunk >> 16) & 255);
    if (index + 2 < value.length) {
      bytes.push((chunk >> 8) & 255);
    }
    if (index + 3 < value.length) {
      bytes.push(chunk & 255);
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function rightRotate(value: number, amount: number): number {
  return (value >>> amount) | (value << (32 - amount));
}

function sha256Bytes(value: string): Uint8Array {
  const bytes = [...textToBytes(value)];
  const bitLength = bytes.length * 8;
  bytes.push(0x80);
  while ((bytes.length % 64) !== 56) {
    bytes.push(0);
  }
  for (let index = 7; index >= 0; index -= 1) {
    bytes.push((bitLength / 2 ** (index * 8)) & 0xff);
  }

  const k = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  for (let chunk = 0; chunk < bytes.length; chunk += 64) {
    const words = new Array<number>(64).fill(0);
    for (let index = 0; index < 16; index += 1) {
      const offset = chunk + index * 4;
      words[index] =
        ((bytes[offset] ?? 0) << 24) |
        ((bytes[offset + 1] ?? 0) << 16) |
        ((bytes[offset + 2] ?? 0) << 8) |
        (bytes[offset + 3] ?? 0);
    }
    for (let index = 16; index < 64; index += 1) {
      const s0 = rightRotate(words[index - 15], 7) ^ rightRotate(words[index - 15], 18) ^ (words[index - 15] >>> 3);
      const s1 = rightRotate(words[index - 2], 17) ^ rightRotate(words[index - 2], 19) ^ (words[index - 2] >>> 10);
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let index = 0; index < 64; index += 1) {
      const s1 = rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + k[index] + words[index]) >>> 0;
      const s0 = rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  const out = new Uint8Array(32);
  [h0, h1, h2, h3, h4, h5, h6, h7].forEach((word, index) => {
    out[index * 4] = (word >>> 24) & 255;
    out[index * 4 + 1] = (word >>> 16) & 255;
    out[index * 4 + 2] = (word >>> 8) & 255;
    out[index * 4 + 3] = word & 255;
  });
  return out;
}

async function sha256(value: string): Promise<string> {
  return bytesToHex(sha256Bytes(value));
}

async function sign(secretValue: string, payload: string): Promise<string> {
  return base64UrlEncode(sha256Bytes(`${secretValue}.${payload}`));
}

function timingSafeEqual(left: string, right: string): boolean {
  const leftBytes = textToBytes(left);
  const rightBytes = textToBytes(right);
  if (leftBytes.byteLength !== rightBytes.byteLength) {
    return false;
  }
  let diff = 0;
  for (let index = 0; index < leftBytes.byteLength; index += 1) {
    diff |= leftBytes[index] ^ rightBytes[index];
  }
  return diff === 0;
}

export async function verifyPassword(env: Env, password: string): Promise<boolean> {
  const passwordHash = await configuredValue(env, "ADMIN_PASSWORD_HASH");
  if (!passwordHash) {
    throw new HttpError(500, "server_error", "尚未配置 ADMIN_PASSWORD_HASH。");
  }
  const candidate = await sha256(password);
  return timingSafeEqual(candidate, passwordHash.trim().toLowerCase());
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
    }),
  );
  const signature = await sign(sessionSecret, payload);
  return cookie(SESSION_COOKIE, `${payload}.${signature}`, SESSION_TTL_SECONDS);
}

export async function requireSession(request: Request, env: Env): Promise<void> {
  const token = getCookie(request, SESSION_COOKIE);
  const sessionSecret = secret(env, "SESSION_SECRET");
  if (!token || !sessionSecret) {
    throw new HttpError(401, "unauthorized", "请先登录。");
  }
  const [payload, signature] = token.split(".");
  if (!payload || !signature) {
    throw new HttpError(401, "unauthorized", "登录状态无效。");
  }
  const expected = await sign(sessionSecret, payload);
  if (!timingSafeEqual(signature, expected)) {
    throw new HttpError(401, "unauthorized", "登录状态无效。");
  }
  try {
    const body = JSON.parse(base64UrlDecode(payload)) as { exp?: number };
    if (!body.exp || body.exp < Math.floor(Date.now() / 1000)) {
      throw new HttpError(401, "unauthorized", "登录已过期。");
    }
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    throw new HttpError(401, "unauthorized", "登录状态无效。");
  }
}

export function clearSessionCookie(): string {
  return cookie(SESSION_COOKIE, "", 0);
}

export async function hashPasswordForDocs(password: string): Promise<string> {
  return sha256(password);
}
