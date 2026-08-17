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

interface TargetConfigurationSource {
  targetHost: string;
  cloudflareZoneName: string | null;
  cloudflareZoneStatus: string | null;
  cloudflareNameservers: string[];
  nameserverStatus: string;
  dnsStatus: string;
  automationStatus: string;
}

function recordName(target: TargetConfigurationSource): string {
  const zone = target.cloudflareZoneName;
  if (!zone || target.targetHost === zone) return "@";
  return target.targetHost.endsWith(`.${zone}`) ? target.targetHost.slice(0, -(zone.length + 1)) : target.targetHost;
}

function result(
  item: TargetConfigurationItem,
  status: TargetConfigurationStatus,
  summary: string,
  manualSteps: string[],
  details: TargetConfigurationResult["details"] = {},
): TargetConfigurationResult {
  return { item, status, summary, manualSteps, details };
}

export function initialConfigurationResult(
  target: TargetConfigurationSource,
  item: TargetConfigurationItem,
): TargetConfigurationResult {
  const zone = target.cloudflareZoneName;
  const zoneActive = target.cloudflareZoneStatus === "active";
  const inherited = Boolean(zone && target.targetHost !== zone);
  const details = { zone, nameservers: target.cloudflareNameservers, name: recordName(target), host: target.targetHost };

  if (item === "zone") {
    if (zoneActive) return result(item, "passed", `已记录激活的 Cloudflare Zone：${zone}。`, ["无需人工操作。"], details);
    return result(item, target.cloudflareZoneStatus === "failed" ? "failed" : "unknown", "尚未实时确认 Cloudflare Zone 状态。", ["点击信息检查读取 Cloudflare Zone 状态。"], details);
  }
  if (item === "nameserver") {
    if (target.nameserverStatus === "active") {
      return result(item, "passed", inherited ? `继承 ${zone} 的已激活 Nameserver，无需为子域名单独设置。` : "已记录 Cloudflare Nameserver 生效。", ["无需人工操作。"], details);
    }
    return result(item, target.nameserverStatus === "failed" ? "failed" : "unknown", "尚未实时确认 Nameserver 状态。", ["点击信息检查获取注册商或 Cloudflare 的操作指引。"], details);
  }
  if (item === "dns") {
    if (target.dnsStatus === "configured") return result(item, "passed", "已记录 DNS 由当前 Worker 接管。", ["如需确认当前记录，点击信息检查。"], details);
    return result(item, target.dnsStatus === "failed" ? "failed" : "unknown", "尚未实时确认 DNS 记录。", ["点击信息检查读取 A、AAAA 和 CNAME 记录。"], details);
  }
  if (target.automationStatus === "route_configured") {
    return result(item, "passed", "已记录 Worker Route 配置成功，正在进行实时确认。", ["点击信息检查可重新读取当前 Route。"], details);
  }
  return result(item, "unknown", "尚未实时确认 Worker Route。", ["点击信息检查读取当前 Route 及绑定的 Worker。"], details);
}
