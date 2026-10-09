import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { processNextJob, runScheduled } from "../../src/worker/automation";
import {
  addJobStep, claimNextJob, cleanupJobSteps, completeJob, createTarget, deleteDomains, deleteTarget, enqueueJob, getJobById,
  recordJobFailure, retryDomain, retryTarget, updateDomainAutomation, updateTargetHealth,
} from "../../src/worker/db";
import { ProviderError } from "../../src/worker/provider-error";

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM job_steps"), env.DB.prepare("DELETE FROM domain_jobs"),
    env.DB.prepare("DELETE FROM traffic_daily_visitors"), env.DB.prepare("DELETE FROM redirect_domains"),
    env.DB.prepare("DELETE FROM target_services"),
  ]);
});
afterEach(() => vi.restoreAllMocks());

async function domain() {
  await env.DB.prepare(`INSERT INTO redirect_domains (id, domain, redirect_mode, direct_target_host, status, list_visible)
    VALUES ('repair', 'repair.example.com', 'direct', 'https://destination.example/', 'active', 1)`).run();
  return retryDomain(env.DB, "repair", "initial");
}

async function expire(jobId: string) {
  await env.DB.prepare("UPDATE domain_jobs SET lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").bind(jobId).run();
}

async function due(jobId: string) {
  await env.DB.prepare("UPDATE domain_jobs SET next_attempt_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").bind(jobId).run();
}

describe("repair requests and crash recovery", () => {
  it("separates passive resubmission, explicit retry and same-key replay", async () => {
    const initial = await domain();
    await env.DB.prepare(`UPDATE domain_jobs SET status = 'retry_wait', current_step = 'waiting_nameserver',
      next_attempt_at = '2999-01-01T00:00:00.000Z' WHERE id = ?`).bind(initial.id).run();
    expect((await retryDomain(env.DB, "repair", "passive")).id).toBe(initial.id);
    expect((await getJobById(env.DB, initial.id))?.nextAttemptAt).toBe("2999-01-01T00:00:00.000Z");
    expect((await retryDomain(env.DB, "repair", "manual", true)).id).toBe(initial.id);
    expect((await getJobById(env.DB, initial.id))?.currentStep).toBe("queued");
    const claimed = await claimNextJob(env.DB);
    expect(claimed?.id).toBe(initial.id);
    await retryDomain(env.DB, "repair", "while-running", true);
    expect((await getJobById(env.DB, initial.id))?.leaseToken).toBe(claimed?.leaseToken);
    await completeJob(env.DB, initial.id, claimed!.leaseToken!);
    const newer = await retryDomain(env.DB, "repair", "new-repair", true);
    expect(newer.id).not.toBe(initial.id);
    expect(await retryDomain(env.DB, "repair", "manual", true)).toEqual({ id: initial.id, status: "completed" });
    expect(await retryDomain(env.DB, "repair", "passive")).toEqual({ id: initial.id, status: "completed" });
  });

  it("reuses initial target repair concurrently and never changes health on replay", async () => {
    const created = await createTarget(env.DB, { name: "target", targetHost: "target.example.com", forwardTargetHost: null, description: "" });
    const jobs = await Promise.all([retryTarget(env.DB, created.target.id, "first"), retryTarget(env.DB, created.target.id, "second")]);
    expect(jobs.map((job) => job.id)).toEqual([created.jobId, created.jobId]);
    const claimed = await claimNextJob(env.DB);
    await completeJob(env.DB, created.jobId, claimed!.leaseToken!);
    await updateTargetHealth(env.DB, created.target.id, { status: "ok", httpStatus: 204, error: null });
    expect((await retryTarget(env.DB, created.target.id, "second")).status).toBe("completed");
    expect(await env.DB.prepare("SELECT health_status FROM target_services WHERE id = ?").bind(created.target.id).first("health_status")).toBe("ok");
  });

  it("supports keys written by an older Worker and rejects a deletion key for repair", async () => {
    const initial = await domain();
    await env.DB.prepare("DELETE FROM job_request_keys WHERE request_key = 'initial'").run();
    expect((await retryDomain(env.DB, "repair", "initial", true)).id).toBe(initial.id);
    await enqueueJob(env.DB, { type: "domain_delete", subjectType: "redirect_domain", subjectId: "repair", payload: {}, idempotencyKey: "delete-key" });
    await expect(retryDomain(env.DB, "repair", "delete-key", true)).rejects.toMatchObject({ status: 409, code: "idempotency_key_conflict" });
  });

  it("gives transient failures their own budget after many successful propagation checks", async () => {
    const initial = await domain();
    await env.DB.prepare("UPDATE domain_jobs SET attempt_count = 100 WHERE id = ?").bind(initial.id).run();
    for (let failure = 1; failure <= 5; failure += 1) {
      const claimed = await claimNextJob(env.DB);
      expect(await recordJobFailure(env.DB, initial.id, claimed!.leaseToken!, new ProviderError("cloudflare", 429, "http_429", true, "later")))
        .toBe(failure < 5 ? "retry_wait" : "failed");
      await due(initial.id);
    }
    expect((await getJobById(env.DB, initial.id))?.failureCount).toBe(5);
  });

  it("stops after three lost leases and lets newer jobs run while preserving active redirects", async () => {
    const initial = await domain();
    for (let loss = 0; loss < 3; loss += 1) {
      const claimed = await claimNextJob(env.DB);
      expect(claimed?.id).toBe(initial.id);
      expect(claimed?.leaseLossCount).toBe(loss);
      await expire(initial.id);
    }
    const newer = await enqueueJob(env.DB, { type: "domain_delete", subjectType: "redirect_domain", subjectId: "absent", payload: {}, idempotencyKey: "newer" });
    expect((await claimNextJob(env.DB))?.id).toBe(newer.id);
    expect((await getJobById(env.DB, initial.id))?.status).toBe("failed");
    expect((await getJobById(env.DB, initial.id))?.leaseLossCount).toBe(3);
    expect(await env.DB.prepare("SELECT status, list_visible FROM redirect_domains WHERE id = 'repair'").first()).toEqual({ status: "active", list_visible: 1 });
  });

  it("keeps old lease holders from writing steps, status or health after reclaim", async () => {
    const initial = await domain();
    const old = await claimNextJob(env.DB);
    await expire(initial.id);
    const current = await claimNextJob(env.DB);
    await expect(addJobStep(env.DB, initial.id, "stale", "completed", undefined, undefined, old!.leaseToken!)).rejects.toThrow("job_lease_lost");
    await expect(updateDomainAutomation(env.DB, "repair", { lastError: "stale" }, old!)).rejects.toThrow("job_lease_lost");
    expect((await getJobById(env.DB, initial.id))?.leaseToken).toBe(current?.leaseToken);
    const target = await createTarget(env.DB, { name: "t", targetHost: "t.example.com", forwardTargetHost: null, description: "" });
    await expect(updateTargetHealth(env.DB, target.target.id, { status: "failed", httpStatus: 503, error: "stale" }, old!)).rejects.toThrow("job_lease_lost");
    expect(await deleteDomains(env.DB, ["repair"], old!)).toBe(0);
    expect((await deleteTarget(env.DB, target.target.id, target.target.targetHost, old!)).deleted).toBe(false);
  });

  it("does not release a canceled task lease until its provider call settles", async () => {
    const controller = new AbortController();
    const initial = await enqueueJob(env.DB, { type: "nameserver_connect", subjectType: "domain", subjectId: "cancel.example.com", payload: {}, idempotencyKey: "cancel" });
    let rejectFetch: (error: Error) => void = () => undefined;
    let entered: () => void = () => undefined;
    const fetching = new Promise<void>((resolve) => { entered = resolve; });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => new Promise<Response>((_resolve, reject) => {
      rejectFetch = reject;
      expect(init?.signal).toBeDefined();
      entered();
    }));
    const running = processNextJob(env, controller.signal);
    await fetching;
    controller.abort(new DOMException("budget", "TimeoutError"));
    expect((await getJobById(env.DB, initial.id))?.status).toBe("running");
    expect(await claimNextJob(env.DB)).toBeNull();
    rejectFetch(new DOMException("canceled", "AbortError"));
    await running;
    expect((await getJobById(env.DB, initial.id))?.status).toBe("retry_wait");
    expect((await getJobById(env.DB, initial.id))?.leaseToken).toBeNull();
    expect((await getJobById(env.DB, initial.id))?.errorMessage).toContain("任务执行超时");
  });

  it("cleans only old terminal steps and retains their replay keys and results", async () => {
    const initial = await domain();
    const claimed = await claimNextJob(env.DB);
    await addJobStep(env.DB, initial.id, "done", "completed", undefined, undefined, claimed!.leaseToken!);
    await completeJob(env.DB, initial.id, claimed!.leaseToken!);
    await env.DB.prepare("UPDATE domain_jobs SET finished_at = '2000-01-01T00:00:00.000Z', payload = '{\"result\":{\"done\":true}}' WHERE id = ?").bind(initial.id).run();
    await cleanupJobSteps(env.DB);
    expect((await getJobById(env.DB, initial.id))?.steps).toEqual([]);
    expect((await getJobById(env.DB, initial.id))?.payload.result).toEqual({ done: true });
    expect((await retryDomain(env.DB, "repair", "initial", true)).id).toBe(initial.id);
  });

  it("drains at most two jobs per cron without running maintenance health calls", async () => {
    for (let i = 0; i < 3; i += 1) await enqueueJob(env.DB, {
      type: "domain_delete", subjectType: "redirect_domain", subjectId: `absent-${i}`, payload: {}, idempotencyKey: `drain-${i}`,
    });
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected network"));
    await runScheduled(env);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM domain_jobs WHERE status = 'completed'").first("n")).toBe(2);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM domain_jobs WHERE status = 'queued'").first("n")).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
  });
});
