import { type CloudflareZone, ensureWorkerDnsRecordForHost, ensureWorkerRouteForHost, findBestZoneForHost, ensureZone, getZone } from "./cloudflare";
import { getTargetById, updateTargetAutomation } from "./db";
import { isDomainInDynadot, setNameservers } from "./dynadot";
import { secret } from "./env-utils";
import { ProviderError } from "./provider-error";
import { refreshTargetHealth } from "./target-health";

function isApexOfZone(host: string, zoneName: string): boolean {
  return host === zoneName;
}

export async function repairTargetService(env: Env, targetId: string, checkPropagationOnly = false): Promise<void> {
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
    let propagationZone: CloudflareZone | null = null;
    if (checkPropagationOnly && target.cloudflareZoneId && target.cloudflareZoneStatus === "pending"
      && target.automationStatus === "waiting_nameserver" && target.dnsStatus === "configured") {
      try {
        const existing = await getZone(env, target.cloudflareZoneId);
        if (existing.id === target.cloudflareZoneId && existing.name === target.cloudflareZoneName
          && (target.targetHost === existing.name || target.targetHost.endsWith(`.${existing.name}`))
          && [...existing.nameServers].sort().join() === [...target.cloudflareNameservers].sort().join()) {
          propagationZone = existing;
        }
      } catch (error) {
        if (!(error instanceof ProviderError && error.status === 404)) {
          throw error;
        }
      }
    }
    let zone = propagationZone ?? await findBestZoneForHost(env, target.targetHost);
    if (!zone) {
      zone = await ensureZone(env, target.targetHost);
    }

    if (!propagationZone) {
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
        const sameNameservers = target.cloudflareZoneId === zone.id
          && [...target.cloudflareNameservers].sort().join() === [...zone.nameServers].sort().join();
        if (!sameNameservers || !(["submitted", "active"].includes(target.nameserverStatus)
          || target.dynadotStatus === "updated")) {
          const ownedByDynadot = await isDomainInDynadot(env, target.targetHost);
          if (ownedByDynadot) {
            await setNameservers(env, target.targetHost, zone.nameServers);
            await updateTargetAutomation(env.DB, target.id, {
              nameserverStatus: "submitted",
              dynadotStatus: "updated",
            });
          } else {
            const hasDynadotKey = Boolean(secret(env, "DYNADOT_API_KEY"));
            await updateTargetAutomation(env.DB, target.id, {
              nameserverStatus: hasDynadotKey ? "manual_required" : "skipped_missing_key",
              dynadotStatus: hasDynadotKey ? "not_found" : "skipped_missing_key",
            });
          }
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
    }

    const latestZone = propagationZone ?? await getZone(env, zone.id);
    const nameserverStatus = latestZone.status === "active" ? "active" : undefined;
    await updateTargetAutomation(env.DB, target.id, {
      automationStatus: "dns_configured",
      dnsStatus: "configured",
      cloudflareZoneName: latestZone.name,
      cloudflareZoneStatus: latestZone.status,
      nameserverStatus,
      lastError: null,
      lastCheckedAt: new Date().toISOString(),
    });

    if (latestZone.status !== "active") {
      throw new ProviderError("cloudflare", null, "nameserver_pending", true, "等待 Nameserver 生效。");
    }
    await refreshTargetHealth(env, target.id);
  } catch (error) {
    const waiting = error instanceof ProviderError && error.code === "nameserver_pending";
    await updateTargetAutomation(env.DB, target.id, {
      automationStatus: waiting ? "waiting_nameserver" : "failed",
      lastError: error instanceof ProviderError ? error.message : "目标服务自动化失败。",
      lastCheckedAt: new Date().toISOString(),
    });
    if (!waiting) {
      await refreshTargetHealth(env, target.id);
    }
    throw error;
  }
}
