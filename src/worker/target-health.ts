import { getTargetById, listStaleTargetIds, markTargetHealthChecking, updateTargetHealth } from "./db";
import { buildTargetUrl, type DomainJob } from "./shared";

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

async function fetchWithTimeout(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(10_000);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  requestSignal.throwIfAborted();
  return fetch(url, {
    ...init,
    signal: requestSignal,
    headers: {
      "user-agent": "Link-Shortener-Manager/1.0",
      ...(init.headers ?? {}),
    },
  });
}

export async function checkTargetHealth(targetHost: string, signal?: AbortSignal): Promise<TargetHealthResult> {
  const url = buildTargetUrl(targetHost);
  try {
    let response = await fetchWithTimeout(url, { method: "HEAD", redirect: "manual" }, signal);
    let healthy = response.status === 204;
    if (response.status === 405 || response.status === 501) {
      response = await fetchWithTimeout(url, { method: "GET", redirect: "manual" }, signal);
      healthy = response.status === 200;
    }
    signal?.throwIfAborted();
    return {
      status: healthy ? "ok" : "failed",
      httpStatus: response.status,
      error: healthy ? null : `HTTP ${response.status}`,
    };
  } catch (error) {
    signal?.throwIfAborted();
    return {
      status: "failed",
      httpStatus: null,
      error: normalizeError(error),
    };
  }
}

export async function refreshTargetHealth(env: Env, targetId: string, signal?: AbortSignal, lease?: Pick<DomainJob, "id" | "leaseToken">): Promise<void> {
  signal?.throwIfAborted();
  const target = await getTargetById(env.DB, targetId);
  signal?.throwIfAborted();
  if (!target) {
    return;
  }
  await markTargetHealthChecking(env.DB, target.id, lease);
  const result = await checkTargetHealth(target.targetHost, signal);
  signal?.throwIfAborted();
  await updateTargetHealth(env.DB, target.id, result, lease);
}

export async function refreshStaleTargetHealth(env: Env, limit = 10, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const ids = await listStaleTargetIds(env.DB, limit);
  for (const id of ids) {
    await refreshTargetHealth(env, id, signal);
  }
}
