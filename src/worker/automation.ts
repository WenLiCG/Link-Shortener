import { deleteZoneByName, ensureDnsRecords, ensureWorkerRoutes, ensureZone, getZone } from "./cloudflare";
import {
  addJobStep,
  claimNextJob,
  cleanupVisits,
  completeJob,
  deleteDomains,
  deleteTarget,
  getDomainForAutomation,
  getTargetById,
  recordJobFailure,
  setJobResult,
  updateDomainAutomation,
} from "./db";
import { isDomainInDynadot, setNameservers } from "./dynadot";
import { secret } from "./env-utils";
import { ProviderError } from "./provider-error";
import { type DomainJob, isValidDomain } from "./shared";
import { repairTargetService } from "./target-automation";
import { refreshStaleTargetHealth } from "./target-health";

async function step(db: D1Database, jobId: string, name: string, fn: () => Promise<void>): Promise<void> {
  await addJobStep(db, jobId, name, "running");
  try {
    await fn();
    await addJobStep(db, jobId, name, "completed");
  } catch (error) {
    const message = error instanceof ProviderError ? error.message : "任务步骤失败。";
    await addJobStep(db, jobId, name, "failed", message);
    throw error;
  }
}

async function processDomainJob(env: Env, job: DomainJob): Promise<Record<string, unknown>> {
  const domainId = job.redirectDomainId;
  if (!domainId) {
    throw new Error("missing_redirect_domain_id");
  }
  const domain = await getDomainForAutomation(env.DB, domainId);
  if (!domain) {
    throw new Error("domain_not_found");
  }

  try {
    await step(env.DB, job.id, "validating", async () => {
      if (!isValidDomain(domain.domain)) {
        throw new Error("invalid_domain");
      }
      await updateDomainAutomation(env.DB, domain.id, {
        status: "cloudflare_zone",
        lastError: null,
        listVisible: false,
      });
    });

    let zoneId = domain.cloudflareZoneId;
    let nameservers = domain.cloudflareNameservers;
    await step(env.DB, job.id, "cloudflare_zone", async () => {
      const zone = await ensureZone(env, domain.domain);
      zoneId = zone.id;
      nameservers = zone.nameServers;
      await updateDomainAutomation(env.DB, domain.id, {
        status: "nameserver_update",
        cloudflareZoneId: zone.id,
        cloudflareZoneStatus: zone.status,
        cloudflareNameservers: zone.nameServers,
      });
    });

    await step(env.DB, job.id, "nameserver_update", async () => {
      if (nameservers.length === 0) {
        throw new Error("cloudflare_nameservers_missing");
      }
      if (domain.nameserverStatus === "submitted" || domain.nameserverStatus === "active") {
        return;
      }
      const ownedByDynadot = await isDomainInDynadot(env, domain.domain);
      if (!ownedByDynadot) {
        const hasDynadotKey = Boolean(secret(env, "DYNADOT_API_KEY"));
        await updateDomainAutomation(env.DB, domain.id, {
          dynadotStatus: hasDynadotKey ? "not_found" : "skipped_missing_key",
          nameserverStatus: "manual_required",
          status: "waiting_nameserver",
        });
        return;
      }
      await setNameservers(env, domain.domain, nameservers);
      await updateDomainAutomation(env.DB, domain.id, {
        dynadotStatus: "updated",
        nameserverStatus: "submitted",
        status: "waiting_nameserver",
      });
    });

    await step(env.DB, job.id, "dns_configured", async () => {
      if (!zoneId) {
        throw new Error("cloudflare_zone_id_missing");
      }
      await ensureDnsRecords(env, zoneId, domain.domain);
      await updateDomainAutomation(env.DB, domain.id, {
        status: "dns_configured",
        dnsStatus: "configured",
      });
    });

    let zoneStatus = "pending";
    await step(env.DB, job.id, "route_configured", async () => {
      if (!zoneId) {
        throw new Error("cloudflare_zone_id_missing");
      }
      await ensureWorkerRoutes(env, zoneId, domain.domain);
      const latestZone = await getZone(env, zoneId);
      const active = latestZone.status === "active";
      zoneStatus = latestZone.status;
      await updateDomainAutomation(env.DB, domain.id, {
        status: active ? "active" : "waiting_nameserver",
        routeStatus: "configured",
        cloudflareZoneStatus: latestZone.status,
        nameserverStatus: active ? "active" : "waiting",
        listVisible: active,
        lastError: null,
        lastCheckedAt: new Date().toISOString(),
      });
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
    });
    throw error;
  }
}

async function connectNameserver(env: Env, job: DomainJob): Promise<Record<string, unknown>> {
  const domain = String(job.payload.domain ?? job.subjectId);
  const registrarId = String(job.payload.registrarId ?? "manual");
  if (!isValidDomain(domain)) {
    throw new Error("invalid_domain");
  }
  const zone = await ensureZone(env, domain);
  if (zone.nameServers.length === 0) {
    throw new Error("cloudflare_nameservers_missing");
  }
  if (registrarId === "dynadot") {
    const owned = await isDomainInDynadot(env, domain);
    if (owned) {
      await setNameservers(env, domain, zone.nameServers);
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

async function runJob(env: Env, job: DomainJob): Promise<Record<string, unknown>> {
  switch (job.type) {
    case "domain_provision":
    case "domain_retry":
      return processDomainJob(env, job);
    case "domain_delete":
      return { deleted: await deleteDomains(env.DB, [job.subjectId]), id: job.subjectId };
    case "target_repair":
      await repairTargetService(env, job.subjectId);
      return { id: job.subjectId, repaired: true };
    case "target_delete": {
      const target = await getTargetById(env.DB, job.subjectId);
      if (!target) {
        return { id: job.subjectId, deleted: false };
      }
      return { id: job.subjectId, ...(await deleteTarget(env.DB, target.id, target.targetHost)) };
    }
    case "nameserver_connect":
      return connectNameserver(env, job);
    case "zone_delete":
      return deleteZoneByName(env, String(job.payload.domain ?? job.subjectId));
  }
}

export async function processNextJob(env: Env): Promise<boolean> {
  const job = await claimNextJob(env.DB);
  if (!job?.leaseToken) {
    return false;
  }
  try {
    const result = await runJob(env, job);
    await setJobResult(env.DB, job.id, job.leaseToken, result);
    await completeJob(env.DB, job.id, job.leaseToken);
  } catch (error) {
    await recordJobFailure(env.DB, job.id, job.leaseToken, error);
  }
  return true;
}

export async function runScheduled(env: Env): Promise<void> {
  await processNextJob(env);
  await refreshStaleTargetHealth(env, 10);
  const retention = Number(env.VISIT_EVENT_RETENTION_DAYS || "30");
  await cleanupVisits(env.DB, Number.isFinite(retention) ? retention : 30);
}
