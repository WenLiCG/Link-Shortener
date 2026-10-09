import { type CloudflareZone, deleteZoneByName, ensureDnsRecords, ensureWorkerRoutes, ensureZone, findBestZoneForHost, getZone } from "./cloudflare";
import {
  addJobStep,
  claimNextJob,
  cleanupVisits,
  cleanupJobSteps,
  completeJob,
  deleteDomains,
  deleteTarget,
  getDomainById,
  getTargetById,
  recordJobFailure,
  setJobResult,
  updateDomainAutomation,
} from "./db";
import { isDomainInDynadot, setNameservers } from "./dynadot";
import { secret } from "./env-utils";
import { ProviderError } from "./provider-error";
import { type DomainJob, domainMatchesHost, isValidDomain } from "./shared";
import { repairTargetService } from "./target-automation";
import { refreshStaleTargetHealth } from "./target-health";

async function step(db: D1Database, job: DomainJob, name: string, signal: AbortSignal, fn: () => Promise<void>): Promise<void> {
  signal.throwIfAborted();
  await addJobStep(db, job.id, name, "running", undefined, undefined, job.leaseToken!);
  try {
    await fn();
    signal.throwIfAborted();
    await addJobStep(db, job.id, name, "completed", undefined, undefined, job.leaseToken!);
  } catch (error) {
    const message = error instanceof ProviderError ? error.message : "任务步骤失败。";
    await addJobStep(db, job.id, name, "failed", message, undefined, job.leaseToken!);
    throw error;
  }
}

async function processDomainJob(env: Env, job: DomainJob, signal: AbortSignal): Promise<Record<string, unknown>> {
  const domainId = job.redirectDomainId;
  if (!domainId) {
    throw new Error("missing_redirect_domain_id");
  }
  const domain = await getDomainById(env.DB, domainId);
  if (!domain) {
    throw new Error("domain_not_found");
  }

  try {
    let zoneId = domain.cloudflareZoneId;
    let zoneName = domain.domain;
    let nameservers = domain.cloudflareNameservers;
    let propagationZone: CloudflareZone | null = null;
    if (job.attemptCount > 1 && job.currentStep === "waiting_nameserver"
      && zoneId && domain.cloudflareZoneStatus === "pending"
      && (domain.status === "waiting_nameserver" || domain.status === "active")
      && domain.dnsStatus === "configured" && domain.routeStatus === "configured") {
      try {
        const zone = await getZone(env, zoneId, signal);
        if (zone.id === zoneId && domainMatchesHost(zone.name, domain.domain)
          && [...zone.nameServers].sort().join() === [...nameservers].sort().join()) {
          propagationZone = zone;
        }
      } catch (error) {
        if (!(error instanceof ProviderError && error.status === 404)) {
          throw error;
        }
      }
    }

    if (!propagationZone) await step(env.DB, job, "validating", signal, async () => {
      if (!isValidDomain(domain.domain)) {
        throw new Error("invalid_domain");
      }
      await updateDomainAutomation(env.DB, domain.id, {
        status: "cloudflare_zone",
        lastError: null,
        listVisible: false,
      }, job);
    });

    if (!propagationZone) await step(env.DB, job, "cloudflare_zone", signal, async () => {
      const zone = await findBestZoneForHost(env, domain.domain, signal) ?? await ensureZone(env, domain.domain, signal);
      zoneId = zone.id;
      zoneName = zone.name;
      nameservers = zone.nameServers;
      await updateDomainAutomation(env.DB, domain.id, {
        status: "nameserver_update",
        cloudflareZoneId: zone.id,
        cloudflareZoneStatus: zone.status,
        cloudflareNameservers: zone.nameServers,
      }, job);
    });

    if (!propagationZone) await step(env.DB, job, "nameserver_update", signal, async () => {
      if (zoneName !== domain.domain) {
        await updateDomainAutomation(env.DB, domain.id, {
          nameserverStatus: "waiting", dynadotStatus: "inherited_zone",
        }, job);
        return;
      }
      if (nameservers.length === 0) {
        throw new Error("cloudflare_nameservers_missing");
      }
      const sameNameservers = domain.cloudflareZoneId === zoneId
        && [...domain.cloudflareNameservers].sort().join() === [...nameservers].sort().join();
      if (sameNameservers && (domain.nameserverStatus === "submitted" || domain.nameserverStatus === "active"
        || domain.dynadotStatus === "updated")) {
        return;
      }
      const ownedByDynadot = await isDomainInDynadot(env, domain.domain, signal);
      if (!ownedByDynadot) {
        const hasDynadotKey = Boolean(secret(env, "DYNADOT_API_KEY"));
        await updateDomainAutomation(env.DB, domain.id, {
          dynadotStatus: hasDynadotKey ? "not_found" : "skipped_missing_key",
          nameserverStatus: "manual_required",
          status: "waiting_nameserver",
        }, job);
        return;
      }
      await setNameservers(env, domain.domain, nameservers, signal);
      await updateDomainAutomation(env.DB, domain.id, {
        dynadotStatus: "updated",
        nameserverStatus: "submitted",
        status: "waiting_nameserver",
      }, job);
    });

    if (!propagationZone) await step(env.DB, job, "dns_configured", signal, async () => {
      if (!zoneId) {
        throw new Error("cloudflare_zone_id_missing");
      }
      await ensureDnsRecords(env, zoneId, domain.domain, signal);
      await updateDomainAutomation(env.DB, domain.id, {
        status: "dns_configured",
        dnsStatus: "configured",
      }, job);
    });

    let zoneStatus = "pending";
    await step(env.DB, job, "route_configured", signal, async () => {
      if (!zoneId) {
        throw new Error("cloudflare_zone_id_missing");
      }
      if (!propagationZone) {
        await ensureWorkerRoutes(env, zoneId, domain.domain, signal);
      }
      const latestZone = propagationZone ?? await getZone(env, zoneId, signal);
      const active = latestZone.status === "active";
      zoneStatus = latestZone.status;
      await updateDomainAutomation(env.DB, domain.id, {
        status: active ? "active" : "waiting_nameserver",
        routeStatus: "configured",
        cloudflareZoneStatus: latestZone.status,
        nameserverStatus: active ? "active" : undefined,
        listVisible: active,
        lastError: null,
        lastCheckedAt: new Date().toISOString(),
      }, job);
    });

    if (zoneStatus !== "active") {
      throw new ProviderError("cloudflare", null, "nameserver_pending", true, "等待 Nameserver 生效。");
    }
    return { domainId: domain.id, domain: domain.domain, status: "active" };
  } catch (error) {
    const waiting = error instanceof ProviderError && error.code === "nameserver_pending";
    await updateDomainAutomation(env.DB, domain.id, {
      status: waiting ? "waiting_nameserver" : "failed",
      lastError: error instanceof ProviderError ? error.message : "域名自动化失败。",
      listVisible: false,
      lastCheckedAt: new Date().toISOString(),
    }, job);
    throw error;
  }
}

async function connectNameserver(env: Env, job: DomainJob, signal: AbortSignal): Promise<Record<string, unknown>> {
  const domain = String(job.payload.domain ?? job.subjectId);
  const registrarId = String(job.payload.registrarId ?? "manual");
  if (!isValidDomain(domain)) {
    throw new Error("invalid_domain");
  }
  const zone = await ensureZone(env, domain, signal);
  if (zone.nameServers.length === 0) {
    throw new Error("cloudflare_nameservers_missing");
  }
  if (registrarId === "dynadot") {
    const owned = await isDomainInDynadot(env, domain, signal);
    if (owned) {
      await setNameservers(env, domain, zone.nameServers, signal);
      return {
        domain,
        status: "submitted",
        message: "已提交 Dynadot set_ns，等待注册商和 Cloudflare 生效。",
        nameservers: zone.nameServers,
        zoneStatus: zone.status,
      };
    }
  }
  return {
    domain,
    status: "manual_required",
    message: "请复制 Nameserver 到当前注册商后台手动设置。",
    nameservers: zone.nameServers,
    zoneStatus: zone.status,
  };
}

async function runJob(env: Env, job: DomainJob, signal: AbortSignal): Promise<Record<string, unknown>> {
  signal.throwIfAborted();
  switch (job.type) {
    case "domain_provision":
    case "domain_retry":
      return processDomainJob(env, job, signal);
    case "domain_delete":
      return { deleted: await deleteDomains(env.DB, [job.subjectId], job), id: job.subjectId };
    case "target_repair":
      await repairTargetService(env, job.subjectId, job.attemptCount > 1 && job.currentStep === "waiting_nameserver", signal, job);
      return { id: job.subjectId, repaired: true };
    case "target_delete": {
      const target = await getTargetById(env.DB, job.subjectId);
      if (!target) {
        return { id: job.subjectId, deleted: false };
      }
      signal.throwIfAborted();
      return { id: job.subjectId, ...(await deleteTarget(env.DB, target.id, target.targetHost, job)) };
    }
    case "nameserver_connect":
      return connectNameserver(env, job, signal);
    case "zone_delete":
      return deleteZoneByName(env, String(job.payload.domain ?? job.subjectId), signal);
  }
}

export const JOB_TIMEOUT_MS = 240_000;

export async function processNextJob(env: Env, parentSignal?: AbortSignal): Promise<boolean> {
  parentSignal?.throwIfAborted();
  const job = await claimNextJob(env.DB);
  if (!job?.leaseToken) {
    return false;
  }
  const budgetMs = Math.max(0, Math.min(JOB_TIMEOUT_MS, Date.parse(job.leaseExpiresAt!) - Date.now() - 60_000));
  const signal = AbortSignal.any([AbortSignal.timeout(budgetMs), ...(parentSignal ? [parentSignal] : [])]);
  try {
    if (budgetMs === 0) throw new ProviderError("cloudflare", null, "job_timeout", true, "任务执行预算已耗尽，已安排重试。");
    const result = await runJob(env, job, signal);
    signal.throwIfAborted();
    await setJobResult(env.DB, job.id, job.leaseToken, result);
    await completeJob(env.DB, job.id, job.leaseToken);
  } catch (error) {
    await recordJobFailure(env.DB, job.id, job.leaseToken, signal.aborted
      ? new ProviderError("cloudflare", null, "job_timeout", true, "任务执行超时，已取消本次请求并安排重试。")
      : error);
  }
  return true;
}

export async function runScheduled(env: Env): Promise<void> {
  const deadline = Date.now() + 2 * JOB_TIMEOUT_MS;
  let processed = 0;
  try {
    // ponytail: at most two serial jobs per cron bound provider calls; revisit with measured backlog and plan limits.
    while (processed < 2 && Date.now() + JOB_TIMEOUT_MS <= deadline) {
      if (!await processNextJob(env)) break;
      processed += 1;
    }
    if (processed === 0) await refreshStaleTargetHealth(env, 5, AbortSignal.timeout(60_000));
  } finally {
    const retention = Number(env.VISIT_EVENT_RETENTION_DAYS || "30");
    await cleanupVisits(env.DB, Number.isFinite(retention) ? retention : 30);
    await cleanupJobSteps(env.DB);
  }
}
