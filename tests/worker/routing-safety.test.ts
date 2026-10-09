import { createExecutionContext, env, SELF, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleApi } from "../../src/worker/api";
import { createSessionCookie, recordLoginFailure, requireSession } from "../../src/worker/auth";
import { deleteZoneByName } from "../../src/worker/cloudflare";
import { enqueueJob } from "../../src/worker/db";
import { processNextJob } from "../../src/worker/automation";

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM domain_jobs"),
    env.DB.prepare("DELETE FROM short_links"),
    env.DB.prepare("DELETE FROM redirect_domains"),
    env.DB.prepare("DELETE FROM target_services"),
    env.DB.prepare("DELETE FROM settings"),
    env.DB.prepare("INSERT INTO settings (key, value) VALUES ('ADMIN_PASSWORD_HASH', 'session-test')"),
  ]);
});

afterEach(() => vi.restoreAllMocks());

async function target(host = "short.example.net"): Promise<void> {
  await env.DB.prepare("INSERT INTO target_services (id, name, target_host) VALUES ('relay', 'relay', ?)").bind(host).run();
}

function mockZone(name = "unused.example.org") {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => new Response(JSON.stringify({
    success: true,
    result: init?.method === "DELETE" ? { id: "zone" } : [{ id: "zone", name, status: "active" }],
  })));
}

describe("forward routing", () => {
  it("lists hidden failed domains only when explicitly requested and keeps them unroutable", async () => {
    await env.DB.prepare("INSERT INTO redirect_domains (id, domain, status, list_visible, redirect_mode, direct_target_host) VALUES ('hidden', 'hidden.example.net', 'failed', 0, 'direct', 'https://destination.example/')").run();
    const cookie = (await createSessionCookie(env)).split(";", 1)[0];
    async function list(query: string) {
      const response = await handleApi(new Request(`https://admin.example.com/api/domains?${query}`, { headers: { cookie } }), env, {} as ExecutionContext);
      return (await response.json<{ data: Array<{ id: string }> }>()).data;
    }
    expect(await list("status=failed")).toEqual([]);
    expect(await list("status=failed&includeHidden=true")).toEqual([expect.objectContaining({ id: "hidden" })]);
    expect((await SELF.fetch("https://hidden.example.net/", { redirect: "manual" })).status).toBe(404);
    await expect(handleApi(new Request("https://admin.example.com/api/domains?includeHidden=true"), env, {} as ExecutionContext)).rejects.toMatchObject({ status: 401 });
  });

  it("returns lightweight job status without executing queued work or exposing the lease", async () => {
    const job = await enqueueJob(env.DB, { type: "zone_delete", subjectType: "domain", subjectId: "read.example", payload: { domain: "read.example" }, idempotencyKey: "read-only" });
    await env.DB.prepare("INSERT INTO job_steps (id, job_id, step, status, message) VALUES ('step', ?, 'queued', 'ok', 'History')").bind(job.id).run();
    const cookie = (await createSessionCookie(env)).split(";", 1)[0];
    const ctx = createExecutionContext();
    const response = await handleApi(new Request(`https://admin.example.com/api/jobs/${job.id}`, { headers: { cookie } }), env, ctx);
    await waitOnExecutionContext(ctx);
    const { data } = await response.json<{ data: Record<string, unknown> }>();
    expect(data).toMatchObject({ status: "queued", steps: [] });
    expect(data).not.toHaveProperty("leaseToken");
    expect(await env.DB.prepare("SELECT attempt_count FROM domain_jobs WHERE id = ?").bind(job.id).first("attempt_count")).toBe(0);
  });

  it("keeps an empty configured forward target unavailable", async () => {
    await target();
    await env.DB.prepare(
      `INSERT INTO redirect_domains (id, domain, target_service_id, redirect_mode, target_forward_host, status)
       VALUES ('empty', 'empty.example.net', 'relay', 'target_service_forward', '', 'active')`,
    ).run();
    expect((await SELF.fetch("https://short.example.net/go/empty", { redirect: "manual" })).status).toBe(404);
  });

  it.each([0, 1])("respects hideReferer=%s through both redirects", async (hideReferer) => {
    await target();
    await env.DB.prepare(
      `INSERT INTO redirect_domains
       (id, domain, target_service_id, redirect_mode, target_forward_host, hide_referer, status, list_visible)
       VALUES ('entry', 'entry.example.net', 'relay', 'target_service_forward', 'https://destination.example/path?q=1', ?, 'active', 1)`,
    ).bind(hideReferer).run();
    const first = await SELF.fetch("https://entry.example.net/", { redirect: "manual" });
    expect(first.status).toBe(302);
    expect(first.headers.get("location")).toBe("https://short.example.net/go/entry");
    expect(first.headers.get("referrer-policy")).toBe(hideReferer ? "no-referrer" : null);
    const second = await SELF.fetch(first.headers.get("location")!, { redirect: "manual" });
    expect(second.status).toBe(302);
    expect(second.headers.get("location")).toBe("https://destination.example/path?q=1");
    expect(second.headers.get("referrer-policy")).toBe(hideReferer ? "no-referrer" : null);
  });

  it("rejects biased random bytes and still creates a full short code", async () => {
    await target();
    const cookie = (await createSessionCookie(env)).split(";", 1)[0];
    let call = 0;
    const random = vi.spyOn(crypto, "getRandomValues").mockImplementation((array) => {
      if (!(array instanceof Uint8Array)) throw new Error("unexpected random buffer");
      array.set(call++ === 0 ? [228, 255, 0, 56, 57, 113] : [114, 171, 0, 0, 0, 0]);
      return array;
    });
    const response = await handleApi(new Request("https://admin.example.com/api/short-links", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ targetServiceId: "relay", url: "https://destination.example/" }),
    }), env, {} as ExecutionContext);
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ data: { code: "A9A9AA" } });
    expect(random).toHaveBeenCalledTimes(2);
  });

  it("reports conflicting hidden-domain configuration without changing it", async () => {
    await env.DB.prepare(
      `INSERT INTO redirect_domains (id, domain, redirect_mode, direct_target_host, list_visible)
       VALUES ('existing', 'existing.example.net', 'direct', 'https://old.example/', 0)`,
    ).run();
    const cookie = (await createSessionCookie(env)).split(";", 1)[0];
    const response = await handleApi(new Request("https://admin.example.com/api/domains", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ domains: ["existing.example.net"], redirectMode: "direct", directTargetHost: "https://new.example/" }),
    }), env, {} as ExecutionContext);
    await expect(response.json()).resolves.toMatchObject({ data: { results: [{ ok: false, error: expect.stringContaining("配置不同") }] } });
    expect(await env.DB.prepare("SELECT direct_target_host FROM redirect_domains WHERE id='existing'").first("direct_target_host")).toBe("https://old.example/");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM domain_jobs").first("n")).toBe(0);
  });

  it("starts a new explicit retry after failure while replaying a supplied key", async () => {
    await env.DB.prepare(
      `INSERT INTO redirect_domains (id, domain, redirect_mode, direct_target_host, status, last_checked_at)
       VALUES ('retryable', 'retryable.example.net', 'direct', 'https://destination.example/', 'failed', '2026-01-01T00:00:00Z')`,
    ).run();
    const blocker = await enqueueJob(env.DB, { type: "zone_delete", subjectType: "domain", subjectId: "blocker.example", payload: {}, idempotencyKey: "blocker" });
    await env.DB.prepare("UPDATE domain_jobs SET status = 'running', lease_expires_at = '2999-01-01T00:00:00Z' WHERE id = ?").bind(blocker.id).run();
    const cookie = (await createSessionCookie(env)).split(";", 1)[0];
    async function retry(key?: string) {
      const ctx = createExecutionContext();
      const response = await handleApi(new Request("https://admin.example.com/api/domains/retryable/retry", {
        method: "POST", headers: { cookie, ...(key ? { "idempotency-key": key } : {}) },
      }), env, ctx);
      await waitOnExecutionContext(ctx);
      return (await response.json<{ data: { jobId: string; status: string } }>()).data;
    }
    const first = await retry();
    await env.DB.prepare("UPDATE domain_jobs SET status = 'failed' WHERE id = ?").bind(first.jobId).run();
    const next = await retry("explicit-repair");
    expect(next.jobId).not.toBe(first.jobId);
    await env.DB.prepare("UPDATE domain_jobs SET status = 'failed' WHERE id = ?").bind(next.jobId).run();
    expect(await retry("explicit-repair")).toEqual({ jobId: next.jobId, status: "failed" });
    expect((await retry()).jobId).not.toBe(next.jobId);
  });
});

describe("Zone deletion protection", () => {
  it("protects the admin host's parent Zone", async () => {
    const fetch = mockZone("example.com");
    await expect(deleteZoneByName(env, "example.com")).rejects.toMatchObject({ code: "zone_in_use", retryable: false });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["entry", "target"])("protects a shared Zone used by a %s subdomain", async (kind) => {
    if (kind === "target") await target("short.shared.example.org");
    else await env.DB.prepare(
      "INSERT INTO redirect_domains (id, domain, redirect_mode, direct_target_host) VALUES ('entry', 'entry.shared.example.org', 'direct', 'https://destination.example/')",
    ).run();
    const fetch = mockZone("shared.example.org");
    await expect(deleteZoneByName(env, "shared.example.org")).rejects.toMatchObject({ code: "zone_in_use", retryable: false });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("checks dependencies when a queued deletion executes", async () => {
    const job = await enqueueJob(env.DB, { type: "zone_delete", subjectType: "domain", subjectId: "shared.example.org", payload: { domain: "shared.example.org" }, idempotencyKey: "delete-shared" });
    await target("new.shared.example.org");
    const fetch = mockZone("shared.example.org");
    await processNextJob(env);
    expect(await env.DB.prepare("SELECT status FROM domain_jobs WHERE id = ?").bind(job.id).first("status")).toBe("failed");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await env.DB.prepare("SELECT id FROM target_services WHERE id = 'relay'").first("id")).toBe("relay");
  });

  it("protects a long Zone without exceeding D1's LIKE pattern limit", async () => {
    const zone = `${"a".repeat(60)}.org`;
    await target(`short.${zone}`);
    const fetch = mockZone(zone);
    await expect(deleteZoneByName(env, zone)).rejects.toMatchObject({ code: "zone_in_use", retryable: false });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("allows unused Zones and does not confuse a similar hostname", async () => {
    await target("short.notunused.example.org");
    const fetch = mockZone();
    await expect(deleteZoneByName(env, "unused.example.org")).resolves.toMatchObject({ deleted: true });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][1]?.method).toBe("DELETE");
  });
});

describe("authentication boundaries", () => {
  it.each(["2026-02-30", "2026-13-01", "not-a-date"])("rejects a nonexistent calendar date (%s)", async (date) => {
    const cookie = (await createSessionCookie(env)).split(";", 1)[0];
    await expect(handleApi(new Request(`https://admin.example.com/api/domains?visitedFrom=${date}`, {
      headers: { cookie },
    }), env, {} as ExecutionContext)).rejects.toMatchObject({ status: 400, code: "bad_request" });
  });
  it.each(["-1", "0", "1.5", "invalid"])("reports the effective retention for invalid value %s", async (value) => {
    const cookie = (await createSessionCookie(env)).split(";", 1)[0];
    const response = await handleApi(new Request("https://admin.example.com/api/settings/check", { headers: { cookie } }), {
      ...env, VISIT_EVENT_RETENTION_DAYS: value,
    } as Env, {} as ExecutionContext);
    await expect(response.json()).resolves.toMatchObject({ data: { visitEventRetentionDays: 30 } });
  });

  it("treats a crypto verification rejection as an invalid session", async () => {
    vi.spyOn(crypto.subtle, "verify").mockRejectedValue(new Error("verification unavailable"));
    await expect(requireSession(new Request("https://admin.example.com/api/me", {
      headers: { cookie: "lsm_session=e30.AA" },
    }), env)).rejects.toMatchObject({ status: 401, code: "session_expired" });
  });

  it("expires a session exactly at its expiry timestamp", async () => {
    const cookie = (await createSessionCookie(env)).split(";", 1)[0];
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 12 * 60 * 60_000);
    await expect(requireSession(new Request("https://admin.example.com/api/me", { headers: { cookie } }), env)).rejects.toMatchObject({ code: "session_expired" });
  });

  it("removes failures older than one day using comparable timestamps", async () => {
    await env.DB.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('login_fail:old', '{}', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-25 hours'))").run();
    await recordLoginFailure(new Request("https://admin.example.com/api/auth/login", { headers: { "cf-connecting-ip": "192.0.2.201" } }), env);
    expect(await env.DB.prepare("SELECT key FROM settings WHERE key = 'login_fail:old'").first()).toBeNull();
  });
});
