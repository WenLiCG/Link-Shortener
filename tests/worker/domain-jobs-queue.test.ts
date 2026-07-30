import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  claimNextJob,
  completeJob,
  createTarget,
  enqueueJob,
  getJobById,
  recordJobFailure,
} from "../../src/worker/db";
import { hashPasswordForDocs } from "../../src/worker/auth";
import { ProviderError } from "../../src/worker/provider-error";
import type { EnqueueJobInput } from "../../src/worker/shared";
import { processNextJob } from "../../src/worker/automation";

const testEnv = env as Env & { PASSWORD_PEPPER: string };

function jobInput(id: string): EnqueueJobInput {
  return {
    type: "zone_delete",
    subjectType: "domain",
    subjectId: `example-${id}.com`,
    payload: { domain: `example-${id}.com` },
    idempotencyKey: `test:${id}`,
  };
}

async function login(): Promise<string> {
  const password = "correct horse battery staple";
  const hash = await hashPasswordForDocs(password, testEnv.PASSWORD_PEPPER);
  await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('ADMIN_PASSWORD_HASH', ?)").bind(hash).run();
  const response = await SELF.fetch("https://admin.example.com/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.80" },
    body: JSON.stringify({ password }),
  });
  return response.headers.get("set-cookie")!.split(";", 1)[0];
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM job_steps").run();
  await env.DB.prepare("DELETE FROM domain_jobs").run();
  await env.DB.prepare("DELETE FROM redirect_domains").run();
  await env.DB.prepare("DELETE FROM target_services").run();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("durable job queue", () => {
  it("claims only one job globally", async () => {
    await enqueueJob(env.DB, jobInput("claim"));

    const claims = await Promise.all([claimNextJob(env.DB), claimNextJob(env.DB)]);

    expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
  });

  it("deduplicates the same idempotency key", async () => {
    const first = await enqueueJob(env.DB, jobInput("same"));
    const duplicate = await enqueueJob(env.DB, jobInput("same"));

    expect(duplicate.id).toBe(first.id);
  });

  it("retries transient provider errors without blocking newer work", async () => {
    const retrying = await enqueueJob(env.DB, jobInput("retrying"));
    const claim = await claimNextJob(env.DB);
    expect(claim?.id).toBe(retrying.id);

    await expect(recordJobFailure(
      env.DB,
      claim!.id,
      claim!.leaseToken!,
      new ProviderError("cloudflare", 429, "http_429", true, "稍后重试。"),
    )).resolves.toBe("retry_wait");

    const newer = await enqueueJob(env.DB, jobInput("newer"));
    expect((await claimNextJob(env.DB))?.id).toBe(newer.id);
  });

  it("makes permanent failures terminal", async () => {
    const queued = await enqueueJob(env.DB, jobInput("permanent"));
    const claim = await claimNextJob(env.DB);
    expect(claim?.id).toBe(queued.id);

    await expect(recordJobFailure(env.DB, claim!.id, claim!.leaseToken!, new Error("invalid input"))).resolves.toBe("failed");
    expect((await getJobById(env.DB, queued.id))?.status).toBe("failed");
  });

  it("reschedules Nameserver propagation and can claim it when due", async () => {
    const queued = await enqueueJob(env.DB, jobInput("nameserver"));
    const claim = await claimNextJob(env.DB);
    await expect(recordJobFailure(
      env.DB,
      claim!.id,
      claim!.leaseToken!,
      new ProviderError("cloudflare", null, "nameserver_pending", true, "等待 Nameserver 生效。"),
    )).resolves.toBe("retry_wait");

    expect((await getJobById(env.DB, queued.id))?.status).toBe("retry_wait");
    await env.DB.prepare("UPDATE domain_jobs SET next_attempt_at = datetime('now', '-1 second') WHERE id = ?").bind(queued.id).run();
    expect((await claimNextJob(env.DB))?.id).toBe(queued.id);
  });

  it("moves an actual pending Zone provisioning job into retry_wait", async () => {
    await env.DB.prepare(
      `INSERT INTO redirect_domains
       (id, domain, redirect_mode, direct_target_host)
       VALUES ('domain-pending', 'pending.example.com', 'direct', 'https://example.com/')`,
    ).run();
    const queued = await enqueueJob(env.DB, {
      type: "domain_provision",
      subjectType: "redirect_domain",
      subjectId: "domain-pending",
      redirectDomainId: "domain-pending",
      payload: {},
      idempotencyKey: "domain-pending",
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname.includes("dynadot.com")) {
        return new Response(JSON.stringify({ DomainInfoResponse: { ResponseCode: -1, Status: "error" } }));
      }
      if (url.pathname.endsWith("/dns_records") && (init?.method ?? "GET") === "GET") {
        return new Response(JSON.stringify({ success: true, result: [] }));
      }
      if (url.pathname.endsWith("/workers/routes") && (init?.method ?? "GET") === "GET") {
        return new Response(JSON.stringify({ success: true, result: [] }));
      }
      if (url.pathname === "/client/v4/zones/zone-pending") {
        return new Response(JSON.stringify({
          success: true,
          result: { id: "zone-pending", name: "pending.example.com", status: "pending", name_servers: ["a.ns", "b.ns"] },
        }));
      }
      if (url.pathname === "/client/v4/zones" && url.searchParams.has("name")) {
        return new Response(JSON.stringify({
          success: true,
          result: [{ id: "zone-pending", name: "pending.example.com", status: "pending", name_servers: ["a.ns", "b.ns"] }],
        }));
      }
      return new Response(JSON.stringify({ success: true, result: { id: "created" } }));
    });

    await expect(processNextJob(testEnv)).resolves.toBe(true);

    expect((await getJobById(env.DB, queued.id))?.status).toBe("retry_wait");
    await expect(env.DB.prepare(
      "SELECT status, list_visible FROM redirect_domains WHERE id = 'domain-pending'",
    ).first()).resolves.toMatchObject({ status: "waiting_nameserver", list_visible: 0 });
  });

  it("keeps target repair pending until its Zone is active", async () => {
    const created = await createTarget(env.DB, {
      name: "pending target",
      targetHost: "target-pending.example.com",
      forwardTargetHost: null,
      description: "",
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname.includes("dynadot.com")) {
        return new Response(JSON.stringify({ DomainInfoResponse: { ResponseCode: -1, Status: "error" } }));
      }
      if (url.pathname.endsWith("/dns_records") && (init?.method ?? "GET") === "GET") {
        return new Response(JSON.stringify({ success: true, result: [] }));
      }
      if (url.pathname.endsWith("/workers/routes") && (init?.method ?? "GET") === "GET") {
        return new Response(JSON.stringify({ success: true, result: [] }));
      }
      if (url.pathname === "/client/v4/zones/zone-target") {
        return new Response(JSON.stringify({
          success: true,
          result: { id: "zone-target", name: "target-pending.example.com", status: "pending", name_servers: ["a.ns", "b.ns"] },
        }));
      }
      if (url.pathname === "/client/v4/zones" && url.searchParams.has("name")) {
        return new Response(JSON.stringify({
          success: true,
          result: [{ id: "zone-target", name: "target-pending.example.com", status: "pending", name_servers: ["a.ns", "b.ns"] }],
        }));
      }
      return new Response(JSON.stringify({ success: true, result: { id: "created" } }));
    });

    await expect(processNextJob(testEnv)).resolves.toBe(true);

    expect((await getJobById(env.DB, created.jobId))?.status).toBe("retry_wait");
    await expect(env.DB.prepare(
      "SELECT automation_status, nameserver_status FROM target_services WHERE id = ?",
    ).bind(created.target.id).first()).resolves.toMatchObject({
      automation_status: "waiting_nameserver",
      nameserver_status: "waiting",
    });
  });

  it("completes only with the active lease", async () => {
    const queued = await enqueueJob(env.DB, jobInput("complete"));
    const claim = await claimNextJob(env.DB);

    await completeJob(env.DB, queued.id, "wrong-lease");
    expect((await getJobById(env.DB, queued.id))?.status).toBe("running");
    await completeJob(env.DB, queued.id, claim!.leaseToken!);
    expect((await getJobById(env.DB, queued.id))?.status).toBe("completed");
  });
});

describe("host role exclusivity", () => {
  it("creates a target with exactly one queued repair job", async () => {
    const cookie = await login();
    const blocker = await enqueueJob(env.DB, jobInput("target-blocker"));
    await env.DB.prepare(
      `UPDATE domain_jobs
       SET status = 'running',
           lease_token = 'active-lease',
           lease_expires_at = datetime('now', '+10 minutes')
       WHERE id = ?`,
    ).bind(blocker.id).run();

    const response = await SELF.fetch("https://admin.example.com/api/targets", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "target", targetHost: "target.example.com" }),
    });
    const body = await response.json<{ data: { id: string; jobId: string; jobStatus: string } }>();

    expect(response.status).toBe(202);
    expect(body.data.jobStatus).toBe("queued");
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS total FROM domain_jobs WHERE subject_type = 'target_service' AND subject_id = ?",
    ).bind(body.data.id).first("total")).toBe(1);
    expect((await getJobById(env.DB, body.data.jobId))?.status).toBe("queued");
  });

  it("rejects a target host already used as an entry domain", async () => {
    const cookie = await login();
    await env.DB.prepare(
      "INSERT INTO redirect_domains (id, domain, redirect_mode, direct_target_host) VALUES ('domain-1', 'same.example.com', 'direct', 'https://example.com/')",
    ).run();

    const response = await SELF.fetch("https://admin.example.com/api/targets", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "same", targetHost: "same.example.com" }),
    });

    expect(response.status).toBe(409);
  });

  it("rejects an entry domain already used as a target host", async () => {
    const cookie = await login();
    await env.DB.prepare(
      "INSERT INTO target_services (id, name, target_host) VALUES ('target-1', 'same', 'same.example.com')",
    ).run();

    const response = await SELF.fetch("https://admin.example.com/api/domains", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        domains: ["same.example.com"],
        redirectMode: "direct",
        directTargetHost: "https://example.com/",
      }),
    });

    expect(response.status).toBe(409);
  });
});

describe("domain creation idempotency", () => {
  it("reuses the pending job when a hidden domain is submitted again", async () => {
    const cookie = await login();
    await env.DB.prepare(
      `INSERT INTO redirect_domains
       (id, domain, redirect_mode, direct_target_host, list_visible)
       VALUES ('hidden-domain', 'hidden.example.com', 'direct', 'https://example.com/', 0)`,
    ).run();
    const pending = await enqueueJob(env.DB, {
      type: "domain_provision",
      subjectType: "redirect_domain",
      subjectId: "hidden-domain",
      redirectDomainId: "hidden-domain",
      payload: {},
      idempotencyKey: "hidden-domain:initial",
    });
    await env.DB.prepare(
      `UPDATE domain_jobs
       SET status = 'running',
           lease_token = 'active-lease',
           lease_expires_at = datetime('now', '+10 minutes')
       WHERE id = ?`,
    ).bind(pending.id).run();

    const response = await SELF.fetch("https://admin.example.com/api/domains", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        domains: ["hidden.example.com"],
        redirectMode: "direct",
        directTargetHost: "https://example.com/",
      }),
    });
    const body = await response.json<{ data: { results: Array<{ jobId: string }> } }>();

    expect(response.status).toBe(202);
    expect(body.data.results[0].jobId).toBe(pending.id);
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS total FROM domain_jobs WHERE subject_id = 'hidden-domain'",
    ).first("total")).toBe(1);
  });
});
