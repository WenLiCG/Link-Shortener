export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export interface OperationJob {
  id: string;
  subjectId: string;
  status: "queued" | "running" | "retry_wait" | "completed" | "failed" | "unavailable";
  currentStep: string;
  errorMessage: string | null;
  payload: Record<string, unknown>;
  nextAttemptAt?: string;
}

export const REQUEST_TIMEOUT_MS = 45_000;
export const DOMAIN_POLL_INTERVAL_MS = 3_000;
export const sessionEvents = new EventTarget();

export async function api<T>(
  path: string,
  init?: RequestInit,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(path, {
      ...init,
      cache: "no-store",
      signal: options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });
    const body = await response.json() as { ok: true; data: T } | { ok: false; error: { code: string; message: string } };
    if (!body.ok) {
      if (body.error.code === "session_expired") {
        sessionEvents.dispatchEvent(new Event("session-expired"));
      }
      throw new ApiError(response.status, body.error.code, body.error.message);
    }
    return body.data;
  } catch (error) {
    if (!options.signal?.aborted && timeoutSignal.aborted) {
      throw new ApiError(0, "request_timeout", "请求超时；已提交的后台任务可能仍在处理。");
    }
    throw error;
  }
}

export function operationResult<T>(job: OperationJob): Partial<T> {
  const result = job.payload.result;
  return result && typeof result === "object" && !Array.isArray(result) ? result as Partial<T> : {};
}

export function operationState(job: OperationJob) {
  return {
    ok: job.status !== "failed" && job.status !== "unavailable",
    status: job.status,
    message: job.errorMessage ?? (job.status === "completed" ? "处理完成。" : "后台任务仍在处理，将继续自动查询。"),
  };
}

export function isOperationPending(job: OperationJob): boolean {
  return job.status === "queued" || job.status === "running" || job.status === "retry_wait";
}

export function operationPollDelay(job: OperationJob, intervalMs: number): number {
  if (job.status !== "retry_wait") return intervalMs;
  const remaining = Date.parse(job.nextAttemptAt ?? "") - Date.now();
  return Number.isFinite(remaining) ? Math.max(30_000, Math.min(60_000, remaining)) : 60_000;
}

export function retainedDateRange(retentionDays: number, now = Date.now()) {
  const days = Number.isInteger(retentionDays) && retentionDays > 0 ? retentionDays : 30;
  const shanghaiNow = now + 8 * 60 * 60_000;
  return {
    days,
    from: new Date(shanghaiNow - (days - 1) * 86_400_000).toISOString().slice(0, 10),
    to: new Date(shanghaiNow).toISOString().slice(0, 10),
  };
}

export function isProcessingStatus(status?: string | null): boolean {
  return !status || ["queued", "running", "retry_wait", "pending", "checking", "validating", "cloudflare_zone", "nameserver_update", "dns_configured", "route_configured", "waiting_nameserver"].includes(status);
}

export function pollingFailure(error: unknown) {
  const missing = error instanceof ApiError && error.status === 404;
  return {
    ...(missing ? { ok: false, status: "unavailable" } : {}),
    message: error instanceof Error ? error.message : "暂时无法查询任务状态，将自动重试。",
  };
}

export function restoreOperationResults<T extends { jobId?: string; status?: string; ok: boolean }>(items: T[]): T[] {
  return items.map((item) => {
    if (!item.jobId && isProcessingStatus(item.status) && (item.ok || item.status !== undefined)) {
      const message = "提交结果未确认，请重试以核对状态。";
      return { ...item, ok: false, status: "unconfirmed", error: message, message };
    }
    return item.jobId && item.status === "failed"
      ? { ...item, ok: true, status: "queued", error: undefined, message: "正在核对后台任务状态。" }
      : item;
  });
}

export function submissionFailureStatus(error: unknown): "failed" | "unconfirmed" {
  return error instanceof ApiError && error.status >= 400 && error.status < 500 ? "failed" : "unconfirmed";
}

export function retryRequestKey(item: { jobId?: string; status?: string; requestKey?: string }): string {
  return item.jobId && item.status === "failed" ? crypto.randomUUID() : item.requestKey ?? crypto.randomUUID();
}

export function visibleSelection(items: { id: string }[], selected: string[]): string[] {
  return items.filter((item) => selected.includes(item.id)).map((item) => item.id);
}

export function formatDate(value: string | null): string {
  return value ? new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).format(new Date(value)) : "-";
}
