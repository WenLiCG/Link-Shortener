import type { ApiErrorBody, ApiErrorCode, ApiSuccessBody } from "./shared";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ApiErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export function json<T>(data: T, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init?.headers ?? {}),
    },
  });
}

export function ok<T>(data: T, init?: ResponseInit): Response {
  const body: ApiSuccessBody<T> = { ok: true, data };
  return json(body, init);
}

export function fail(status: number, code: ApiErrorCode, message: string): Response {
  const body: ApiErrorBody = { ok: false, error: { code, message } };
  return json(body, { status });
}

export async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new HttpError(400, "bad_request", "请求体必须是合法 JSON。");
  }
}

export function getCookie(request: Request, name: string): string | null {
  const cookie = request.headers.get("cookie");
  if (!cookie) {
    return null;
  }
  const parts = cookie.split(";").map((part) => part.trim());
  for (const part of parts) {
    const [key, ...value] = part.split("=");
    if (key === name) {
      return value.join("=");
    }
  }
  return null;
}

export function cookie(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${maxAgeSeconds}`;
}
