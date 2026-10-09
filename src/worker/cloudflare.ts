import { secret } from "./env-utils";
import { ProviderError } from "./provider-error";
import { domainMatchesHost } from "./shared";

export interface CloudflareZone {
  id: string;
  name: string;
  status: string;
  nameServers: string[];
}

export interface CloudflareZoneListItem extends CloudflareZone {
  createdOn: string | null;
  modifiedOn: string | null;
}

interface CloudflareApiResponse<T> {
  success: boolean;
  result: T;
  errors?: Array<{ code: number; message: string }>;
  result_info?: { page?: number; total_pages?: number };
}

function cfHeaders(env: Env): HeadersInit {
  const token = secret(env, "CLOUDFLARE_API_TOKEN");
  if (!token) {
    throw new ProviderError("cloudflare", null, "missing_token", false, "尚未配置 Cloudflare API Token。");
  }
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
}

async function cfResponse<T>(env: Env, path: string, init?: RequestInit): Promise<CloudflareApiResponse<T>> {
  let response: Response;
  try {
    response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(10_000),
      headers: {
        ...cfHeaders(env),
        ...(init?.headers ?? {}),
      },
    });
  } catch (error) {
    if (error instanceof ProviderError) {
      throw error;
    }
    const timeout = error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError");
    throw new ProviderError(
      "cloudflare",
      null,
      timeout ? "timeout" : "network_error",
      true,
      timeout ? "Cloudflare 请求超时。" : "无法连接 Cloudflare。",
    );
  }
  if (!response.ok) {
    const retryable = response.status === 429 || response.status >= 500;
    throw new ProviderError(
      "cloudflare",
      response.status,
      `http_${response.status}`,
      retryable,
      retryable ? "Cloudflare 暂时不可用，请稍后重试。" : "Cloudflare 拒绝了请求，请检查配置。",
    );
  }
  let body: CloudflareApiResponse<T>;
  try {
    const parsed = await response.json();
    if (!parsed || typeof parsed !== "object" || !("success" in parsed) || !("result" in parsed)) {
      throw new Error("invalid_response");
    }
    body = parsed as CloudflareApiResponse<T>;
  } catch {
    throw new ProviderError("cloudflare", response.status, "invalid_response", true, "Cloudflare 返回了无效响应。");
  }
  if (!body.success) {
    const code = body.errors?.[0]?.code;
    throw new ProviderError(
      "cloudflare",
      response.status,
      code === undefined ? "api_error" : `api_${code}`,
      false,
      "Cloudflare 拒绝了请求，请检查配置。",
    );
  }
  return body;
}

async function cfRequest<T>(env: Env, path: string, init?: RequestInit): Promise<T> {
  const body = await cfResponse<T>(env, path, init);
  return body.result;
}

function mapZone(zone: { id: string; name: string; status: string; name_servers?: string[] }): CloudflareZone {
  return {
    id: zone.id,
    name: zone.name,
    status: zone.status,
    nameServers: zone.name_servers ?? [],
  };
}

function mapZoneListItem(zone: {
  id: string;
  name: string;
  status: string;
  name_servers?: string[];
  created_on?: string;
  modified_on?: string;
}): CloudflareZoneListItem {
  return {
    ...mapZone(zone),
    createdOn: zone.created_on ?? null,
    modifiedOn: zone.modified_on ?? null,
  };
}

export async function listZones(env: Env): Promise<CloudflareZoneListItem[]> {
  const zones: CloudflareZoneListItem[] = [];
  const perPage = 50;
  for (let page = 1; ; page += 1) {
    const body = await cfResponse<
      Array<{ id: string; name: string; status: string; name_servers?: string[]; created_on?: string; modified_on?: string }>
    >(env, `/zones?per_page=${perPage}&page=${page}&order=name&direction=asc`);
    const items = body.result;
    zones.push(...items.map(mapZoneListItem));
    const totalPages = body.result_info?.total_pages;
    if (items.length === 0 || (totalPages !== undefined ? page >= totalPages : items.length < perPage)) {
      break;
    }
  }
  return zones;
}

export async function ensureZone(env: Env, domain: string): Promise<CloudflareZone> {
  const existing = await cfRequest<Array<{ id: string; name: string; status: string; name_servers?: string[] }>>(
    env,
    `/zones?name=${encodeURIComponent(domain)}&per_page=1`,
  );
  if (existing.length > 0) {
    return mapZone(existing[0]);
  }
  const accountId = secret(env, "CLOUDFLARE_ACCOUNT_ID");
  if (!accountId) {
    throw new ProviderError("cloudflare", null, "missing_account_id", false, "尚未配置 Cloudflare Account ID。");
  }
  const created = await cfRequest<{ id: string; name: string; status: string; name_servers?: string[] }>(env, "/zones", {
    method: "POST",
    body: JSON.stringify({
      account: { id: accountId },
      name: domain,
      type: "full",
    }),
  });
  return mapZone(created);
}

export async function findBestZoneForHost(env: Env, host: string): Promise<CloudflareZone | null> {
  const labels = host.split(".");
  for (let index = 0; index <= labels.length - 2; index += 1) {
    const candidate = labels.slice(index).join(".");
    const existing = await cfRequest<Array<{ id: string; name: string; status: string; name_servers?: string[] }>>(
      env,
      `/zones?name=${encodeURIComponent(candidate)}&per_page=1`,
    );
    if (existing.length > 0) {
      return mapZone(existing[0]);
    }
  }
  return null;
}

export interface DnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied?: boolean;
}

export async function findAddressRecordsForHost(env: Env, zoneId: string, host: string): Promise<DnsRecord[]> {
  const records: DnsRecord[] = [];
  for (const type of ["A", "AAAA", "CNAME"]) {
    const existing = await cfRequest<DnsRecord[]>(
      env,
      `/zones/${zoneId}/dns_records?type=${type}&name=${encodeURIComponent(host)}&per_page=100`,
    );
    records.push(...existing);
  }
  return records;
}

async function createWorkerDnsRecord(env: Env, zoneId: string, host: string): Promise<void> {
  await cfRequest(env, `/zones/${zoneId}/dns_records`, {
    method: "POST",
    body: JSON.stringify({
      type: "A",
      name: host,
      content: "192.0.2.1",
      ttl: 1,
      proxied: true,
      comment: "Managed by Link Shortener Manager target service",
    }),
  });
}

async function replaceWithWorkerDnsRecord(env: Env, zoneId: string, host: string, records: DnsRecord[]): Promise<void> {
  if (records.length === 0) {
    await createWorkerDnsRecord(env, zoneId, host);
    return;
  }
  await cfRequest(env, `/zones/${zoneId}/dns_records/${records[0].id}`, {
    method: "PATCH",
    body: JSON.stringify({
      type: "A",
      name: host,
      content: "192.0.2.1",
      ttl: 1,
      proxied: true,
      comment: "Managed by Link Shortener Manager target service",
    }),
  });
  for (const record of records.slice(1)) {
    await cfRequest(env, `/zones/${zoneId}/dns_records/${record.id}`, { method: "DELETE" });
  }
}

export async function ensureWorkerDnsRecordForHost(env: Env, zoneId: string, host: string): Promise<void> {
  const records = await findAddressRecordsForHost(env, zoneId, host);
  const alreadyConfigured = records.some((record) => record.type === "A" && record.content === "192.0.2.1" && record.proxied);
  if (alreadyConfigured) {
    for (const record of records.filter(
      (item) => item.type !== "A" || item.content !== "192.0.2.1" || !item.proxied,
    )) {
      await cfRequest(env, `/zones/${zoneId}/dns_records/${record.id}`, { method: "DELETE" });
    }
    return;
  }
  await replaceWithWorkerDnsRecord(env, zoneId, host, records);
}

export async function ensureDnsRecords(env: Env, zoneId: string, domain: string): Promise<void> {
  await ensureWorkerDnsRecordForHost(env, zoneId, domain);
  await ensureWorkerDnsRecordForHost(env, zoneId, `*.${domain}`);
}

interface WorkerRoute {
  id: string;
  pattern: string;
  script?: string | null;
}

async function ensureWorkerRoute(
  env: Env,
  zoneId: string,
  routes: WorkerRoute[],
  pattern: string,
  script: string,
): Promise<void> {
  const existing = routes.find((route) => route.pattern === pattern);
  if (!existing) {
    await cfRequest(env, `/zones/${zoneId}/workers/routes`, {
      method: "POST",
      body: JSON.stringify({ pattern, script }),
    });
    return;
  }
  if (existing.script !== script) {
    await cfRequest(env, `/zones/${zoneId}/workers/routes/${existing.id}`, {
      method: "PUT",
      body: JSON.stringify({ pattern, script }),
    });
  }
}

export async function ensureWorkerRoutes(env: Env, zoneId: string, domain: string): Promise<void> {
  const script = env.WORKER_SCRIPT_NAME || "link-shortener-manager";
  const routes = await cfRequest<WorkerRoute[]>(env, `/zones/${zoneId}/workers/routes`);
  for (const pattern of [`${domain}/*`, `*.${domain}/*`]) {
    await ensureWorkerRoute(env, zoneId, routes, pattern, script);
  }
}

export async function ensureWorkerRouteForHost(env: Env, zoneId: string, host: string): Promise<void> {
  const script = env.WORKER_SCRIPT_NAME || "link-shortener-manager";
  const pattern = `${host}/*`;
  const routes = await cfRequest<WorkerRoute[]>(env, `/zones/${zoneId}/workers/routes`);
  await ensureWorkerRoute(env, zoneId, routes, pattern, script);
}

export async function getZone(env: Env, zoneId: string): Promise<CloudflareZone> {
  const zone = await cfRequest<{ id: string; name: string; status: string; name_servers?: string[] }>(env, `/zones/${zoneId}`);
  return mapZone(zone);
}

export async function deleteZoneByName(env: Env, domain: string): Promise<{ deleted: boolean; zoneId?: string; status: string; message: string }> {
  const existing = await cfRequest<Array<{ id: string; name: string; status: string; name_servers?: string[] }>>(
    env,
    `/zones?name=${encodeURIComponent(domain)}&per_page=1`,
  );
  const zone = existing.find((item) => item.name === domain);
  if (!zone) {
    return { deleted: false, status: "not_found", message: "Cloudflare 中未找到同名 Zone。" };
  }
  if (domainMatchesHost(zone.name, env.ADMIN_HOST || "")) {
    throw new ProviderError("cloudflare", 409, "zone_in_use", false, "该 Zone 承载管理后台，不能删除。");
  }
  const dependency = await env.DB.prepare(
    `SELECT domain AS host FROM redirect_domains
     WHERE cloudflare_zone_id = ? OR lower(domain) = ? OR substr(lower(domain), -length(?)) = ?
     UNION ALL
     SELECT target_host AS host FROM target_services
     WHERE cloudflare_zone_id = ? OR lower(target_host) = ? OR substr(lower(target_host), -length(?)) = ?
     LIMIT 1`,
  ).bind(zone.id, zone.name, `.${zone.name}`, `.${zone.name}`, zone.id, zone.name, `.${zone.name}`, `.${zone.name}`).first<{ host: string }>();
  if (dependency) {
    throw new ProviderError("cloudflare", 409, "zone_in_use", false, `该 Zone 仍被 ${dependency.host} 使用，请先移除相关系统配置。`);
  }
  await cfRequest(env, `/zones/${zone.id}`, { method: "DELETE" });
  return { deleted: true, zoneId: zone.id, status: "deleted", message: "已删除 Cloudflare Zone。" };
}
