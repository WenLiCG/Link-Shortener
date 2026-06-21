import { ensureWorkerDnsRecordForHost, ensureWorkerRouteForHost, findBestZoneForHost, ensureZone, getZone } from "./cloudflare";
import { getTargetById, updateTargetAutomation, withOperationLock } from "./db";
import { isDomainInDynadot, setNameservers } from "./dynadot";
import { configuredValue } from "./env-utils";
import { refreshTargetHealth } from "./target-health";

function isApexOfZone(host: string, zoneName: string): boolean {
  return host === zoneName;
}

export async function repairTargetService(env: Env, targetId: string): Promise<void> {
  return withOperationLock(env.DB, () => repairTargetServiceUnlocked(env, targetId));
}

async function repairTargetServiceUnlocked(env: Env, targetId: string): Promise<void> {
  const target = await getTargetById(env.DB, targetId);
  if (!target) {
    return;
  }

  await updateTargetAutomation(env.DB, target.id, {
    automationStatus: "cloudflare_zone",
    lastError: null,
    lastCheckedAt: new Date().toISOString(),
  });

  try {
    let zone = await findBestZoneForHost(env, target.targetHost);
    if (!zone) {
      zone = await ensureZone(env, target.targetHost);
    }

    await updateTargetAutomation(env.DB, target.id, {
      automationStatus: "nameserver_update",
      cloudflareZoneId: zone.id,
      cloudflareZoneName: zone.name,
      cloudflareZoneStatus: zone.status,
      cloudflareNameservers: zone.nameServers,
    });

    if (isApexOfZone(target.targetHost, zone.name)) {
      if (zone.nameServers.length === 0) {
        throw new Error("Cloudflare 未返回 Nameserver。");
      }
      const ownedByDynadot = await isDomainInDynadot(env, target.targetHost);
      if (ownedByDynadot) {
        await setNameservers(env, target.targetHost, zone.nameServers);
        await updateTargetAutomation(env.DB, target.id, {
          nameserverStatus: "submitted",
          dynadotStatus: "updated",
        });
      } else {
        const hasDynadotKey = Boolean(await configuredValue(env, "DYNADOT_API_KEY"));
        await updateTargetAutomation(env.DB, target.id, {
          nameserverStatus: hasDynadotKey ? "manual_required" : "skipped_missing_key",
          dynadotStatus: hasDynadotKey ? "not_found" : "skipped_missing_key",
        });
      }
    } else {
      await updateTargetAutomation(env.DB, target.id, {
        nameserverStatus: zone.status === "active" ? "active" : "waiting",
        dynadotStatus: "inherited_zone",
      });
    }

    await updateTargetAutomation(env.DB, target.id, {
      automationStatus: "dns_configured",
    });
    await ensureWorkerDnsRecordForHost(env, zone.id, target.targetHost);
    await ensureWorkerRouteForHost(env, zone.id, target.targetHost);

    const latestZone = await getZone(env, zone.id);
    const nameserverStatus = latestZone.status === "active" ? "active" : "waiting";
    await updateTargetAutomation(env.DB, target.id, {
      automationStatus: "dns_configured",
      dnsStatus: "configured",
      cloudflareZoneName: latestZone.name,
      cloudflareZoneStatus: latestZone.status,
      nameserverStatus,
      lastError: null,
      lastCheckedAt: new Date().toISOString(),
    });

    await refreshTargetHealth(env, target.id);
  } catch (error) {
    await updateTargetAutomation(env.DB, target.id, {
      automationStatus: "failed",
      lastError: error instanceof Error ? error.message : "目标服务自动化失败。",
      lastCheckedAt: new Date().toISOString(),
    });
    await refreshTargetHealth(env, target.id);
  }
}
