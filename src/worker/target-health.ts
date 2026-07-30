import { getTargetById, listStaleTargetIds, markTargetHealthChecking, updateTargetHealth } from "./db";
import { buildTargetUrl } from "./shared";

export interface TargetHealthResult {
  status: "ok" | "failed";
  httpStatus: number | null;
  error: string | null;
}

function normalizeError(error: unknown): string {
  if (error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return "request_timeout";
  }
  return "health_check_failed";
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, {
    ...init,
    signal: AbortSignal.timeout(10_000),
    headers: {
      "user-agent": "Link-Shortener-Manager/1.0",
      ...(init.headers ?? {}),
    },
  });
}

export async function checkTargetHealth(targetHost: string): Promise<TargetHealthResult> {
  const url = buildTargetUrl(targetHost);
  try {
    let response = await fetchWithTimeout(url, { method: "HEAD", redirect: "manual" });
    let healthy = response.status === 204;
    if (response.status === 405 || response.status === 501) {
      response = await fetchWithTimeout(url, { method: "GET", redirect: "manual" });
      healthy = response.status === 200;
    }
    return {
      status: healthy ? "ok" : "failed",
      httpStatus: response.status,
      error: healthy ? null : `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      status: "failed",
      httpStatus: null,
      error: normalizeError(error),
    };
  }
}

export async function refreshTargetHealth(env: Env, targetId: string): Promise<void> {
  const target = await getTargetById(env.DB, targetId);
  if (!target) {
    return;
  }
  await markTargetHealthChecking(env.DB, target.id);
  const result = await checkTargetHealth(target.targetHost);
  await updateTargetHealth(env.DB, target.id, result);
}

export async function refreshStaleTargetHealth(env: Env, limit = 10): Promise<void> {
  const ids = await listStaleTargetIds(env.DB, limit);
  for (const id of ids) {
    await refreshTargetHealth(env, id);
  }
}
