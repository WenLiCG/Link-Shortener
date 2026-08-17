import {
  ensureWorkerDnsRecordForHost,
  ensureWorkerRouteForHost,
  ensureZone,
  findAddressRecordsForHost,
  findBestZoneForHost,
  findWorkerRouteForHost,
  type CloudflareZone,
} from "./cloudflare";
import { getTargetById, updateTargetAutomation } from "./db";
import { isDomainInDynadot, setNameservers } from "./dynadot";

export const targetConfigurationItems = ["zone", "nameserver", "dns", "route"] as const;
export type TargetConfigurationItem = (typeof targetConfigurationItems)[number];
export type TargetConfigurationStatus = "passed" | "failed" | "unknown";

export interface TargetConfigurationResult {
  item: TargetConfigurationItem;
  status: TargetConfigurationStatus;
  summary: string;
  manualSteps: string[];
  details: Record<string, string | string[] | null>;
}

type Target = NonNullable<Awaited<ReturnType<typeof getTargetById>>>;

function result(
  item: TargetConfigurationItem,
  status: TargetConfigurationStatus,
  summary: string,
  manualSteps: string[],
  details: TargetConfigurationResult["details"] = {},
): TargetConfigurationResult {
  return { item, status, summary, manualSteps, details };
}

function recordName(target: Target, zone: CloudflareZone): string {
  return target.targetHost === zone.name ? "@" : target.targetHost.slice(0, -(zone.name.length + 1));
}

function workerScript(env: Env): string {
  return env.WORKER_SCRIPT_NAME || "link-shortener-manager";
}

async function targetAndZone(env: Env, targetId: string): Promise<{ target: Target; zone: CloudflareZone | null }> {
  const target = await getTargetById(env.DB, targetId);
  if (!target) {
    throw new Error("target_not_found");
  }
  return { target, zone: await findBestZoneForHost(env, target.targetHost) };
}

function missingZone(item: TargetConfigurationItem, target: Target): TargetConfigurationResult {
  return result(item, "failed", "未找到可用的 Cloudflare Zone。", [
    `在 Cloudflare 中添加 ${target.targetHost} 所属的根域名 Zone。`,
    "等待 Zone 显示为 Active 后，再点击信息检查。",
  ], { zone: null });
}

function zoneDetails(zone: CloudflareZone): TargetConfigurationResult["details"] {
  return { zone: zone.name, nameservers: zone.nameServers };
}

async function checkZone(env: Env, targetId: string): Promise<TargetConfigurationResult> {
  const { target, zone } = await targetAndZone(env, targetId);
  if (!zone) return missingZone("zone", target);
  if (zone.status !== "active") {
    return result("zone", "unknown", `Cloudflare Zone ${zone.name} 正在等待激活。`, [
      `将 ${zone.name} 的 Nameserver 更新为 Cloudflare 提供的地址。`,
      "等待 Cloudflare Zone 显示为 Active 后，再点击信息检查。",
    ], zoneDetails(zone));
  }
  return result("zone", "passed", `已确认使用激活的 Cloudflare Zone：${zone.name}。`, ["无需人工操作。"], zoneDetails(zone));
}

async function checkNameserver(env: Env, targetId: string): Promise<TargetConfigurationResult> {
  const { target, zone } = await targetAndZone(env, targetId);
  if (!zone) return missingZone("nameserver", target);
  const inherited = target.targetHost !== zone.name;
  if (zone.status === "active") {
    return result(
      "nameserver",
      "passed",
      inherited ? `继承 ${zone.name} 的已激活 Nameserver，无需为子域名单独设置。` : "已确认 Cloudflare Nameserver 生效。",
      ["无需人工操作。"],
      { ...zoneDetails(zone), inherited: inherited ? "true" : "false" },
    );
  }
  return result("nameserver", "unknown", "Cloudflare Nameserver 尚未生效。", [
    `在注册商后台将 ${zone.name} 的 Nameserver 更新为下列 Cloudflare 地址。`,
    ...zone.nameServers,
    "等待 Cloudflare Zone 激活后，再点击信息检查。",
  ], { ...zoneDetails(zone), inherited: inherited ? "true" : "false" });
}

async function checkDns(env: Env, targetId: string): Promise<TargetConfigurationResult> {
  const { target, zone } = await targetAndZone(env, targetId);
  if (!zone) return missingZone("dns", target);
  const records = await findAddressRecordsForHost(env, zone.id, target.targetHost);
  const correct = records.length === 1 && records[0].type === "A" && records[0].content === "192.0.2.1" && records[0].proxied;
  const details = { ...zoneDetails(zone), name: recordName(target, zone), host: target.targetHost };
  if (correct) {
    return result("dns", "passed", "已确认橙云 A 记录由当前 Worker 接管。", ["无需人工操作。"], details);
  }
  return result("dns", "failed", "DNS 记录未由当前 Worker 接管。", [
    `在 ${zone.name} 的 DNS 页面删除 ${recordName(target, zone)} 的 A、AAAA 和 CNAME 冲突记录。`,
    `新增 A 记录：名称 ${recordName(target, zone)}，内容 192.0.2.1，并开启橙云代理。`,
    "保存后点击信息检查。",
  ], details);
}

async function checkRoute(env: Env, targetId: string): Promise<TargetConfigurationResult> {
  const { target, zone } = await targetAndZone(env, targetId);
  if (!zone) return missingZone("route", target);
  const script = workerScript(env);
  const route = await findWorkerRouteForHost(env, zone.id, target.targetHost);
  const details = { ...zoneDetails(zone), pattern: `${target.targetHost}/*`, script };
  if (route?.script === script) {
    return result("route", "passed", `已确认 ${details.pattern} 绑定 ${script}。`, ["无需人工操作。"], details);
  }
  return result("route", "failed", "Worker Route 未绑定到当前 Worker。", [
    `打开 Cloudflare 的 Workers Routes，为 ${details.pattern} 绑定 ${script}。`,
    "保存后点击信息检查。",
  ], details);
}

export async function checkTargetConfigurationItem(
  env: Env,
  targetId: string,
  item: TargetConfigurationItem,
): Promise<TargetConfigurationResult> {
  switch (item) {
    case "zone": return checkZone(env, targetId);
    case "nameserver": return checkNameserver(env, targetId);
    case "dns": return checkDns(env, targetId);
    case "route": return checkRoute(env, targetId);
  }
}

export async function checkTargetConfiguration(env: Env, targetId: string): Promise<TargetConfigurationResult[]> {
  return Promise.all(targetConfigurationItems.map((item) => checkTargetConfigurationItem(env, targetId, item)));
}

export async function configureTargetConfigurationItem(
  env: Env,
  targetId: string,
  item: TargetConfigurationItem,
): Promise<TargetConfigurationResult> {
  const { target, zone: existingZone } = await targetAndZone(env, targetId);
  const zone = existingZone ?? (item === "zone" ? await ensureZone(env, target.targetHost) : null);
  if (!zone) return missingZone(item, target);

  if (item === "zone") {
    await updateTargetAutomation(env.DB, target.id, {
      automationStatus: "cloudflare_zone",
      cloudflareZoneId: zone.id,
      cloudflareZoneName: zone.name,
      cloudflareZoneStatus: zone.status,
      cloudflareNameservers: zone.nameServers,
      lastError: null,
    });
  }
  if (item === "nameserver" && target.targetHost === zone.name) {
    if (zone.nameServers.length === 0) {
      return result(item, "unknown", "Cloudflare 尚未返回 Nameserver。", ["稍后点击信息检查，获取 Cloudflare Nameserver 后在注册商后台手动设置。"], zoneDetails(zone));
    }
    if (await isDomainInDynadot(env, target.targetHost)) {
      await setNameservers(env, target.targetHost, zone.nameServers);
      await updateTargetAutomation(env.DB, target.id, { nameserverStatus: "submitted", dynadotStatus: "updated", lastError: null });
    } else {
      await updateTargetAutomation(env.DB, target.id, { nameserverStatus: "manual_required", dynadotStatus: "not_found" });
    }
  }
  if (item === "dns") {
    await ensureWorkerDnsRecordForHost(env, zone.id, target.targetHost);
    await updateTargetAutomation(env.DB, target.id, { automationStatus: "dns_configured", dnsStatus: "configured", lastError: null });
  }
  if (item === "route") {
    await ensureWorkerRouteForHost(env, zone.id, target.targetHost);
  }
  const checked = await checkTargetConfigurationItem(env, targetId, item);
  if (item === "route") {
    await updateTargetAutomation(env.DB, target.id, {
      automationStatus: checked.status === "passed" ? "route_configured" : "route_failed",
      lastError: checked.status === "failed" ? checked.summary : null,
    });
  }
  return checked;
}
