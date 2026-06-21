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
}

async function cfHeaders(env: Env): Promise<HeadersInit> {
  const token = await configuredValue(env, "CLOUDFLARE_API_TOKEN");
  if (!token) {
    throw new Error("缺少 CLOUDFLARE_API_TOKEN。");
  }
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
}

function errorMessage(errors?: Array<{ message: string }>): string {
  return errors?.map((error) => error.message).join("; ") || "Cloudflare API 请求失败。";
}

async function cfRequest<T>(env: Env, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: {
      ...(await cfHeaders(env)),
      ...(init?.headers ?? {}),
    },
  });
  const body = (await response.json()) as CloudflareApiResponse<T>;
  if (!response.ok || !body.success) {
    throw new Error(errorMessage(body.errors));
  }
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
  for (let page = 1; page <= 10; page += 1) {
    const items = await cfRequest<
      Array<{ id: string; name: string; status: string; name_servers?: string[]; created_on?: string; modified_on?: string }>
    >(env, `/zones?per_page=${perPage}&page=${page}&order=name&direction=asc`);
    zones.push(...items.map(mapZoneListItem));
    if (items.length < perPage) {
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
  const accountId = await configuredValue(env, "CLOUDFLARE_ACCOUNT_ID");
  if (!accountId) {
    throw new Error("缺少 CLOUDFLARE_ACCOUNT_ID。");
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
  try {
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
  } catch {
    for (const record of records) {
      await cfRequest(env, `/zones/${zoneId}/dns_records/${record.id}`, { method: "DELETE" });
    }
    await createWorkerDnsRecord(env, zoneId, host);
  }
}

export async function ensureWorkerDnsRecordForHost(env: Env, zoneId: string, host: string): Promise<void> {
  const records = await findAddressRecordsForHost(env, zoneId, host);
  const alreadyConfigured = records.some((record) => record.type === "A" && record.content === "192.0.2.1" && record.proxied);
  if (alreadyConfigured) {
    for (const record of records.filter((item) => item.type !== "A" || item.content !== "192.0.2.1")) {
      await cfRequest(env, `/zones/${zoneId}/dns_records/${record.id}`, { method: "DELETE" });
    }
    return;
  }
  await replaceWithWorkerDnsRecord(env, zoneId, host, records);
}

export async function ensureDnsRecords(env: Env, zoneId: string, domain: string): Promise<void> {
  for (const name of [domain, `*.${domain}`]) {
    const existing = await cfRequest<Array<{ id: string }>>(
      env,
      `/zones/${zoneId}/dns_records?type=A&name=${encodeURIComponent(name)}&per_page=1`,
    );
    if (existing.length > 0) {
      continue;
    }
    await cfRequest(env, `/zones/${zoneId}/dns_records`, {
      method: "POST",
      body: JSON.stringify({
        type: "A",
        name,
        content: "192.0.2.1",
        ttl: 1,
        proxied: true,
        comment: "Managed by Link Shortener Manager",
      }),
    });
  }
}

export async function ensureWorkerRoutes(env: Env, zoneId: string, domain: string): Promise<void> {
  const script = env.WORKER_SCRIPT_NAME || "link-shortener-manager";
  const existingRoutes = await cfRequest<Array<{ id: string; pattern: string }>>(env, `/zones/${zoneId}/workers/routes`);
  for (const pattern of [`${domain}/*`, `*.${domain}/*`]) {
    if (existingRoutes.some((route) => route.pattern === pattern)) {
      continue;
    }
    await cfRequest(env, `/zones/${zoneId}/workers/routes`, {
      method: "POST",
      body: JSON.stringify({ pattern, script }),
    });
  }
}

export async function ensureWorkerRouteForHost(env: Env, zoneId: string, host: string): Promise<void> {
  const script = env.WORKER_SCRIPT_NAME || "link-shortener-manager";
  const pattern = `${host}/*`;
  const existingRoutes = await cfRequest<Array<{ id: string; pattern: string }>>(env, `/zones/${zoneId}/workers/routes`);
  if (existingRoutes.some((route) => route.pattern === pattern)) {
    return;
  }
  await cfRequest(env, `/zones/${zoneId}/workers/routes`, {
    method: "POST",
    body: JSON.stringify({ pattern, script }),
  });
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
  await cfRequest(env, `/zones/${zone.id}`, { method: "DELETE" });
  return { deleted: true, zoneId: zone.id, status: "deleted", message: "已删除 Cloudflare Zone。" };
}
import { configuredValue } from "./env-utils";
