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

async function cfResponse<T>(env: Env, path: string, init?: RequestInit, signal?: AbortSignal): Promise<CloudflareApiResponse<T>> {
  const timeoutSignal = AbortSignal.timeout(10_000);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  let response: Response | undefined;
  try {
    requestSignal.throwIfAborted();
    response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
      ...init,
      signal: requestSignal,
      headers: {
        ...cfHeaders(env),
        ...(init?.headers ?? {}),
      },
    });
    const text = await response.text();
    requestSignal.throwIfAborted();
    let body: CloudflareApiResponse<T> | null = null;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        body = parsed as CloudflareApiResponse<T>;
      }
    } catch {
      // Non-JSON error pages still retain their HTTP status below.
    }
    if (!response.ok || body?.success === false) {
      const rawCode = Array.isArray(body?.errors) ? body.errors[0]?.code : undefined;
      const code = Number.isSafeInteger(rawCode) ? rawCode : undefined;
      const retryable = response.status === 429 || response.status >= 500;
      let message = "Cloudflare 拒绝了请求，请检查配置。";
      if (response.status === 429) message = "Cloudflare 请求过于频繁，请稍后重试。";
      else if (response.status >= 500) message = "Cloudflare 暂时不可用，请稍后重试。";
      else if (response.status === 401 || code === 10000) message = "Cloudflare 身份验证失败，请检查 API Token 及其权限。";
      else if (response.status === 403) message = "Cloudflare 权限不足，请检查 API Token 的权限及资源范围。";
      else if (response.status === 400) message = "Cloudflare 请求参数无效，请检查域名及配置。";
      else if (response.status === 404) message = "Cloudflare 未找到资源，请检查 Zone 或账户配置。";
      else if (response.status === 409) message = "Cloudflare 资源存在冲突，请检查已有配置。";
      throw new ProviderError(
        "cloudflare",
        response.status,
        code === undefined ? (response.ok ? "api_error" : `http_${response.status}`) : `api_${code}`,
        retryable,
        code === undefined ? message : `${message}（错误码 ${code}）`,
      );
    }
    if (body?.success !== true || !("result" in body)) {
      throw new ProviderError("cloudflare", response.status, "invalid_response", true, "Cloudflare 返回了无效响应。");
    }
    return body;
  } catch (error) {
    if (error instanceof ProviderError) {
      throw error;
    }
    const timeout = requestSignal.aborted || error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError");
    throw new ProviderError(
      "cloudflare",
      response?.status ?? null,
      timeout ? "timeout" : "network_error",
      true,
      timeout ? "Cloudflare 请求超时。" : "无法连接 Cloudflare。",
    );
  }
}

async function cfRequest<T>(env: Env, path: string, init?: RequestInit, signal?: AbortSignal): Promise<T> {
  const body = await cfResponse<T>(env, path, init, signal);
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

export async function listZones(env: Env, signal?: AbortSignal): Promise<CloudflareZoneListItem[]> {
  const zones: CloudflareZoneListItem[] = [];
  const perPage = 50;
  for (let page = 1; ; page += 1) {
    const body = await cfResponse<
      Array<{ id: string; name: string; status: string; name_servers?: string[]; created_on?: string; modified_on?: string }>
    >(env, `/zones?per_page=${perPage}&page=${page}&order=name&direction=asc`, undefined, signal);
    const items = body.result;
    zones.push(...items.map(mapZoneListItem));
    const totalPages = body.result_info?.total_pages;
    if (items.length === 0 || (totalPages !== undefined ? page >= totalPages : items.length < perPage)) {
      break;
    }
  }
  return zones;
}

export async function ensureZone(env: Env, domain: string, signal?: AbortSignal): Promise<CloudflareZone> {
  const existing = await cfRequest<Array<{ id: string; name: string; status: string; name_servers?: string[] }>>(
    env,
    `/zones?name=${encodeURIComponent(domain)}&per_page=1`,
    undefined,
    signal,
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
  }, signal);
  return mapZone(created);
}

export async function findBestZoneForHost(env: Env, host: string, signal?: AbortSignal): Promise<CloudflareZone | null> {
  const labels = host.split(".");
  for (let index = 0; index <= labels.length - 2; index += 1) {
    const candidate = labels.slice(index).join(".");
    const existing = await cfRequest<Array<{ id: string; name: string; status: string; name_servers?: string[] }>>(
      env,
      `/zones?name=${encodeURIComponent(candidate)}&per_page=1`,
      undefined,
      signal,
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

export async function findAddressRecordsForHost(env: Env, zoneId: string, host: string, signal?: AbortSignal): Promise<DnsRecord[]> {
  const records: DnsRecord[] = [];
  for (const type of ["A", "AAAA", "CNAME"]) {
    const existing = await cfRequest<DnsRecord[]>(
      env,
      `/zones/${zoneId}/dns_records?type=${type}&name=${encodeURIComponent(host)}&per_page=100`,
      undefined,
      signal,
    );
    records.push(...existing);
  }
  return records;
}

async function createWorkerDnsRecord(env: Env, zoneId: string, host: string, signal?: AbortSignal): Promise<void> {
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
  }, signal);
}

async function replaceWithWorkerDnsRecord(env: Env, zoneId: string, host: string, records: DnsRecord[], signal?: AbortSignal): Promise<void> {
  if (records.length === 0) {
    await createWorkerDnsRecord(env, zoneId, host, signal);
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
  }, signal);
  for (const record of records.slice(1)) {
    await cfRequest(env, `/zones/${zoneId}/dns_records/${record.id}`, { method: "DELETE" }, signal);
  }
}

export async function ensureWorkerDnsRecordForHost(env: Env, zoneId: string, host: string, signal?: AbortSignal): Promise<void> {
  const records = await findAddressRecordsForHost(env, zoneId, host, signal);
  const alreadyConfigured = records.some((record) => record.type === "A" && record.content === "192.0.2.1" && record.proxied);
  if (alreadyConfigured) {
    for (const record of records.filter(
      (item) => item.type !== "A" || item.content !== "192.0.2.1" || !item.proxied,
    )) {
      await cfRequest(env, `/zones/${zoneId}/dns_records/${record.id}`, { method: "DELETE" }, signal);
    }
    return;
  }
  await replaceWithWorkerDnsRecord(env, zoneId, host, records, signal);
}

export async function ensureDnsRecords(env: Env, zoneId: string, domain: string, signal?: AbortSignal): Promise<void> {
  await ensureWorkerDnsRecordForHost(env, zoneId, domain, signal);
  await ensureWorkerDnsRecordForHost(env, zoneId, `*.${domain}`, signal);
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
  signal?: AbortSignal,
): Promise<void> {
  const existing = routes.find((route) => route.pattern === pattern);
  if (!existing) {
    await cfRequest(env, `/zones/${zoneId}/workers/routes`, {
      method: "POST",
      body: JSON.stringify({ pattern, script }),
    }, signal);
    return;
  }
  if (existing.script !== script) {
    await cfRequest(env, `/zones/${zoneId}/workers/routes/${existing.id}`, {
      method: "PUT",
      body: JSON.stringify({ pattern, script }),
    }, signal);
  }
}

export async function ensureWorkerRoutes(env: Env, zoneId: string, domain: string, signal?: AbortSignal): Promise<void> {
  const script = env.WORKER_SCRIPT_NAME || "link-shortener-manager";
  const routes = await cfRequest<WorkerRoute[]>(env, `/zones/${zoneId}/workers/routes`, undefined, signal);
  for (const pattern of [`${domain}/*`, `*.${domain}/*`]) {
    await ensureWorkerRoute(env, zoneId, routes, pattern, script, signal);
  }
}

export async function ensureWorkerRouteForHost(env: Env, zoneId: string, host: string, signal?: AbortSignal): Promise<void> {
  const script = env.WORKER_SCRIPT_NAME || "link-shortener-manager";
  const pattern = `${host}/*`;
  const routes = await cfRequest<WorkerRoute[]>(env, `/zones/${zoneId}/workers/routes`, undefined, signal);
  await ensureWorkerRoute(env, zoneId, routes, pattern, script, signal);
}

export async function getZone(env: Env, zoneId: string, signal?: AbortSignal): Promise<CloudflareZone> {
  const zone = await cfRequest<{ id: string; name: string; status: string; name_servers?: string[] }>(env, `/zones/${zoneId}`, undefined, signal);
  return mapZone(zone);
}

export async function deleteZoneByName(env: Env, domain: string, signal?: AbortSignal): Promise<{ deleted: boolean; zoneId?: string; status: string; message: string }> {
  const existing = await cfRequest<Array<{ id: string; name: string; status: string; name_servers?: string[] }>>(
    env,
    `/zones?name=${encodeURIComponent(domain)}&per_page=1`,
    undefined,
    signal,
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
  await cfRequest(env, `/zones/${zone.id}`, { method: "DELETE" }, signal);
  return { deleted: true, zoneId: zone.id, status: "deleted", message: "已删除 Cloudflare Zone。" };
}
