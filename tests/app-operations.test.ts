import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, sessionEvents, formatDate, isOperationPending, isProcessingStatus, operationState, pollingFailure, restoreOperationResults, submissionFailureStatus, retryRequestKey, visibleSelection, retainedDateRange, operationPollDelay, type OperationJob } from "../src/app/src/operations";
import { startOperationPolling } from "../src/app/src/hooks/useOperationPolling";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function job(status: OperationJob["status"]): OperationJob {
  return { id: "job-1", subjectId: "domain-1", status, currentStep: status, errorMessage: null, payload: {} };
}

function response(data: OperationJob) {
  return new Response(JSON.stringify({ ok: true, data }));
}

describe("operation state", () => {
  it("leaves retry_wait pending and can observe its eventual completion", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response(job("retry_wait"))).mockResolvedValueOnce(response(job("completed")));
    vi.stubGlobal("fetch", fetch);
    expect(operationState(await api<OperationJob>("/api/jobs/job-1"))).toMatchObject({ ok: true, status: "retry_wait" });
    expect(operationState(await api<OperationJob>("/api/jobs/job-1"))).toMatchObject({ ok: true, status: "completed" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("returns a real terminal failure without waiting", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ ...job("failed"), errorMessage: "权限不足" })));
    const result = await api<OperationJob>("/api/jobs/job-1");
    expect(operationState(result)).toEqual({ ok: false, status: "failed", message: "权限不足" });
    expect(isOperationPending(result)).toBe(false);
  });

  it("keeps temporary query errors separate from terminal missing records", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new TypeError("offline")).mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, error: { code: "not_found", message: "任务不存在" } }), { status: 404 }),
    ));
    await expect(api("/api/jobs/job-1")).rejects.toThrow("offline");
    expect(pollingFailure(new Error("offline"))).not.toHaveProperty("status");
    try {
      await api("/api/jobs/job-1");
      throw new Error("expected missing record");
    } catch (error) {
      expect(pollingFailure(error)).toEqual({ ok: false, status: "unavailable", message: "任务不存在" });
    }
  });

  it("rechecks stored failures with a job id while retaining the retry payload", () => {
    const results = restoreOperationResults([{ ok: false, status: "failed", jobId: "job-1", registrarId: "manual", retryPayload: { domains: "example.com" } }, { ok: false, status: "failed" }]);
    expect(results[0]).toMatchObject({ ok: true, status: "queued", jobId: "job-1", registrarId: "manual", retryPayload: { domains: "example.com" } });
    expect(results[1]).toEqual({ ok: false, status: "failed" });
  });

  it("restores interrupted submissions without a job id as unconfirmed and preserves retry data", () => {
    const results = restoreOperationResults([
      { ok: true, status: "pending", retryPayload: { domains: "example.com" } },
      { ok: true, status: "queued", requestKey: "ns-key", registrarId: "manual" },
      { ok: true, status: "running", requestKey: "zone-key" },
      { ok: true, status: "retry_wait", requestKey: "retry-key" },
      { ok: true, status: "running", jobId: "job-1" },
      { ok: true, status: "deleted", requestKey: "done-key" },
    ]);
    expect(results.slice(0, 4).map(({ ok, status }) => ({ ok, status }))).toEqual(
      Array.from({ length: 4 }, () => ({ ok: false, status: "unconfirmed" })),
    );
    expect(results[0].retryPayload).toEqual({ domains: "example.com" });
    expect(results[1]).toMatchObject({ requestKey: "ns-key", registrarId: "manual" });
    expect(retryRequestKey(results[1])).toBe("ns-key");
    expect(retryRequestKey(results[2])).toBe("zone-key");
    expect(isProcessingStatus(results[0].status)).toBe(false);
    expect(results[4].status).toBe("running");
    expect(results[5].status).toBe("deleted");
  });

  it("distinguishes rejected submissions from unknown transport outcomes", () => {
    expect(submissionFailureStatus(new ApiError(400, "bad_request", "invalid"))).toBe("failed");
    expect(submissionFailureStatus(new ApiError(0, "request_timeout", "timeout"))).toBe("unconfirmed");
    expect(submissionFailureStatus(new ApiError(500, "internal_error", "error"))).toBe("unconfirmed");
    expect(submissionFailureStatus(new TypeError("offline"))).toBe("unconfirmed");
    expect(retryRequestKey({ status: "unconfirmed", requestKey: "original" })).toBe("original");
    expect(retryRequestKey({ status: "failed", requestKey: "legacy-unknown" })).toBe("legacy-unknown");
  });

  it("starts a new action only for a confirmed failed job and reuses that key after interruption", () => {
    const requestKey = retryRequestKey({ status: "failed", jobId: "failed-job", requestKey: "old-key" });
    expect(requestKey).not.toBe("old-key");
    const [restored] = restoreOperationResults([{ ok: true, status: "queued", requestKey, registrarId: "manual" }]);
    expect(restored.status).toBe("unconfirmed");
    expect(retryRequestKey(restored)).toBe(requestKey);
    expect(restored.registrarId).toBe("manual");
  });
});

describe("API session errors", () => {
  it("preserves HTTP status and code and expires the UI only for session errors", async () => {
    const expired = vi.fn();
    sessionEvents.addEventListener("session-expired", expired);
    const fetch = vi.fn().mockImplementationOnce(() => Promise.resolve(new Response(JSON.stringify({ ok: false, error: { code: "unauthorized", message: "当前密码不正确" } }), { status: 401 })))
      .mockImplementationOnce(() => Promise.resolve(new Response(JSON.stringify({ ok: false, error: { code: "session_expired", message: "登录已过期" } }), { status: 401 })));
    vi.stubGlobal("fetch", fetch);
    await expect(api("/api/auth/password")).rejects.toMatchObject({ status: 401, code: "unauthorized" });
    expect(expired).not.toHaveBeenCalled();
    await expect(api("/api/domains")).rejects.toMatchObject({ status: 401, code: "session_expired" });
    expect(expired).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][1]).toMatchObject({ cache: "no-store" });
    sessionEvents.removeEventListener("session-expired", expired);
  });
});

describe("background polling", () => {
  it("polls running jobs quickly without dragging retry_wait jobs into the same interval", async () => {
    vi.useFakeTimers();
    const nextAttemptAt = new Date(Date.now() + 300_000).toISOString();
    const fetch = vi.fn(async (id: string) => id === "waiting" ? { ...job("retry_wait"), nextAttemptAt } : job("running"));
    const stop = startOperationPolling(["waiting", "running"], fetch, vi.fn(), 3_000);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(fetch.mock.calls.filter(([id]) => id === "waiting")).toHaveLength(1);
    expect(fetch.mock.calls.filter(([id]) => id === "running")).toHaveLength(20);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetch.mock.calls.filter(([id]) => id === "waiting")).toHaveLength(2);
    stop();
  });

  it("stops polling completed and failed jobs", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async (id: string) => job(id === "done" ? "completed" : "failed"));
    const stop = startOperationPolling(["done", "failed"], fetch, vi.fn(), 3_000);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    stop();
  });

  it("preserves a waiting job's schedule when another accepted job joins the list", async () => {
    vi.useFakeTimers();
    const savedState = new Map();
    const fetch = vi.fn(async () => ({ ...job("retry_wait"), nextAttemptAt: new Date(Date.now() + 300_000).toISOString() }));
    const first = startOperationPolling(["waiting"], fetch, vi.fn(), 3_000, undefined, savedState);
    await vi.advanceTimersByTimeAsync(3_000);
    first();
    const second = startOperationPolling(["waiting", "new"], fetch, vi.fn(), 3_000, undefined, savedState);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(fetch.mock.calls).toHaveLength(2);
    second();
  });

  it("pauses a hidden page and refreshes immediately when it becomes visible", async () => {
    vi.useFakeTimers();
    const visibility = Object.assign(new EventTarget(), { hidden: true });
    const fetch = vi.fn().mockResolvedValue(job("running"));
    const stop = startOperationPolling(["job-1"], fetch, vi.fn(), 3_000, visibility);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetch).not.toHaveBeenCalled();
    visibility.hidden = false;
    visibility.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledOnce();
    visibility.hidden = true;
    visibility.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetch).toHaveBeenCalledOnce();
    visibility.hidden = false;
    visibility.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(2);
    stop();
    visibility.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("waits for a slow request to settle before scheduling another", async () => {
    vi.useFakeTimers();
    let finish!: (job: OperationJob) => void;
    const fetch = vi.fn().mockImplementationOnce(() => new Promise<OperationJob>((resolve) => { finish = resolve; })).mockResolvedValue(job("running"));
    const stop = startOperationPolling(["job-1"], fetch, vi.fn(), 3_000);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fetch).toHaveBeenCalledOnce();
    finish(job("running"));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    stop();
  });

  it("stops missing jobs while continuing other jobs", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async (id: string) => { if (id === "missing") throw new ApiError(404, "not_found", "任务不存在"); return job("running"); });
    const errors = vi.fn();
    const stop = startOperationPolling(["missing", "live"], fetch, errors, 3_000);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(fetch.mock.calls.filter(([id]) => id === "missing")).toHaveLength(1);
    expect(fetch.mock.calls.filter(([id]) => id === "live").length).toBeGreaterThan(1);
    expect(errors).toHaveBeenCalledOnce();
    stop();
  });

  it("backs off after network errors and restores the normal interval on recovery", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(job("running"));
    const errors = vi.fn();
    const stop = startOperationPolling(["job-1"], fetch, errors, 3_000);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(fetch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(errors).toHaveBeenCalledOnce();
    stop();
  });

  it("aborts requests and suppresses errors after cleanup", async () => {
    vi.useFakeTimers();
    let signal!: AbortSignal;
    const fetch = vi.fn((_id: string, requestSignal: AbortSignal) => {
      signal = requestSignal;
      return new Promise<OperationJob>((_resolve, reject) => requestSignal.addEventListener("abort", () => reject(new Error("aborted"))));
    });
    const errors = vi.fn();
    const stop = startOperationPolling(["job-1"], fetch, errors, 3_000);
    stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(signal.aborted).toBe(true);
    expect(errors).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();
  });
});

it("excludes hidden selections even when the filtered list has the same length", () => {
  expect(visibleSelection([{ id: "visible" }], ["hidden"])).toEqual([]);
  expect(visibleSelection([{ id: "visible" }], ["hidden", "visible"])).toEqual(["visible"]);
});

it("formats timestamps in the same Shanghai day used by statistics", () => {
  expect(formatDate("2026-10-08T16:01:00Z")).toBe("10/09 00:01");
});

it("keeps waiting jobs between thirty and sixty seconds even after their scheduled retry", () => {
  vi.useFakeTimers();
  expect(operationPollDelay({ ...job("retry_wait"), nextAttemptAt: new Date(Date.now() + 20_000).toISOString() }, 3_000)).toBe(30_000);
  expect(operationPollDelay({ ...job("retry_wait"), nextAttemptAt: new Date(Date.now() + 45_000).toISOString() }, 3_000)).toBe(45_000);
  expect(operationPollDelay({ ...job("retry_wait"), nextAttemptAt: new Date(Date.now() + 300_000).toISOString() }, 3_000)).toBe(60_000);
  expect(operationPollDelay({ ...job("retry_wait"), nextAttemptAt: "invalid" }, 3_000)).toBe(60_000);
  expect(operationPollDelay({ ...job("retry_wait"), nextAttemptAt: new Date(Date.now() - 1).toISOString() }, 3_000)).toBe(30_000);
});

it("derives inclusive retention bounds in Shanghai days", () => {
  const now = Date.parse("2026-10-08T16:01:00Z");
  expect(retainedDateRange(30, now)).toEqual({ days: 30, from: "2026-09-10", to: "2026-10-09" });
  expect(retainedDateRange(1, now)).toEqual({ days: 1, from: "2026-10-09", to: "2026-10-09" });
  expect(retainedDateRange(-1, now).days).toBe(30);
  expect(retainedDateRange(365, now).from).toBe("2025-10-10");
});
