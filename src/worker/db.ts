import {
  type DomainDetail,
  type DomainGroup,
  type DomainJob,
  type DomainStatus,
  type EnqueueJobInput,
  type JobStatus,
  type JobStep,
  type RedirectMode,
  type RedirectDomain,
  type ShortLink,
  type SummaryStats,
  type TargetService,
  daysAgo,
  today,
} from "./shared";
import { ProviderError } from "./provider-error";

type RowValue = string | number | null;
type Row = Record<string, RowValue>;

function bool(value: RowValue): boolean {
  return value === 1 || value === "1";
}

function text(value: RowValue): string {
  return typeof value === "string" ? value : "";
}

function optionalText(value: RowValue): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: RowValue): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function optionalNumber(value: RowValue): number | null {
  if (value === null) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseJsonArray(value: RowValue): string[] {
  if (typeof value !== "string" || value.length === 0) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function parseMetadata(value: RowValue): Record<string, unknown> | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function mapTarget(row: Row): TargetService {
  return {
    id: text(row.id),
    name: text(row.name),
    targetHost: text(row.target_host),
    forwardTargetHost: optionalText(row.forward_target_host),
    usageCount: numberValue(row.usage_count),
    description: text(row.description),
    healthStatus: (text(row.health_status) || "unknown") as TargetService["healthStatus"],
    healthHttpStatus: row.health_http_status === null || row.health_http_status === undefined ? null : numberValue(row.health_http_status),
    healthError: optionalText(row.health_error),
    healthCheckedAt: optionalText(row.health_checked_at),
    automationStatus: text(row.automation_status) || "unknown",
    nameserverStatus: text(row.nameserver_status) || "unknown",
    dnsStatus: text(row.dns_status) || "unknown",
    cloudflareZoneId: optionalText(row.cloudflare_zone_id),
    cloudflareZoneName: optionalText(row.cloudflare_zone_name),
    cloudflareZoneStatus: optionalText(row.cloudflare_zone_status),
    cloudflareNameservers: parseJsonArray(row.cloudflare_nameservers),
    dynadotStatus: text(row.dynadot_status) || "unknown",
    lastError: optionalText(row.last_error),
    lastCheckedAt: optionalText(row.last_checked_at),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

function mapGroup(row: Row): DomainGroup {
  return {
    id: text(row.id),
    name: text(row.name),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

function mapShortLink(row: Row): ShortLink {
  const targetHost = text(row.target_host);
  const code = text(row.code);
  return {
    id: text(row.id),
    targetServiceId: text(row.target_service_id),
    targetHost,
    code,
    shortUrl: `https://${targetHost}/${code}`,
    originalUrl: text(row.original_url),
    hideReferer: bool(row.hide_referer),
    visitCount: numberValue(row.traffic_visit_count ?? row.visit_count),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
    lastAccessedAt: optionalText(row.traffic_last_accessed_at ?? row.last_accessed_at),
  };
}

function mapDomain(row: Row): RedirectDomain {
  return {
    id: text(row.id),
    domain: text(row.domain),
    targetServiceId: optionalText(row.target_service_id),
    redirectMode: (text(row.redirect_mode) || "target_service") as RedirectDomain["redirectMode"],
    directTargetHost: optionalText(row.direct_target_host),
    targetForwardHost: optionalText(row.target_forward_host),
    deletedTargetHost: optionalText(row.deleted_target_host),
    targetHost: text(row.target_host),
    targetName: text(row.target_name),
    groupId: optionalText(row.group_id),
    groupName: optionalText(row.group_name),
    hideReferer: bool(row.hide_referer),
    listVisible: bool(row.list_visible),
    status: text(row.status) as DomainStatus,
    nameserverStatus: text(row.nameserver_status),
    dnsStatus: text(row.dns_status),
    routeStatus: text(row.route_status),
    cloudflareZoneId: optionalText(row.cloudflare_zone_id),
    cloudflareZoneStatus: optionalText(row.cloudflare_zone_status),
    cloudflareNameservers: parseJsonArray(row.cloudflare_nameservers),
    dynadotStatus: text(row.dynadot_status),
    lastError: optionalText(row.last_error),
    lastCheckedAt: optionalText(row.last_checked_at),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
    lastAccessedAt: optionalText(row.traffic_last_accessed_at ?? row.last_accessed_at),
    traffic: numberValue(row.traffic),
  };
}

function mapStep(row: Row): JobStep {
  return {
    id: text(row.id),
    jobId: text(row.job_id),
    step: text(row.step),
    status: text(row.status),
    message: optionalText(row.message),
    metadata: parseMetadata(row.metadata),
    createdAt: text(row.created_at),
  };
}

function mapJob(row: Row, steps: JobStep[]): DomainJob {
  return {
    id: text(row.id),
    redirectDomainId: optionalText(row.redirect_domain_id),
    type: text(row.type) as DomainJob["type"],
    subjectType: text(row.subject_type) as DomainJob["subjectType"],
    subjectId: text(row.subject_id),
    payload: parseMetadata(row.payload) ?? {},
    idempotencyKey: text(row.idempotency_key),
    status: text(row.status) as JobStatus,
    currentStep: text(row.current_step),
    errorMessage: optionalText(row.error_message),
    attemptCount: numberValue(row.attempt_count),
    maxAttempts: numberValue(row.max_attempts),
    nextAttemptAt: text(row.next_attempt_at),
    leaseToken: optionalText(row.lease_token),
    leaseExpiresAt: optionalText(row.lease_expires_at),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
    finishedAt: optionalText(row.finished_at),
    steps,
  };
}

async function all(db: D1Database, query: string, ...binds: unknown[]): Promise<Row[]> {
  const result = await db.prepare(query).bind(...binds).all<Row>();
  return result.results ?? [];
}

async function first(db: D1Database, query: string, ...binds: unknown[]): Promise<Row | null> {
  return db.prepare(query).bind(...binds).first<Row>();
}

export async function listTargets(db: D1Database): Promise<TargetService[]> {
  return (
    await all(
      db,
      `SELECT t.*, CAST(COALESCE(COUNT(DISTINCT d.id), 0) + COALESCE(COUNT(DISTINCT s.id), 0) AS INTEGER) AS usage_count
       FROM target_services t
       LEFT JOIN redirect_domains d ON d.target_service_id = t.id
       LEFT JOIN short_links s ON s.target_service_id = t.id
       GROUP BY t.id
       ORDER BY t.created_at DESC`,
    )
  ).map(mapTarget);
}

export async function createTarget(
  db: D1Database,
  input: { name: string; targetHost: string; forwardTargetHost: string | null; description: string },
): Promise<{ target: TargetService; jobId: string }> {
  const id = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  await db.batch([
    db
      .prepare("INSERT INTO target_services (id, name, target_host, forward_target_host, description, health_status) VALUES (?, ?, ?, ?, ?, 'checking')")
      .bind(id, input.name, input.targetHost, input.forwardTargetHost, input.description),
    db.prepare(
      `INSERT INTO domain_jobs
       (id, type, subject_type, subject_id, payload, idempotency_key)
       VALUES (?, 'target_repair', 'target_service', ?, '{}', ?)`,
    ).bind(jobId, id, `target_repair:${id}:initial`),
  ]);
  const row = await first(db, "SELECT *, 0 AS usage_count FROM target_services WHERE id = ?", id);
  if (!row) {
    throw new Error("target_insert_failed");
  }
  return { target: mapTarget(row), jobId };
}

export async function updateTargetForward(db: D1Database, id: string, forwardTargetHost: string | null): Promise<void> {
  await db
    .prepare(
      `UPDATE target_services
       SET forward_target_host = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ?`,
    )
    .bind(forwardTargetHost, id)
    .run();
}

export async function getTargetById(db: D1Database, id: string): Promise<TargetService | null> {
  const row = await first(
    db,
    `SELECT t.*, CAST(COALESCE(COUNT(DISTINCT d.id), 0) + COALESCE(COUNT(DISTINCT s.id), 0) AS INTEGER) AS usage_count
     FROM target_services t
     LEFT JOIN redirect_domains d ON d.target_service_id = t.id
     LEFT JOIN short_links s ON s.target_service_id = t.id
     WHERE t.id = ?
     GROUP BY t.id`,
    id,
  );
  return row ? mapTarget(row) : null;
}

export async function countDomainsForTarget(db: D1Database, targetId: string): Promise<number> {
  const row = await first(db, "SELECT COUNT(*) AS total FROM redirect_domains WHERE target_service_id = ?", targetId);
  return numberValue(row?.total ?? 0);
}

export async function countShortLinksForTarget(db: D1Database, targetId: string): Promise<number> {
  const row = await first(db, "SELECT COUNT(*) AS total FROM short_links WHERE target_service_id = ?", targetId);
  return numberValue(row?.total ?? 0);
}

export async function deleteTarget(db: D1Database, id: string, targetHost: string): Promise<{ deleted: boolean; domainsMarked: number; shortLinksDeleted: number }> {
  const [marked, shortLinks, result] = await db.batch([
    db.prepare(
      `UPDATE redirect_domains
       SET deleted_target_host = COALESCE(deleted_target_host, ?),
           target_service_id = NULL,
           status = 'failed',
           last_error = '目标服务列表中服务被删除了',
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE target_service_id = ?`,
    )
      .bind(targetHost, id),
    db.prepare("DELETE FROM short_links WHERE target_service_id = ?").bind(id),
    db.prepare("DELETE FROM target_services WHERE id = ?").bind(id),
  ]);
  return {
    deleted: (result.meta.changes ?? 0) > 0,
    domainsMarked: marked.meta.changes ?? 0,
    shortLinksDeleted: shortLinks.meta.changes ?? 0,
  };
}

export async function findTargetByHost(db: D1Database, host: string): Promise<TargetService | null> {
  const row = await first(db, "SELECT * FROM target_services WHERE target_host = ? LIMIT 1", host.toLowerCase());
  return row ? mapTarget(row) : null;
}

export async function listShortLinks(db: D1Database): Promise<ShortLink[]> {
  return (
    await all(
      db,
      `SELECT s.*, t.target_host,
         (SELECT COUNT(*) FROM traffic_daily_visitors v WHERE v.subject_type = 'short_link' AND v.subject_id = s.id) AS traffic_visit_count,
         (SELECT MAX(first_seen_at) FROM traffic_daily_visitors v WHERE v.subject_type = 'short_link' AND v.subject_id = s.id) AS traffic_last_accessed_at
       FROM short_links s
       JOIN target_services t ON t.id = s.target_service_id
       ORDER BY s.created_at DESC`,
    )
  ).map(mapShortLink);
}

export async function createShortLink(
  db: D1Database,
  input: { targetServiceId: string; code: string; originalUrl: string; hideReferer: boolean },
): Promise<ShortLink> {
  const id = crypto.randomUUID();
  await db
    .prepare("INSERT INTO short_links (id, target_service_id, code, original_url, hide_referer) VALUES (?, ?, ?, ?, ?)")
    .bind(id, input.targetServiceId, input.code, input.originalUrl, input.hideReferer ? 1 : 0)
    .run();
  const row = await first(
    db,
    `SELECT s.*, t.target_host
     FROM short_links s
     JOIN target_services t ON t.id = s.target_service_id
     WHERE s.id = ?`,
    id,
  );
  if (!row) {
    throw new Error("short_link_insert_failed");
  }
  return mapShortLink(row);
}

export async function findShortLinkByCode(db: D1Database, targetHost: string, code: string): Promise<ShortLink | null> {
  const row = await first(
    db,
    `SELECT s.*, t.target_host
     FROM short_links s
     JOIN target_services t ON t.id = s.target_service_id
     WHERE t.target_host = ? AND s.code = ?
     LIMIT 1`,
    targetHost.toLowerCase(),
    code,
  );
  return row ? mapShortLink(row) : null;
}

export async function shortLinkCodeExists(db: D1Database, targetServiceId: string, code: string): Promise<boolean> {
  const row = await first(db, "SELECT id FROM short_links WHERE target_service_id = ? AND code = ? LIMIT 1", targetServiceId, code);
  return Boolean(row);
}

export async function recordShortLinkVisit(db: D1Database, id: string, visitorKey: string): Promise<void> {
  const day = today();
  await db
    .prepare(
      `INSERT OR IGNORE INTO traffic_daily_visitors
       (subject_type, subject_id, day, visitor_key, first_seen_at)
       VALUES ('short_link', ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
    )
    .bind(id, day, visitorKey)
    .run();
}

export async function deleteShortLinks(db: D1Database, ids: string[]): Promise<number> {
  let deleted = 0;
  for (const id of ids) {
    const result = await db.prepare("DELETE FROM short_links WHERE id = ?").bind(id).run();
    deleted += result.meta.changes ?? 0;
  }
  return deleted;
}

export async function markTargetHealthChecking(db: D1Database, id: string): Promise<void> {
  await db
    .prepare(
      `UPDATE target_services
       SET health_status = 'checking', health_error = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ?`,
    )
    .bind(id)
    .run();
}

export async function updateTargetHealth(
  db: D1Database,
  id: string,
  result: { status: "ok" | "failed"; httpStatus: number | null; error: string | null },
): Promise<void> {
  await db
    .prepare(
      `UPDATE target_services
       SET health_status = ?, health_http_status = ?, health_error = ?, health_checked_at = ?,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ?`,
    )
    .bind(result.status, result.httpStatus, result.error, new Date().toISOString(), id)
    .run();
}

export async function updateTargetAutomation(
  db: D1Database,
  id: string,
  patch: Partial<{
    automationStatus: string;
    nameserverStatus: string;
    dnsStatus: string;
    cloudflareZoneId: string | null;
    cloudflareZoneName: string | null;
    cloudflareZoneStatus: string | null;
    cloudflareNameservers: string[];
    dynadotStatus: string;
    lastError: string | null;
    lastCheckedAt: string;
  }>,
): Promise<void> {
  const assignments: string[] = [];
  const binds: unknown[] = [];
  const mapping = {
    automationStatus: "automation_status",
    nameserverStatus: "nameserver_status",
    dnsStatus: "dns_status",
    cloudflareZoneId: "cloudflare_zone_id",
    cloudflareZoneName: "cloudflare_zone_name",
    cloudflareZoneStatus: "cloudflare_zone_status",
    cloudflareNameservers: "cloudflare_nameservers",
    dynadotStatus: "dynadot_status",
    lastError: "last_error",
    lastCheckedAt: "last_checked_at",
  } as const;
  for (const [key, column] of Object.entries(mapping)) {
    const value = patch[key as keyof typeof patch];
    if (value !== undefined) {
      assignments.push(`${column} = ?`);
      binds.push(Array.isArray(value) ? JSON.stringify(value) : value);
    }
  }
  assignments.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')");
  binds.push(id);
  await db.prepare(`UPDATE target_services SET ${assignments.join(", ")} WHERE id = ?`).bind(...binds).run();
}

export async function listStaleTargetIds(db: D1Database, limit = 10): Promise<string[]> {
  return (
    await all(
      db,
      `SELECT id
       FROM target_services
       WHERE health_status IN ('unknown', 'checking')
          OR health_checked_at IS NULL
          OR datetime(health_checked_at) <= datetime('now', '-30 minutes')
       ORDER BY COALESCE(health_checked_at, created_at) ASC
       LIMIT ?`,
      limit,
    )
  ).map((row) => text(row.id));
}

export async function listGroups(db: D1Database): Promise<DomainGroup[]> {
  return (await all(db, "SELECT * FROM groups ORDER BY name ASC")).map(mapGroup);
}

export async function ensureGroup(db: D1Database, name: string): Promise<DomainGroup> {
  const existing = await first(db, "SELECT * FROM groups WHERE lower(name) = lower(?)", name);
  if (existing) {
    return mapGroup(existing);
  }
  const id = crypto.randomUUID();
  await db.prepare("INSERT INTO groups (id, name) VALUES (?, ?)").bind(id, name).run();
  const row = await first(db, "SELECT * FROM groups WHERE id = ?", id);
  if (!row) {
    throw new Error("group_insert_failed");
  }
  return mapGroup(row);
}

export async function getSetting(db: D1Database, key: string): Promise<string | null> {
  const row = await first(db, "SELECT value FROM settings WHERE key = ? LIMIT 1", key);
  return optionalText(row?.value ?? null);
}

export async function setSetting(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO settings (key, value, updated_at)
       VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(key, value)
    .run();
}

export interface DomainListFilters {
  search?: string;
  groupId?: string;
  status?: string;
  days?: number;
  visitedFrom?: string;
  visitedTo?: string;
  includeHidden?: boolean;
}

export async function listDomains(db: D1Database, filters: DomainListFilters): Promise<RedirectDomain[]> {
  const clauses: string[] = [];
  const binds: unknown[] = [];
  const visitClauses: string[] = [];
  if (!filters.includeHidden) {
    clauses.push("d.list_visible = 1");
  }
  if (filters.search) {
    clauses.push("(d.domain LIKE ? OR t.target_host LIKE ? OR d.direct_target_host LIKE ? OR d.target_forward_host LIKE ? OR d.deleted_target_host LIKE ?)");
    binds.push(`%${filters.search}%`, `%${filters.search}%`, `%${filters.search}%`, `%${filters.search}%`, `%${filters.search}%`);
  }
  if (filters.groupId) {
    clauses.push("d.group_id = ?");
    binds.push(filters.groupId);
  }
  if (filters.status) {
    clauses.push("d.status = ?");
    binds.push(filters.status);
  }
  if (filters.days !== undefined) {
    if (filters.days === 0 || filters.days === -1) {
      visitClauses.push("v.day = ?");
      binds.push(daysAgo(-filters.days));
    } else if (filters.days > 0) {
      visitClauses.push("v.day BETWEEN ? AND ?");
      binds.push(daysAgo(filters.days - 1), today());
    }
  }
  if (filters.visitedFrom) {
    visitClauses.push("v.day >= ?");
    binds.push(filters.visitedFrom);
  }
  if (filters.visitedTo) {
    visitClauses.push("v.day <= ?");
    binds.push(filters.visitedTo);
  }
  if (visitClauses.length > 0) {
    clauses.push(`EXISTS (SELECT 1 FROM traffic_daily_visitors v WHERE v.subject_type = 'redirect_domain' AND v.subject_id = d.id AND ${visitClauses.join(" AND ")})`);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  return (
    await all(
      db,
      `SELECT d.*, CASE WHEN d.redirect_mode = 'direct' THEN d.direct_target_host ELSE COALESCE(t.target_host, d.deleted_target_host, '') END AS target_host,
        CASE
          WHEN d.redirect_mode = 'direct' THEN '直接跳转'
          WHEN d.target_service_id IS NULL AND d.deleted_target_host IS NOT NULL THEN '目标服务已删除'
          WHEN d.redirect_mode = 'target_service_forward' THEN '目标服务二段跳'
          ELSE t.name
        END AS target_name,
        g.name AS group_name,
        COALESCE((SELECT COUNT(*) FROM traffic_daily_visitors v WHERE v.subject_type = 'redirect_domain' AND v.subject_id = d.id), 0) AS traffic,
        (SELECT MAX(first_seen_at) FROM traffic_daily_visitors v WHERE v.subject_type = 'redirect_domain' AND v.subject_id = d.id) AS traffic_last_accessed_at
       FROM redirect_domains d
       LEFT JOIN target_services t ON t.id = d.target_service_id
       LEFT JOIN groups g ON g.id = d.group_id
       ${where}
       GROUP BY d.id
       ORDER BY d.created_at DESC`,
      ...binds,
    )
  ).map(mapDomain);
}

export async function findDomainByHost(db: D1Database, host: string): Promise<RedirectDomain | null> {
  const labels = host.toLowerCase().split(".");
  const candidates = labels.map((_, index) => labels.slice(index).join(".")).slice(0, -1);
  if (candidates.length === 0) {
    return null;
  }
  const row = await first(
    db,
    `SELECT d.*, CASE WHEN d.redirect_mode = 'direct' THEN d.direct_target_host ELSE COALESCE(t.target_host, d.deleted_target_host, '') END AS target_host,
        CASE
          WHEN d.redirect_mode = 'direct' THEN '直接跳转'
          WHEN d.target_service_id IS NULL AND d.deleted_target_host IS NOT NULL THEN '目标服务已删除'
          WHEN d.redirect_mode = 'target_service_forward' THEN '目标服务二段跳'
          ELSE t.name
        END AS target_name,
        g.name AS group_name, 0 AS traffic
       FROM redirect_domains d
       LEFT JOIN target_services t ON t.id = d.target_service_id
       LEFT JOIN groups g ON g.id = d.group_id
       WHERE d.domain IN (SELECT value FROM json_each(?))
         AND d.list_visible = 1 AND d.status IN ('active', 'route_configured', 'waiting_nameserver')
       ORDER BY length(d.domain) DESC
       LIMIT 1`,
    JSON.stringify(candidates),
  );
  return row ? mapDomain(row) : null;
}

export async function getDomainDetail(db: D1Database, id: string): Promise<DomainDetail | null> {
  const domain = await getDomainById(db, id);
  if (!domain) {
    return null;
  }
  const traffic = await first(
    db,
    `SELECT COUNT(*) AS total, MAX(first_seen_at) AS last_accessed_at
     FROM traffic_daily_visitors WHERE subject_type = 'redirect_domain' AND subject_id = ?`,
    id,
  );
  domain.traffic = numberValue(traffic?.total ?? 0);
  domain.lastAccessedAt = optionalText(traffic?.last_accessed_at ?? null);
  const jobRows = await all(db, "SELECT * FROM domain_jobs WHERE redirect_domain_id = ? ORDER BY created_at DESC", id);
  const stepRows = await all(
    db,
    `SELECT s.* FROM job_steps s
     JOIN domain_jobs j ON j.id = s.job_id
     WHERE j.redirect_domain_id = ?
     ORDER BY s.created_at ASC`,
    id,
  );
  const steps = stepRows.map(mapStep);
  const jobs = jobRows.map((row) => mapJob(row, steps.filter((step) => step.jobId === text(row.id))));
  const sources = (
    await all(
      db,
      `SELECT COALESCE(NULLIF(referer_host, ''), '直接访问') AS referer, COUNT(*) AS visits
       FROM traffic_daily_visitors
       WHERE subject_type = 'redirect_domain' AND subject_id = ?
       GROUP BY COALESCE(NULLIF(referer_host, ''), '直接访问')
       ORDER BY visits DESC
       LIMIT 20`,
      id,
    )
  ).map((row) => ({ referer: text(row.referer), visits: numberValue(row.visits) }));
  const trend = (
    await all(
      db,
      `SELECT day, COUNT(*) AS visits FROM traffic_daily_visitors
       WHERE subject_type = 'redirect_domain' AND subject_id = ? AND day >= ?
       GROUP BY day
       ORDER BY day ASC`,
      id,
      daysAgo(30),
    )
  ).map((row) => ({ day: text(row.day), visits: numberValue(row.visits) }));
  const countries = (
    await all(
      db,
      `SELECT country, COUNT(*) AS visits
       FROM traffic_daily_visitors
       WHERE subject_type = 'redirect_domain' AND subject_id = ?
       GROUP BY country
       ORDER BY visits DESC
       LIMIT 50`,
      id,
    )
  ).map((row) => ({ country: optionalText(row.country), visits: numberValue(row.visits) }));
  const regions = (
    await all(
      db,
      `SELECT country, region, COUNT(*) AS visits
       FROM traffic_daily_visitors
       WHERE subject_type = 'redirect_domain' AND subject_id = ?
       GROUP BY country, region
       ORDER BY visits DESC
       LIMIT 50`,
      id,
    )
  ).map((row) => ({ country: optionalText(row.country), region: optionalText(row.region), visits: numberValue(row.visits) }));
  const cities = (
    await all(
      db,
      `SELECT country, region, city, COUNT(*) AS visits
       FROM traffic_daily_visitors
       WHERE subject_type = 'redirect_domain' AND subject_id = ?
       GROUP BY country, region, city
       ORDER BY visits DESC
       LIMIT 50`,
      id,
    )
  ).map((row) => ({
    country: optionalText(row.country),
    region: optionalText(row.region),
    city: optionalText(row.city),
    visits: numberValue(row.visits),
  }));
  const locations = (
    await all(
      db,
      `SELECT country, city, latitude, longitude, COUNT(*) AS visits
       FROM traffic_daily_visitors
       WHERE subject_type = 'redirect_domain' AND subject_id = ?
         AND latitude IS NOT NULL
         AND longitude IS NOT NULL
       GROUP BY country, city, latitude, longitude
       ORDER BY visits DESC
       LIMIT 80`,
      id,
    )
  )
    .map((row) => ({
      country: optionalText(row.country),
      city: optionalText(row.city),
      latitude: optionalNumber(row.latitude),
      longitude: optionalNumber(row.longitude),
      visits: numberValue(row.visits),
    }))
    .filter((row): row is { country: string | null; city: string | null; latitude: number; longitude: number; visits: number } => (
      row.latitude !== null && row.longitude !== null
    ));
  const languages = (
    await all(
      db,
      `SELECT language, COUNT(*) AS visits
       FROM traffic_daily_visitors
       WHERE subject_type = 'redirect_domain' AND subject_id = ?
       GROUP BY language
       ORDER BY visits DESC
       LIMIT 20`,
      id,
    )
  ).map((row) => ({ language: optionalText(row.language), visits: numberValue(row.visits) }));
  const timezones = (
    await all(
      db,
      `SELECT timezone, COUNT(*) AS visits
       FROM traffic_daily_visitors
       WHERE subject_type = 'redirect_domain' AND subject_id = ?
       GROUP BY timezone
       ORDER BY visits DESC
       LIMIT 20`,
      id,
    )
  ).map((row) => ({ timezone: optionalText(row.timezone), visits: numberValue(row.visits) }));
  const operatingSystems = (
    await all(
      db,
      `SELECT operating_system, COUNT(*) AS visits
       FROM traffic_daily_visitors
       WHERE subject_type = 'redirect_domain' AND subject_id = ?
       GROUP BY operating_system
       ORDER BY visits DESC
       LIMIT 20`,
      id,
    )
  ).map((row) => ({ operatingSystem: optionalText(row.operating_system), visits: numberValue(row.visits) }));
  const browsers = (
    await all(
      db,
      `SELECT browser, COUNT(*) AS visits
       FROM traffic_daily_visitors
       WHERE subject_type = 'redirect_domain' AND subject_id = ?
       GROUP BY browser
       ORDER BY visits DESC
       LIMIT 20`,
      id,
    )
  ).map((row) => ({ browser: optionalText(row.browser), visits: numberValue(row.visits) }));
  const deviceTypes = (
    await all(
      db,
      `SELECT device_type, COUNT(*) AS visits
       FROM traffic_daily_visitors
       WHERE subject_type = 'redirect_domain' AND subject_id = ?
       GROUP BY device_type
       ORDER BY visits DESC
       LIMIT 20`,
      id,
    )
  ).map((row) => ({ deviceType: optionalText(row.device_type), visits: numberValue(row.visits) }));
  const recentVisits = (
    await all(
      db,
      `SELECT ROW_NUMBER() OVER (ORDER BY first_seen_at DESC) AS id,
         first_seen_at, referer_host, country, region, city, timezone, latitude, longitude, language, operating_system, browser, device_type
       FROM traffic_daily_visitors
       WHERE subject_type = 'redirect_domain' AND subject_id = ?
       ORDER BY first_seen_at DESC
       LIMIT 50`,
      id,
    )
  ).map((row) => ({
    id: String(row.id),
    host: domain.domain,
    path: "/",
    referer: optionalText(row.referer_host),
    country: optionalText(row.country),
    region: optionalText(row.region),
    city: optionalText(row.city),
    timezone: optionalText(row.timezone),
    latitude: optionalNumber(row.latitude),
    longitude: optionalNumber(row.longitude),
    language: optionalText(row.language),
    operatingSystem: optionalText(row.operating_system),
    browser: optionalText(row.browser),
    deviceType: optionalText(row.device_type),
    userAgent: null,
    targetHost: domain.targetHost,
    hideReferer: domain.hideReferer,
    visitedAt: text(row.first_seen_at),
  }));
  return {
    ...domain,
    jobs,
    sources,
    trend,
    geography: { countries, regions, cities, locations },
    clientStats: { languages, timezones, operatingSystems, browsers, deviceTypes },
    recentVisits,
  };
}

export async function createRedirectDomain(
  db: D1Database,
  input: {
    domain: string;
    redirectMode: RedirectMode;
    targetServiceId: string | null;
    directTargetHost: string | null;
    targetForwardHost: string | null;
    groupId: string | null;
    hideReferer: boolean;
  },
): Promise<{ domain: RedirectDomain; jobId: string }> {
  const id = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  await db.batch([
    db
      .prepare(
        `INSERT INTO redirect_domains
         (id, domain, target_service_id, redirect_mode, direct_target_host, target_forward_host, group_id, hide_referer, list_visible)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      )
      .bind(
        id,
        input.domain,
        input.targetServiceId,
        input.redirectMode,
        input.directTargetHost,
        input.targetForwardHost,
        input.groupId,
        input.hideReferer ? 1 : 0,
      ),
    db.prepare(
      `INSERT INTO domain_jobs
       (id, redirect_domain_id, type, subject_type, subject_id, payload, idempotency_key)
       VALUES (?, ?, 'domain_provision', 'redirect_domain', ?, '{}', ?)`,
    ).bind(jobId, id, id, `domain_provision:${id}`),
  ]);
  const domain = await getDomainById(db, id);
  if (!domain) {
    throw new Error("domain_insert_failed");
  }
  return { domain, jobId };
}

export async function getDomainById(db: D1Database, id: string): Promise<RedirectDomain | null> {
  const row = await first(
    db,
    `SELECT d.*, CASE WHEN d.redirect_mode = 'direct' THEN d.direct_target_host ELSE COALESCE(t.target_host, d.deleted_target_host, '') END AS target_host,
       CASE
         WHEN d.redirect_mode = 'direct' THEN '直接跳转'
         WHEN d.target_service_id IS NULL AND d.deleted_target_host IS NOT NULL THEN '目标服务已删除'
         WHEN d.redirect_mode = 'target_service_forward' THEN '目标服务二段跳'
         ELSE t.name
       END AS target_name,
       g.name AS group_name, 0 AS traffic
     FROM redirect_domains d
     LEFT JOIN target_services t ON t.id = d.target_service_id
     LEFT JOIN groups g ON g.id = d.group_id
     WHERE d.id = ?`,
    id,
  );
  return row ? mapDomain(row) : null;
}

export async function findDomainByName(db: D1Database, domain: string): Promise<RedirectDomain | null> {
  const row = await first(
    db,
    `SELECT d.*, CASE WHEN d.redirect_mode = 'direct' THEN d.direct_target_host ELSE COALESCE(t.target_host, d.deleted_target_host, '') END AS target_host,
       CASE
         WHEN d.redirect_mode = 'direct' THEN '直接跳转'
         WHEN d.target_service_id IS NULL AND d.deleted_target_host IS NOT NULL THEN '目标服务已删除'
         WHEN d.redirect_mode = 'target_service_forward' THEN '目标服务二段跳'
         ELSE t.name
       END AS target_name,
       g.name AS group_name, 0 AS traffic
     FROM redirect_domains d
     LEFT JOIN target_services t ON t.id = d.target_service_id
     LEFT JOIN groups g ON g.id = d.group_id
     WHERE d.domain = ?`,
    domain,
  );
  return row ? mapDomain(row) : null;
}

export async function findDomainForwardTarget(db: D1Database, id: string, targetHost: string): Promise<{ targetHost: string; hideReferer: boolean } | null> {
  const row = await first(
    db,
    `SELECT d.target_forward_host, d.hide_referer
     FROM redirect_domains d
     JOIN target_services t ON t.id = d.target_service_id
     WHERE d.id = ?
       AND d.redirect_mode = 'target_service_forward'
       AND t.target_host = ?
       AND d.target_forward_host IS NOT NULL
       AND d.list_visible = 1
       AND d.status IN ('active', 'route_configured', 'waiting_nameserver')
     LIMIT 1`,
    id,
    targetHost.toLowerCase(),
  );
  const forwardHost = optionalText(row?.target_forward_host ?? null);
  return row && forwardHost ? { targetHost: forwardHost, hideReferer: bool(row.hide_referer) } : null;
}

export async function addJobStep(
  db: D1Database,
  jobId: string,
  step: string,
  status: string,
  message?: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await db
    .prepare("INSERT INTO job_steps (id, job_id, step, status, message, metadata) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), jobId, step, status, message ?? null, metadata ? JSON.stringify(metadata) : null)
    .run();
  await db
    .prepare("UPDATE domain_jobs SET current_step = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND status = 'running'")
    .bind(step, jobId)
    .run();
}

export async function updateDomainAutomation(
  db: D1Database,
  id: string,
  patch: Partial<{
    status: DomainStatus;
    nameserverStatus: string;
    dnsStatus: string;
    routeStatus: string;
    cloudflareZoneId: string | null;
    cloudflareZoneStatus: string | null;
    cloudflareNameservers: string[];
    dynadotStatus: string;
    lastError: string | null;
    lastCheckedAt: string;
    listVisible: boolean;
  }>,
): Promise<void> {
  const assignments: string[] = [];
  const binds: unknown[] = [];
  const mapping = {
    status: "status",
    nameserverStatus: "nameserver_status",
    dnsStatus: "dns_status",
    routeStatus: "route_status",
    cloudflareZoneId: "cloudflare_zone_id",
    cloudflareZoneStatus: "cloudflare_zone_status",
    cloudflareNameservers: "cloudflare_nameservers",
    dynadotStatus: "dynadot_status",
    lastError: "last_error",
    lastCheckedAt: "last_checked_at",
    listVisible: "list_visible",
  } as const;
  for (const [key, column] of Object.entries(mapping)) {
    const value = patch[key as keyof typeof patch];
    if (value !== undefined) {
      // A configuration retry must not take an already serving domain offline.
      assignments.push(key === "status" || key === "listVisible"
        ? `${column} = CASE WHEN status = 'active' AND list_visible = 1 THEN ${column} ELSE ? END`
        : `${column} = ?`);
      binds.push(typeof value === "boolean" ? (value ? 1 : 0) : Array.isArray(value) ? JSON.stringify(value) : value);
    }
  }
  assignments.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')");
  binds.push(id);
  await db.prepare(`UPDATE redirect_domains SET ${assignments.join(", ")} WHERE id = ?`).bind(...binds).run();
}

export async function retryDomain(
  db: D1Database,
  id: string,
  idempotencyKey: string,
): Promise<{ id: string; status: JobStatus }> {
  const jobId = crypto.randomUUID();
  const results = await db.batch<{ id: string; status: JobStatus }>([
    db.prepare(
      `INSERT INTO domain_jobs
       (id, redirect_domain_id, type, subject_type, subject_id, payload, idempotency_key)
       SELECT ?, ?, 'domain_retry', 'redirect_domain', ?, '{}', ?
       WHERE NOT EXISTS (
         SELECT 1 FROM domain_jobs
         WHERE subject_type = 'redirect_domain' AND subject_id = ?
           AND type IN ('domain_provision', 'domain_retry')
           AND status IN ('queued', 'running', 'retry_wait')
       )
       ON CONFLICT(idempotency_key) DO NOTHING`,
    ).bind(jobId, id, id, idempotencyKey, id),
    db
      .prepare(
        `UPDATE redirect_domains
         SET status = 'validating',
             last_error = NULL,
             list_visible = 0,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ? AND NOT (status = 'active' AND list_visible = 1)
           AND EXISTS (SELECT 1 FROM domain_jobs WHERE id = ?)`,
      )
      .bind(id, jobId),
    db.prepare(
      `SELECT id, status FROM domain_jobs
       WHERE (subject_type = 'redirect_domain' AND subject_id = ?
         AND type IN ('domain_provision', 'domain_retry')
         AND status IN ('queued', 'running', 'retry_wait'))
         OR idempotency_key = ?
       ORDER BY CASE WHEN status IN ('queued', 'running', 'retry_wait') THEN 0 ELSE 1 END, created_at DESC
       LIMIT 1`,
    ).bind(id, idempotencyKey),
  ]);
  const row = results[2].results[0];
  if (!row) {
    throw new Error("job_enqueue_failed");
  }
  return row;
}

export async function deleteDomains(db: D1Database, ids: string[]): Promise<number> {
  let deleted = 0;
  for (const id of ids) {
    const result = await db.prepare("DELETE FROM redirect_domains WHERE id = ?").bind(id).run();
    deleted += result.meta.changes ?? 0;
  }
  return deleted;
}

export async function recordVisit(
  db: D1Database,
  input: {
    redirectDomainId: string;
    country: string | null;
    region: string | null;
    city: string | null;
    timezone: string | null;
    latitude: number | null;
    longitude: number | null;
    language: string | null;
    operatingSystem: string | null;
    browser: string | null;
    deviceType: string | null;
    refererHost: string | null;
    visitorKey: string;
  },
): Promise<void> {
  const day = today();
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT OR IGNORE INTO traffic_daily_visitors
       (subject_type, subject_id, day, visitor_key, first_seen_at, referer_host, country, region, city, latitude, longitude, timezone, language, operating_system, browser, device_type)
       VALUES ('redirect_domain', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(input.redirectDomainId, day, input.visitorKey, now, input.refererHost, input.country, input.region, input.city, input.latitude, input.longitude, input.timezone, input.language, input.operatingSystem, input.browser, input.deviceType)
    .run();
}

export async function summaryStats(db: D1Database): Promise<SummaryStats> {
  const domainStats = await first(
    db,
    `SELECT COUNT(*) AS total,
       SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
       SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
       SUM(CASE WHEN status = 'waiting_nameserver' THEN 1 ELSE 0 END) AS waiting
     FROM redirect_domains`,
  );
  const visits = await first(
    db,
    `SELECT COUNT(*) AS visits
     FROM traffic_daily_visitors v
     JOIN redirect_domains d ON d.id = v.subject_id
     WHERE v.subject_type = 'redirect_domain' AND d.list_visible = 1 AND d.status = 'active'`,
  );
  const visitsToday = await first(
    db,
    `SELECT COUNT(*) AS visits
     FROM traffic_daily_visitors v
     JOIN redirect_domains d ON d.id = v.subject_id
     WHERE v.subject_type = 'redirect_domain' AND d.list_visible = 1 AND d.status = 'active' AND v.day = ?`,
    today(),
  );
  return {
    totalDomains: numberValue(domainStats?.total ?? 0),
    activeDomains: numberValue(domainStats?.active ?? 0),
    failedDomains: numberValue(domainStats?.failed ?? 0),
    waitingDomains: numberValue(domainStats?.waiting ?? 0),
    visits: numberValue(visits?.visits ?? 0),
    visitsToday: numberValue(visitsToday?.visits ?? 0),
  };
}

export async function enqueueJob(
  db: D1Database,
  input: EnqueueJobInput,
): Promise<{ id: string; status: JobStatus }> {
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO domain_jobs
       (id, redirect_domain_id, type, subject_type, subject_id, payload, idempotency_key, max_attempts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(idempotency_key) DO NOTHING`,
    )
    .bind(
      id,
      input.redirectDomainId ?? null,
      input.type,
      input.subjectType,
      input.subjectId,
      JSON.stringify(input.payload),
      input.idempotencyKey,
      input.maxAttempts ?? 5,
    )
    .run();
  const row = await db
    .prepare("SELECT id, status FROM domain_jobs WHERE idempotency_key = ?")
    .bind(input.idempotencyKey)
    .first<{ id: string; status: JobStatus }>();
  if (!row) {
    throw new Error("job_enqueue_failed");
  }
  return row;
}

export async function getJobById(db: D1Database, id: string): Promise<DomainJob | null> {
  const row = await first(db, "SELECT * FROM domain_jobs WHERE id = ?", id);
  if (!row) {
    return null;
  }
  const steps = (await all(db, "SELECT * FROM job_steps WHERE job_id = ? ORDER BY created_at", id)).map(mapStep);
  return mapJob(row, steps);
}

export async function claimNextJob(db: D1Database, leaseSeconds = 600): Promise<DomainJob | null> {
  // shortcut: one global lease serializes provider changes; use per-subject leases if sustained backlog requires concurrency.
  const now = new Date().toISOString();
  const leaseToken = crypto.randomUUID();
  const leaseExpiresAt = new Date(Date.now() + leaseSeconds * 1000).toISOString();
  const row = await db
    .prepare(
      `UPDATE domain_jobs
       SET status = 'running',
           lease_token = ?,
           lease_expires_at = ?,
           attempt_count = attempt_count + 1,
           updated_at = ?
       WHERE id = (
         SELECT id
         FROM domain_jobs
         WHERE (
           (status IN ('queued', 'retry_wait') AND next_attempt_at <= ?)
           OR (status = 'running' AND lease_expires_at <= ?)
         )
           AND NOT EXISTS (
             SELECT 1 FROM domain_jobs
             WHERE status = 'running' AND lease_expires_at > ?
           )
         ORDER BY created_at
         LIMIT 1
       )
       RETURNING *`,
    )
    .bind(leaseToken, leaseExpiresAt, now, now, now, now)
    .first<Row>();
  return row ? mapJob(row, []) : null;
}

export async function completeJob(db: D1Database, jobId: string, leaseToken: string): Promise<void> {
  await db
    .prepare(
      `UPDATE domain_jobs
       SET status = 'completed', current_step = 'completed', error_message = NULL,
           lease_token = NULL, lease_expires_at = NULL,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND status = 'running' AND lease_token = ?`,
    )
    .bind(jobId, leaseToken)
    .run();
}

export async function setJobResult(
  db: D1Database,
  jobId: string,
  leaseToken: string,
  result: Record<string, unknown>,
): Promise<void> {
  await db
    .prepare(
      `UPDATE domain_jobs
       SET payload = json_set(payload, '$.result', json(?)),
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND status = 'running' AND lease_token = ?`,
    )
    .bind(JSON.stringify(result), jobId, leaseToken)
    .run();
}

export async function recordJobFailure(
  db: D1Database,
  jobId: string,
  leaseToken: string,
  error: unknown,
): Promise<JobStatus> {
  const job = await getJobById(db, jobId);
  if (!job || job.status !== "running" || job.leaseToken !== leaseToken) {
    return job?.status ?? "failed";
  }
  const nameserverPending = error instanceof ProviderError && error.code === "nameserver_pending";
  const withinNameserverWindow = Date.now() - Date.parse(job.createdAt) < 48 * 60 * 60_000;
  const retryable = nameserverPending
    ? withinNameserverWindow
    : error instanceof ProviderError && error.retryable && job.attemptCount < job.maxAttempts;
  const status: JobStatus = retryable ? "retry_wait" : "failed";
  const delaySeconds = nameserverPending
    ? 300
    : Math.min(3600, 30 * 2 ** Math.max(0, job.attemptCount - 1));
  const message = nameserverPending && !retryable
    ? "Nameserver 在 48 小时内未生效，请检查注册商设置后重试。"
    : error instanceof ProviderError ? error.message : "任务执行失败。";
  const statements: D1PreparedStatement[] = [];
  if (nameserverPending && !retryable) {
    if (job.redirectDomainId) {
      statements.push(db.prepare(
        `UPDATE redirect_domains
         SET status = CASE WHEN status = 'active' AND list_visible = 1 THEN status ELSE 'failed' END,
             last_error = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ? AND EXISTS (
           SELECT 1 FROM domain_jobs WHERE id = ? AND status = 'running' AND lease_token = ?
         )`,
      ).bind(message, job.redirectDomainId, jobId, leaseToken));
    } else if (job.type === "target_repair") {
      statements.push(db.prepare(
        `UPDATE target_services SET automation_status = 'failed', last_error = ?,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ? AND EXISTS (
           SELECT 1 FROM domain_jobs WHERE id = ? AND status = 'running' AND lease_token = ?
         )`,
      ).bind(message, job.subjectId, jobId, leaseToken));
    }
  }
  statements.push(db.prepare(
      `UPDATE domain_jobs
       SET status = ?, error_message = ?, next_attempt_at = ?,
           current_step = CASE WHEN ? THEN 'waiting_nameserver' ELSE current_step END,
           lease_token = NULL, lease_expires_at = NULL,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           finished_at = CASE WHEN ? = 'failed' THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE NULL END
       WHERE id = ? AND status = 'running' AND lease_token = ?`,
    )
    .bind(
      status,
      message,
      new Date(Date.now() + delaySeconds * 1000).toISOString(),
      nameserverPending ? 1 : 0,
      status,
      jobId,
      leaseToken,
    ));
  await db.batch(statements);
  return status;
}

export async function cleanupVisits(db: D1Database, retentionDays: number): Promise<void> {
  const days = Number.isInteger(retentionDays) && retentionDays > 0 ? retentionDays : 30;
  const cutoff = daysAgo(days - 1);
  await db.prepare("DELETE FROM traffic_daily_visitors WHERE day < ?").bind(cutoff).run();
}
