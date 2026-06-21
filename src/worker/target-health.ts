import { getTargetById, listStaleTargetIds, markTargetHealthChecking, updateTargetHealth } from "./db";
import { buildTargetUrl } from "./shared";

export interface TargetHealthResult {
  status: "ok" | "failed";
  httpStatus: number | null;
  error: string | null;
}

function isReachableStatus(status: number): boolean {
  return status >= 200 && status < 400;
}

function normalizeError(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") {
    return "request_timeout";
  }
  if (error instanceof Error) {
    return error.message.slice(0, 180);
  }
  return "health_check_failed";
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        "user-agent": "Link-Shortener-Manager/1.0",
        ...(init.headers ?? {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function checkTargetHealth(targetHost: string): Promise<TargetHealthResult> {
  const url = buildTargetUrl(targetHost);
  try {
    let response = await fetchWithTimeout(url, { method: "HEAD", redirect: "manual" });
    if (response.status === 405 || response.status === 501) {
      response = await fetchWithTimeout(url, { method: "GET", redirect: "manual" });
    }
    const reachable = isReachableStatus(response.status);
    return {
      status: reachable ? "ok" : "failed",
      httpStatus: response.status,
      error: reachable ? null : `HTTP ${response.status}`,
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
  if (target.dnsStatus === "configured" && target.nameserverStatus === "active" && target.cloudflareZoneId) {
    await updateTargetHealth(env.DB, target.id, {
      status: "ok",
      httpStatus: 204,
      error: null,
    });
    return;
  }
  const result = await checkTargetHealth(target.targetHost);
  await updateTargetHealth(env.DB, target.id, result);
}

export async function refreshStaleTargetHealth(env: Env, limit = 10): Promise<void> {
  const ids = await listStaleTargetIds(env.DB, limit);
  for (const id of ids) {
    await refreshTargetHealth(env, id);
  }
}
