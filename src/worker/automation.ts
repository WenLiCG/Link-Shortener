import { ensureDnsRecords, ensureWorkerRoutes, ensureZone, getZone } from "./cloudflare";
import {
  addJobStep,
  cleanupVisits,
  finishJob,
  getDomainForAutomation,
  queuedJobs,
  updateDomainAutomation,
  withOperationLock,
} from "./db";
import { isDomainInDynadot, setNameservers } from "./dynadot";
import { configuredValue } from "./env-utils";
import { isValidDomain } from "./shared";
import { refreshStaleTargetHealth } from "./target-health";

async function step(db: D1Database, jobId: string, name: string, fn: () => Promise<void>): Promise<void> {
  await addJobStep(db, jobId, name, "running");
  try {
    await fn();
    await addJobStep(db, jobId, name, "completed");
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    await addJobStep(db, jobId, name, "failed", message);
    throw error;
  }
}

export async function processDomainJob(env: Env, redirectDomainId: string, jobId: string): Promise<void> {
  return withOperationLock(env.DB, () => processDomainJobUnlocked(env, redirectDomainId, jobId));
}

async function processDomainJobUnlocked(env: Env, redirectDomainId: string, jobId: string): Promise<void> {
  const domain = await getDomainForAutomation(env.DB, redirectDomainId);
  if (!domain) {
    await finishJob(env.DB, jobId, "failed", "域名记录不存在。");
    return;
  }
  try {
    await step(env.DB, jobId, "validating", async () => {
      if (!isValidDomain(domain.domain)) {
        throw new Error("域名格式不合法。");
      }
      await updateDomainAutomation(env.DB, domain.id, { status: "cloudflare_zone", lastError: null });
    });

    let zoneId = domain.cloudflareZoneId;
    let nameservers = domain.cloudflareNameservers;
    let zoneStatus = domain.cloudflareZoneStatus;
    await step(env.DB, jobId, "cloudflare_zone", async () => {
      const zone = await ensureZone(env, domain.domain);
      zoneId = zone.id;
      nameservers = zone.nameServers;
      zoneStatus = zone.status;
      await updateDomainAutomation(env.DB, domain.id, {
        status: "nameserver_update",
        cloudflareZoneId: zone.id,
        cloudflareZoneStatus: zone.status,
        cloudflareNameservers: zone.nameServers,
      });
    });

    await step(env.DB, jobId, "nameserver_update", async () => {
      if (nameservers.length === 0) {
        throw new Error("Cloudflare 未返回 Nameserver。");
      }
      const ownedByDynadot = await isDomainInDynadot(env, domain.domain);
      if (!ownedByDynadot) {
        const hasDynadotKey = Boolean(await configuredValue(env, "DYNADOT_API_KEY"));
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

    await step(env.DB, jobId, "dns_configured", async () => {
      if (!zoneId) {
        throw new Error("缺少 Cloudflare Zone ID。");
      }
      await ensureDnsRecords(env, zoneId, domain.domain);
      await updateDomainAutomation(env.DB, domain.id, {
        status: "dns_configured",
        dnsStatus: "configured",
      });
    });

    await step(env.DB, jobId, "route_configured", async () => {
      if (!zoneId) {
        throw new Error("缺少 Cloudflare Zone ID。");
      }
      await ensureWorkerRoutes(env, zoneId, domain.domain);
      const latestZone = await getZone(env, zoneId);
      const active = latestZone.status === "active";
      await updateDomainAutomation(env.DB, domain.id, {
        status: active ? "active" : "waiting_nameserver",
        routeStatus: "configured",
        cloudflareZoneStatus: latestZone.status,
        nameserverStatus: active ? "active" : "waiting",
        listVisible: active,
        lastCheckedAt: new Date().toISOString(),
      });
      zoneStatus = latestZone.status;
    });

    await finishJob(env.DB, jobId, "completed", zoneStatus === "active" ? undefined : "等待 Nameserver 生效。");
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    await updateDomainAutomation(env.DB, domain.id, {
      status: "failed",
      lastError: message,
      lastCheckedAt: new Date().toISOString(),
    });
    await finishJob(env.DB, jobId, "failed", message);
  }
}

export async function runScheduled(env: Env): Promise<void> {
  const jobs = await queuedJobs(env.DB, 1);
  for (const job of jobs) {
    await processDomainJob(env, job.redirectDomainId, job.id);
  }
  await refreshStaleTargetHealth(env, 10);
  const retention = Number(env.VISIT_EVENT_RETENTION_DAYS || "30");
  await cleanupVisits(env.DB, Number.isFinite(retention) ? retention : 30);
}
