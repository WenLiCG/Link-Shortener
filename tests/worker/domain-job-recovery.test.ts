import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { processNextJob } from "../../src/worker/automation";
import { claimNextJob, createTarget, enqueueJob, getJobById, recordJobFailure, retryDomain } from "../../src/worker/db";
import { ProviderError } from "../../src/worker/provider-error";

const host = "recovery.example.com";
const withDynadot = { ...env, DYNADOT_API_KEY: "test-key" } as Env;
const withoutDynadot = { ...env, DYNADOT_API_KEY: "" } as Env;

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM job_steps"),
    env.DB.prepare("DELETE FROM domain_jobs"),
    env.DB.prepare("DELETE FROM traffic_daily_visitors"),
    env.DB.prepare("DELETE FROM redirect_domains"),
    env.DB.prepare("DELETE FROM target_services"),
  ]);
});

afterEach(() => vi.restoreAllMocks());

async function domain(active = false) {
  await env.DB.prepare(
    `INSERT INTO redirect_domains (id, domain, redirect_mode, direct_target_host, status, list_visible)
     VALUES ('recovery', ?, 'direct', 'https://destination.example/', ?, ?)`,
  ).bind(host, active ? "active" : "pending", active ? 1 : 0).run();
}

async function provision() {
  return enqueueJob(env.DB, {
    type: "domain_provision", subjectType: "redirect_domain", subjectId: "recovery",
    redirectDomainId: "recovery", payload: {}, idempotencyKey: "provision:recovery",
  });
}

async function due(jobId: string) {
  await env.DB.prepare("UPDATE domain_jobs SET next_attempt_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").bind(jobId).run();
}

function providers(beforeRequest?: (url: URL) => Promise<void>) {
  const state = { status: "pending", zoneId: "zone-recovery", failZoneRead: false };
  const requests: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    requests.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
    await beforeRequest?.(url);
    if (url.hostname === host) return new Response(null, { status: 204 });
    if (url.hostname.includes("dynadot.com")) {
      return Response.json({ Response: { ResponseCode: 0, Status: "success" } });
    }
    const zone = { id: state.zoneId, name: host, status: state.status, name_servers: ["a.ns", "b.ns"] };
    if (url.pathname === "/client/v4/zones") return Response.json({ success: true, result: url.searchParams.get("name") === zone.name ? [zone] : [] });
    if (/\/zones\/[^/]+$/.test(url.pathname)) {
      if (state.failZoneRead) return new Response("denied", { status: 403 });
      if (!url.pathname.endsWith(`/${state.zoneId}`)) return new Response("missing", { status: 404 });
      return Response.json({ success: true, result: zone });
    }
    if (url.pathname.endsWith("/dns_records") && !init?.method) {
      return Response.json({ success: true, result: url.searchParams.get("type") === "A"
        ? [{ id: "dns", type: "A", name: url.searchParams.get("name"), content: "192.0.2.1", proxied: true }] : [] });
    }
    if (url.pathname.endsWith("/workers/routes") && !init?.method) {
      return Response.json({ success: true, result: [host, `*.${host}`].map((name) => ({
        id: name, pattern: `${name}/*`, script: env.WORKER_SCRIPT_NAME,
      })) });
    }
    return Response.json({ success: true, result: { id: "created" } });
  });
  return { state, requests };
}

describe("domain job recovery", () => {
  it("reuses an ancestor Zone for entry subdomains without changing registrar nameservers", async () => {
    await domain();
    const childHost = `entry.${host}`;
    await env.DB.prepare("UPDATE redirect_domains SET domain = ? WHERE id = 'recovery'").bind(childHost).run();
    const job = await provision();
    const upstream = providers();
    await processNextJob(withDynadot);
    expect(upstream.requests.some((request) => request.includes("api3.json"))).toBe(false);
    expect(upstream.requests.some((request) => request === "POST /client/v4/zones")).toBe(false);
    expect(await env.DB.prepare("SELECT dynadot_status FROM redirect_domains WHERE id = 'recovery'").first("dynadot_status")).toBe("inherited_zone");
    upstream.requests.length = 0;
    upstream.state.status = "active";
    await due(job.id);
    await processNextJob(withDynadot);
    expect(upstream.requests).toEqual(["GET /client/v4/zones/zone-recovery"]);
    expect((await SELF.fetch(`https://${childHost}/`, { redirect: "manual" })).status).toBe(302);
  });

  it.each([false, true])("keeps active redirects serving through configuration (provider failure: %s)", async (fail) => {
    await domain(true);
    const job = await retryDomain(env.DB, "recovery", "repair-active");
    const upstream = providers(async () => {
      expect(await env.DB.prepare("SELECT status, list_visible FROM redirect_domains WHERE id = 'recovery'").first())
        .toEqual({ status: "active", list_visible: 1 });
    });
    upstream.state.status = "active";
    upstream.state.failZoneRead = fail;
    expect((await SELF.fetch(`https://${host}/`, { redirect: "manual" })).status).toBe(302);
    await processNextJob(env);
    expect((await getJobById(env.DB, job.id))?.status).toBe(fail ? "failed" : "completed");
    expect((await SELF.fetch(`https://${host}/`, { redirect: "manual" })).status).toBe(302);
    expect(upstream.requests.some((request) => request.includes("/dns_records"))).toBe(true);
  });

  it("atomically reuses a pending provision and concurrent retry requests", async () => {
    await domain();
    const initial = await provision();
    expect((await retryDomain(env.DB, "recovery", "retry-provision")).id).toBe(initial.id);
    await env.DB.prepare("UPDATE domain_jobs SET status = 'failed' WHERE id = ?").bind(initial.id).run();
    const [first, second] = await Promise.all([
      retryDomain(env.DB, "recovery", "retry-one"), retryDomain(env.DB, "recovery", "retry-two"),
    ]);
    expect(first.id).toBe(second.id);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM domain_jobs WHERE status IN ('queued','running','retry_wait')").first("n")).toBe(1);
  });

  it("does not reset the domain when an old idempotency key is replayed", async () => {
    await domain();
    const initial = await retryDomain(env.DB, "recovery", "same-retry");
    await env.DB.batch([
      env.DB.prepare("UPDATE domain_jobs SET status = 'completed' WHERE id = ?").bind(initial.id),
      env.DB.prepare("UPDATE redirect_domains SET status = 'active', list_visible = 1 WHERE id = 'recovery'"),
    ]);
    expect(await retryDomain(env.DB, "recovery", "same-retry")).toEqual({ id: initial.id, status: "completed" });
    expect((await SELF.fetch(`https://${host}/`, { redirect: "manual" })).status).toBe(302);
  });

  it("submits NS once, polls only the Zone while waiting, then completes on activation", async () => {
    await domain();
    const job = await provision();
    const upstream = providers();
    await processNextJob(withDynadot);
    expect(upstream.requests.filter((request) => request.includes("command=set_ns"))).toHaveLength(1);
    expect(await env.DB.prepare("SELECT nameserver_status FROM redirect_domains WHERE id = 'recovery'").first("nameserver_status")).toBe("submitted");
    expect((await getJobById(env.DB, job.id))?.status).toBe("retry_wait");
    upstream.requests.length = 0;
    await due(job.id);
    await processNextJob(withDynadot);
    expect(upstream.requests).toEqual(["GET /client/v4/zones/zone-recovery"]);
    upstream.requests.length = 0;
    upstream.state.status = "active";
    await due(job.id);
    await processNextJob(withDynadot);
    expect(upstream.requests).toEqual(["GET /client/v4/zones/zone-recovery"]);
    expect((await getJobById(env.DB, job.id))?.status).toBe("completed");
    expect((await SELF.fetch(`https://${host}/`, { redirect: "manual" })).status).toBe(302);
  });

  it("preserves manual NS instructions and performs full repair for a replacement Zone", async () => {
    await domain();
    const job = await provision();
    const upstream = providers();
    await processNextJob(withoutDynadot);
    expect(await env.DB.prepare("SELECT nameserver_status FROM redirect_domains WHERE id = 'recovery'").first("nameserver_status")).toBe("manual_required");
    upstream.requests.length = 0;
    upstream.state.zoneId = "replacement-zone";
    await due(job.id);
    await processNextJob(withoutDynadot);
    expect(upstream.requests.some((request) => request.includes("/replacement-zone/dns_records"))).toBe(true);
    expect(await env.DB.prepare("SELECT cloudflare_zone_id FROM redirect_domains WHERE id = 'recovery'").first("cloudflare_zone_id")).toBe("replacement-zone");
  });

  it("checks DNS and routes again on the first attempt of an explicit repair", async () => {
    await domain();
    const initial = await provision();
    const upstream = providers();
    await processNextJob(withDynadot);
    await env.DB.prepare("UPDATE domain_jobs SET status = 'failed' WHERE id = ?").bind(initial.id).run();
    await retryDomain(env.DB, "recovery", "explicit-repair");
    upstream.requests.length = 0;
    await processNextJob(withDynadot);
    expect(upstream.requests.some((request) => request.includes("/dns_records"))).toBe(true);
    expect(upstream.requests.some((request) => request.includes("/workers/routes"))).toBe(true);
    expect(upstream.requests.some((request) => request.includes("command=set_ns"))).toBe(false);
  });

  it("does not treat stale configured flags as a completed repair after a route failure", async () => {
    await domain(true);
    await env.DB.prepare(
      `UPDATE redirect_domains SET cloudflare_zone_id = 'zone-recovery', cloudflare_zone_status = 'pending',
         cloudflare_nameservers = '["a.ns","b.ns"]', nameserver_status = 'submitted',
         dns_status = 'configured', route_status = 'configured' WHERE id = 'recovery'`,
    ).run();
    const job = await retryDomain(env.DB, "recovery", "repair-stale-flags");
    let failRoutes = true;
    const upstream = providers(async (url) => {
      if (failRoutes && url.pathname.endsWith("/workers/routes")) {
        failRoutes = false;
        throw new Error("temporary route outage");
      }
    });
    await processNextJob(withDynadot);
    expect((await getJobById(env.DB, job.id))?.status).toBe("retry_wait");
    expect((await getJobById(env.DB, job.id))?.currentStep).toBe("route_configured");
    upstream.requests.length = 0;
    await due(job.id);
    await processNextJob(withDynadot);
    expect(upstream.requests.some((request) => request.includes("/dns_records"))).toBe(true);
    expect(upstream.requests.some((request) => request.includes("/workers/routes"))).toBe(true);
    expect((await getJobById(env.DB, job.id))?.currentStep).toBe("waiting_nameserver");
  });

  it.each([false, true])("makes an expired propagation job terminal without disabling an active domain (%s)", async (active) => {
    await domain(active);
    const job = await provision();
    await env.DB.prepare("UPDATE domain_jobs SET created_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").bind(job.id).run();
    providers();
    await processNextJob(env);
    expect((await getJobById(env.DB, job.id))?.status).toBe("failed");
    expect(await env.DB.prepare("SELECT status FROM redirect_domains WHERE id = 'recovery'").first("status")).toBe(active ? "active" : "failed");
    expect((await getJobById(env.DB, job.id))?.errorMessage).toContain("48 小时");
  });

  it("does not apply terminal subject changes with a stale lease", async () => {
    await domain();
    const job = await provision();
    await env.DB.prepare("UPDATE domain_jobs SET created_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").bind(job.id).run();
    const claimed = await claimNextJob(env.DB);
    await recordJobFailure(env.DB, job.id, "stale", new ProviderError("cloudflare", null, "nameserver_pending", true, "waiting"));
    expect((await getJobById(env.DB, job.id))?.leaseToken).toBe(claimed?.leaseToken);
    expect(await env.DB.prepare("SELECT status FROM redirect_domains WHERE id = 'recovery'").first("status")).toBe("pending");
  });

  it("keeps target NS submission status and makes expiration terminal", async () => {
    const created = await createTarget(env.DB, { name: "recovery", targetHost: host, forwardTargetHost: null, description: "" });
    const upstream = providers();
    await processNextJob(withDynadot);
    expect(await env.DB.prepare("SELECT nameserver_status FROM target_services WHERE id = ?").bind(created.target.id).first("nameserver_status")).toBe("submitted");
    upstream.requests.length = 0;
    await env.DB.prepare("UPDATE domain_jobs SET created_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").bind(created.jobId).run();
    await due(created.jobId);
    await processNextJob(withDynadot);
    expect(upstream.requests.some((request) => request.includes("command=set_ns"))).toBe(false);
    expect((await getJobById(env.DB, created.jobId))?.status).toBe("failed");
    expect(await env.DB.prepare("SELECT automation_status FROM target_services WHERE id = ?").bind(created.target.id).first("automation_status")).toBe("failed");
  });

  it("polls only the target Zone until activation and then checks target health", async () => {
    const created = await createTarget(env.DB, { name: "recovery", targetHost: host, forwardTargetHost: null, description: "" });
    const upstream = providers();
    await processNextJob(withDynadot);
    upstream.requests.length = 0;
    await due(created.jobId);
    await processNextJob(withDynadot);
    expect(upstream.requests).toEqual(["GET /client/v4/zones/zone-recovery"]);
    expect(await env.DB.prepare("SELECT nameserver_status FROM target_services WHERE id = ?").bind(created.target.id).first("nameserver_status")).toBe("submitted");
    upstream.requests.length = 0;
    upstream.state.status = "active";
    await due(created.jobId);
    await processNextJob(withDynadot);
    expect(upstream.requests).toEqual(["GET /client/v4/zones/zone-recovery", "HEAD /"]);
    expect((await getJobById(env.DB, created.jobId))?.status).toBe("completed");
    expect(await env.DB.prepare("SELECT health_status FROM target_services WHERE id = ?").bind(created.target.id).first("health_status")).toBe("ok");
  });

  it("checks target configuration on explicit repair and recovers after Zone replacement", async () => {
    const created = await createTarget(env.DB, { name: "recovery", targetHost: host, forwardTargetHost: null, description: "" });
    const upstream = providers();
    await processNextJob(withoutDynadot);
    await env.DB.prepare("UPDATE domain_jobs SET status = 'failed' WHERE id = ?").bind(created.jobId).run();
    const explicit = await enqueueJob(env.DB, {
      type: "target_repair", subjectType: "target_service", subjectId: created.target.id,
      payload: {}, idempotencyKey: "explicit-target-repair",
    });
    upstream.requests.length = 0;
    await processNextJob(withoutDynadot);
    expect(upstream.requests.some((request) => request.includes("/dns_records"))).toBe(true);
    expect(upstream.requests.some((request) => request.includes("/workers/routes"))).toBe(true);
    expect(await env.DB.prepare("SELECT nameserver_status FROM target_services WHERE id = ?").bind(created.target.id).first("nameserver_status")).toBe("skipped_missing_key");
    upstream.requests.length = 0;
    upstream.state.zoneId = "replacement-target-zone";
    await due(explicit.id);
    await processNextJob(withoutDynadot);
    expect(upstream.requests.some((request) => request.includes("/replacement-target-zone/dns_records"))).toBe(true);
    expect(await env.DB.prepare("SELECT cloudflare_zone_id FROM target_services WHERE id = ?").bind(created.target.id).first("cloudflare_zone_id")).toBe("replacement-target-zone");
  });
});
