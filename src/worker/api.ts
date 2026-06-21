import { clearSessionCookie, createSessionCookie, hashPasswordForDocs, requireSession, verifyPassword } from "./auth";
import { processDomainJob } from "./automation";
import { deleteZoneByName, ensureZone, listZones } from "./cloudflare";
import {
  createShortLink,
  createRedirectDomain,
  createTarget,
  countDomainsForTarget,
  countShortLinksForTarget,
  deleteTarget,
  deleteDomains,
  deleteShortLinks,
  ensureGroup,
  findDomainByName,
  getDomainDetail,
  getTargetById,
  listDomains,
  listGroups,
  listShortLinks,
  listTargets,
  markTargetHealthChecking,
  retryDomain,
  setSetting,
  shortLinkCodeExists,
  summaryStats,
  updateTargetForward,
  withOperationLock,
} from "./db";
import { isDomainInDynadot, setNameservers } from "./dynadot";
import { HttpError, fail, ok, readJson } from "./http";
import { configuredValue, hasConfiguredValue, secret } from "./env-utils";
import { type RedirectMode, isValidDomain, normalizeDomain } from "./shared";
import { repairTargetService } from "./target-automation";
import { refreshTargetHealth } from "./target-health";

interface LoginBody {
  password?: string;
}

interface ChangePasswordBody {
  currentPassword?: string;
  newPassword?: string;
}

interface UpdateRegistrarSettingsBody {
  cloudflareAccountId?: string;
  cloudflareApiToken?: string;
  dynadotApiKey?: string;
  dynadotSandbox?: boolean;
}

interface NameserverToolBody {
  domains?: string[] | string;
  registrarId?: string;
}

interface DeleteCloudflareZonesBody {
  domains?: string[] | string;
  confirmDelete?: boolean;
}

interface CreateTargetBody {
  name?: string;
  targetHost?: string;
  forwardTargetHost?: string | null;
  description?: string;
}

interface UpdateTargetForwardBody {
  forwardTargetHost?: string | null;
}

interface CreateGroupBody {
  name?: string;
}

interface CreateDomainsBody {
  domains?: string[] | string;
  redirectMode?: RedirectMode;
  targetServiceId?: string;
  directTargetHost?: string;
  targetForwardHost?: string;
  groupId?: string | null;
  newGroupName?: string;
  hideReferer?: boolean;
}

interface DeleteDomainsBody {
  ids?: string[];
  cleanupRoutes?: boolean;
  cleanupDns?: boolean;
  cleanupZone?: boolean;
}

interface CreateShortLinkBody {
  targetServiceId?: string;
  url?: string;
  hideReferer?: boolean;
}

interface DeleteShortLinksBody {
  ids?: string[];
}

function assertMethod(request: Request, method: string): void {
  if (request.method !== method) {
    throw new HttpError(404, "not_found", "接口不存在。");
  }
}

function splitDomains(input: string[] | string | undefined): string[] {
  const values = Array.isArray(input) ? input : String(input ?? "").split(/\r?\n|,/);
  return [...new Set(values.map(normalizeDomain).filter(Boolean))];
}

function query(url: URL, key: string): string | undefined {
  const value = url.searchParams.get(key);
  return value && value.length > 0 ? value : undefined;
}

function optionalDomain(input: string | null | undefined): string | null {
  const value = normalizeDomain(input ?? "");
  return value.length > 0 ? value : null;
}

function optionalRedirectUrl(input: string | null | undefined): string | null {
  const value = (input ?? "").trim();
  if (!value) {
    return null;
  }
  const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  let url: URL;
  try {
    url = new URL(withProtocol);
  } catch {
    throw new HttpError(400, "bad_request", "跳转目标 URL 格式不合法。");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new HttpError(400, "bad_request", "跳转目标只支持 http:// 或 https://。");
  }
  if (!isValidDomain(normalizeDomain(url.hostname))) {
    throw new HttpError(400, "bad_request", "跳转目标 URL 的主机名不合法。");
  }
  return url.href;
}

function normalizeHttpUrl(input: string | undefined): string {
  const value = (input ?? "").trim();
  if (!value) {
    throw new HttpError(400, "bad_request", "请输入需要缩短的 URL。");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(400, "bad_request", "URL 格式不合法，请输入包含 http:// 或 https:// 的完整地址。");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new HttpError(400, "bad_request", "短链接目标只支持 http:// 或 https://。");
  }
  return url.href;
}

const SHORT_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
const RESERVED_SHORT_CODES = new Set(["api", "go", "admin", "login", "logout", "settings"]);

function randomShortCode(length = 6): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => SHORT_CODE_ALPHABET[byte % SHORT_CODE_ALPHABET.length]).join("");
}

async function generateShortCode(db: D1Database, targetServiceId: string): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const code = randomShortCode(attempt < 7 ? 6 : 8);
    if (!RESERVED_SHORT_CODES.has(code.toLowerCase()) && !(await shortLinkCodeExists(db, targetServiceId, code))) {
      return code;
    }
  }
  throw new HttpError(500, "server_error", "短码生成失败，请重试。");
}

async function registrarStatus(env: Env) {
  const dynadotSandbox = String(await configuredValue(env, "DYNADOT_SANDBOX")) === "true";
  return {
    providers: [
      {
        id: "cloudflare",
        name: "Cloudflare",
        role: "DNS / Zone / Nameserver 来源",
        automation: "已支持：创建/查找 Zone，并返回当前 Cloudflare Nameserver。",
        configured: Boolean((await configuredValue(env, "CLOUDFLARE_ACCOUNT_ID")) && (await configuredValue(env, "CLOUDFLARE_API_TOKEN"))),
      },
      {
        id: "dynadot",
        name: "Dynadot",
        role: "注册商 Nameserver 写入",
        automation: "已支持：domain_info 检查归属，set_ns 写入 Cloudflare Nameserver。",
        configured: Boolean(await configuredValue(env, "DYNADOT_API_KEY")),
        sandbox: dynadotSandbox,
      },
      {
        id: "manual",
        name: "其他注册商",
        role: "手动 Nameserver 配置",
        automation: "暂未接入 API。可用 NS 工具先取得 Cloudflare Nameserver，再复制到注册商后台。",
        configured: true,
      },
    ],
  };
}

async function runNameserverTool(env: Env, input: NameserverToolBody) {
  return withOperationLock(env.DB, () => runNameserverToolUnlocked(env, input));
}

async function runNameserverToolUnlocked(env: Env, input: NameserverToolBody) {
  const registrarId = input.registrarId || "manual";
  const domains = splitDomains(input.domains);
  if (domains.length === 0) {
    throw new HttpError(400, "bad_request", "请至少输入一个域名。");
  }
  if (domains.length > 1) {
    throw new HttpError(400, "bad_request", "该接口一次只处理一个域名，请由前端逐个提交。");
  }
  const results: Array<{ domain: string; ok: boolean; status: string; message: string; nameservers: string[]; zoneStatus?: string }> = [];
  for (const rawDomain of domains) {
    const domain = normalizeDomain(rawDomain);
    if (!isValidDomain(domain)) {
      results.push({ domain: rawDomain, ok: false, status: "failed", message: "域名格式不合法。", nameservers: [] });
      continue;
    }
    try {
      const zone = await ensureZone(env, domain);
      if (zone.nameServers.length === 0) {
        results.push({ domain, ok: false, status: "failed", message: "Cloudflare 未返回 Nameserver。", nameservers: [], zoneStatus: zone.status });
        continue;
      }
      if (registrarId === "dynadot") {
        const owned = await isDomainInDynadot(env, domain);
        if (!owned) {
          results.push({
            domain,
            ok: false,
            status: "manual_required",
            message: "Dynadot 未找到该域名，请复制下方 Nameserver 到当前注册商后台手动设置。",
            nameservers: zone.nameServers,
            zoneStatus: zone.status,
          });
          continue;
        }
        await setNameservers(env, domain, zone.nameServers);
        results.push({
          domain,
          ok: true,
          status: "submitted",
          message: "已提交 Dynadot set_ns，等待注册商和 Cloudflare 生效。",
          nameservers: zone.nameServers,
          zoneStatus: zone.status,
        });
        continue;
      }
      results.push({
        domain,
        ok: true,
        status: "manual_required",
        message: "已添加/确认 Cloudflare Zone。请复制 Nameserver 到注册商后台手动设置。",
        nameservers: zone.nameServers,
        zoneStatus: zone.status,
      });
    } catch (error) {
      results.push({
        domain,
        ok: false,
        status: "failed",
        message: error instanceof Error ? error.message : "处理失败。",
        nameservers: [],
      });
    }
  }
  return { results };
}

async function deleteCloudflareZones(env: Env, input: DeleteCloudflareZonesBody) {
  return withOperationLock(env.DB, () => deleteCloudflareZonesUnlocked(env, input));
}

async function deleteCloudflareZonesUnlocked(env: Env, input: DeleteCloudflareZonesBody) {
  if (!input.confirmDelete) {
    throw new HttpError(400, "bad_request", "请确认删除 Cloudflare Zone。");
  }
  const domains = splitDomains(input.domains);
  if (domains.length === 0) {
    throw new HttpError(400, "bad_request", "请至少输入一个域名。");
  }
  if (domains.length > 1) {
    throw new HttpError(400, "bad_request", "该接口一次只处理一个域名，请由前端逐个提交。");
  }
  const results: Array<{ domain: string; ok: boolean; status: string; message: string; zoneId?: string }> = [];
  for (const rawDomain of domains) {
    const domain = normalizeDomain(rawDomain);
    if (!isValidDomain(domain)) {
      results.push({ domain: rawDomain, ok: false, status: "failed", message: "域名格式不合法。" });
      continue;
    }
    try {
      const result = await deleteZoneByName(env, domain);
      results.push({
        domain,
        ok: result.deleted || result.status === "not_found",
        status: result.status,
        message: result.message,
        zoneId: result.zoneId,
      });
    } catch (error) {
      results.push({
        domain,
        ok: false,
        status: "failed",
        message: error instanceof Error ? error.message : "删除失败。",
      });
    }
  }
  return { results };
}

export async function handleApi(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const pathname = url.pathname;

  if (pathname === "/api/auth/login") {
    assertMethod(request, "POST");
    const body = await readJson<LoginBody>(request);
    if (!body.password) {
      throw new HttpError(400, "bad_request", "请输入后台密码。");
    }
    const valid = await verifyPassword(env, body.password);
    if (!valid) {
      throw new HttpError(401, "unauthorized", "密码不正确。");
    }
    return ok(
      { authenticated: true },
      {
        headers: {
          "Set-Cookie": await createSessionCookie(env),
        },
      },
    );
  }

  if (pathname === "/api/auth/logout") {
    assertMethod(request, "POST");
    return ok(
      { authenticated: false },
      {
        headers: {
          "Set-Cookie": clearSessionCookie(),
        },
      },
    );
  }

  if (pathname === "/api/me") {
    try {
      await requireSession(request, env);
      return ok({ authenticated: true });
    } catch {
      return ok({ authenticated: false });
    }
  }

  await requireSession(request, env);

  if (pathname === "/api/auth/password") {
    assertMethod(request, "POST");
    const body = await readJson<ChangePasswordBody>(request);
    if (!body.currentPassword || !body.newPassword) {
      throw new HttpError(400, "bad_request", "请输入当前密码和新密码。");
    }
    if (body.newPassword.length < 10) {
      throw new HttpError(400, "bad_request", "新密码至少需要 10 位。");
    }
    const valid = await verifyPassword(env, body.currentPassword);
    if (!valid) {
      throw new HttpError(401, "unauthorized", "当前密码不正确。");
    }
    await setSetting(env.DB, "ADMIN_PASSWORD_HASH", await hashPasswordForDocs(body.newPassword));
    return ok(
      { updated: true },
      {
        headers: {
          "Set-Cookie": await createSessionCookie(env),
        },
      },
    );
  }

  if (pathname === "/api/settings/check") {
    assertMethod(request, "GET");
    return ok({
      adminHost: env.ADMIN_HOST || null,
      workerScriptName: env.WORKER_SCRIPT_NAME || "link-shortener-manager",
      hasAdminPasswordHash: await hasConfiguredValue(env, "ADMIN_PASSWORD_HASH"),
      hasSessionSecret: Boolean(secret(env, "SESSION_SECRET")),
      hasCloudflareAccountId: await hasConfiguredValue(env, "CLOUDFLARE_ACCOUNT_ID"),
      hasCloudflareApiToken: await hasConfiguredValue(env, "CLOUDFLARE_API_TOKEN"),
      hasDynadotApiKey: await hasConfiguredValue(env, "DYNADOT_API_KEY"),
      dynadotSandbox: String(await configuredValue(env, "DYNADOT_SANDBOX")) === "true",
      visitEventRetentionDays: Number(env.VISIT_EVENT_RETENTION_DAYS || "30"),
    });
  }

  if (pathname === "/api/registrars") {
    if (request.method === "GET") {
      return ok(await registrarStatus(env));
    }
    if (request.method === "POST") {
      const body = await readJson<UpdateRegistrarSettingsBody>(request);
      const updates: string[] = [];
      if (body.cloudflareAccountId?.trim()) {
        await setSetting(env.DB, "CLOUDFLARE_ACCOUNT_ID", body.cloudflareAccountId.trim());
        updates.push("CLOUDFLARE_ACCOUNT_ID");
      }
      if (body.cloudflareApiToken?.trim()) {
        await setSetting(env.DB, "CLOUDFLARE_API_TOKEN", body.cloudflareApiToken.trim());
        updates.push("CLOUDFLARE_API_TOKEN");
      }
      if (body.dynadotApiKey?.trim()) {
        await setSetting(env.DB, "DYNADOT_API_KEY", body.dynadotApiKey.trim());
        updates.push("DYNADOT_API_KEY");
      }
      if (typeof body.dynadotSandbox === "boolean") {
        await setSetting(env.DB, "DYNADOT_SANDBOX", body.dynadotSandbox ? "true" : "false");
        updates.push("DYNADOT_SANDBOX");
      }
      return ok({ updated: updates, ...(await registrarStatus(env)) });
    }
  }

  if (pathname === "/api/nameserver-tool") {
    assertMethod(request, "POST");
    return ok(await runNameserverTool(env, await readJson<NameserverToolBody>(request)));
  }

  if (pathname === "/api/cloudflare-zones" && request.method === "GET") {
    return ok({ zones: await listZones(env) });
  }

  if (pathname === "/api/cloudflare-zones/delete") {
    assertMethod(request, "POST");
    return ok(await deleteCloudflareZones(env, await readJson<DeleteCloudflareZonesBody>(request)));
  }

  if (pathname === "/api/targets") {
    if (request.method === "GET") {
      return ok(await listTargets(env.DB));
    }
    if (request.method === "POST") {
      const body = await readJson<CreateTargetBody>(request);
      const targetHost = normalizeDomain(body.targetHost ?? "");
      const forwardTargetHost = optionalDomain(body.forwardTargetHost);
      if (!body.name?.trim()) {
        throw new HttpError(400, "bad_request", "请输入目标服务名称。");
      }
      if (!isValidDomain(targetHost)) {
        throw new HttpError(400, "bad_request", "目标服务域名不合法。");
      }
      if (forwardTargetHost && !isValidDomain(forwardTargetHost)) {
        throw new HttpError(400, "bad_request", "最终跳转域名不合法。");
      }
      const target = await createTarget(env.DB, {
        name: body.name.trim(),
        targetHost,
        forwardTargetHost,
        description: body.description?.trim() ?? "",
      });
      ctx.waitUntil(repairTargetService(env, target.id));
      return ok(target, { status: 201 });
    }
  }

  const targetForwardMatch = pathname.match(/^\/api\/targets\/([^/]+)\/forward$/);
  if (targetForwardMatch) {
    assertMethod(request, "POST");
    const target = await getTargetById(env.DB, targetForwardMatch[1]);
    if (!target) {
      throw new HttpError(404, "not_found", "目标服务不存在。");
    }
    const body = await readJson<UpdateTargetForwardBody>(request);
    const forwardTargetHost = optionalDomain(body.forwardTargetHost);
    if (forwardTargetHost && !isValidDomain(forwardTargetHost)) {
      throw new HttpError(400, "bad_request", "最终跳转域名不合法。");
    }
    await withOperationLock(env.DB, () => updateTargetForward(env.DB, target.id, forwardTargetHost));
    return ok({ id: target.id, forwardTargetHost });
  }

  const targetDeleteMatch = pathname.match(/^\/api\/targets\/([^/]+)$/);
  if (targetDeleteMatch && request.method === "DELETE") {
    const target = await getTargetById(env.DB, targetDeleteMatch[1]);
    if (!target) {
      throw new HttpError(404, "not_found", "目标服务不存在。");
    }
    const domainCount = await countDomainsForTarget(env.DB, target.id);
    const shortLinkCount = await countShortLinksForTarget(env.DB, target.id);
    const result = await withOperationLock(env.DB, () => deleteTarget(env.DB, target.id, target.targetHost));
    return ok({
      deleted: result.deleted,
      id: target.id,
      domainsMarked: result.domainsMarked || domainCount,
      shortLinksDeleted: result.shortLinksDeleted || shortLinkCount,
    });
  }

  if (pathname === "/api/short-links") {
    if (request.method === "GET") {
      return ok(await listShortLinks(env.DB));
    }
    if (request.method === "POST") {
      const body = await readJson<CreateShortLinkBody>(request);
      if (!body.targetServiceId) {
        throw new HttpError(400, "bad_request", "请选择目标服务。");
      }
      const target = await getTargetById(env.DB, body.targetServiceId);
      if (!target) {
        throw new HttpError(404, "not_found", "目标服务不存在。");
      }
      const originalUrl = normalizeHttpUrl(body.url);
      const code = await generateShortCode(env.DB, target.id);
      return ok(await createShortLink(env.DB, { targetServiceId: target.id, code, originalUrl, hideReferer: Boolean(body.hideReferer) }), { status: 201 });
    }
    if (request.method === "DELETE") {
      const body = await readJson<DeleteShortLinksBody>(request);
      if (!Array.isArray(body.ids) || body.ids.length === 0) {
        throw new HttpError(400, "bad_request", "请选择要删除的短链接。");
      }
      if (body.ids.length > 1) {
        throw new HttpError(400, "bad_request", "该接口一次只删除一个短链接，请由前端逐个提交。");
      }
      return ok({ deleted: await deleteShortLinks(env.DB, body.ids) });
    }
  }

  const targetCheckMatch = pathname.match(/^\/api\/targets\/([^/]+)\/check$/);
  if (targetCheckMatch) {
    assertMethod(request, "POST");
    const target = await getTargetById(env.DB, targetCheckMatch[1]);
    if (!target) {
      throw new HttpError(404, "not_found", "目标服务不存在。");
    }
    await markTargetHealthChecking(env.DB, target.id);
    ctx.waitUntil(refreshTargetHealth(env, target.id));
    return ok({ id: target.id, healthStatus: "checking" });
  }

  const targetRepairMatch = pathname.match(/^\/api\/targets\/([^/]+)\/repair$/);
  if (targetRepairMatch) {
    assertMethod(request, "POST");
    const target = await getTargetById(env.DB, targetRepairMatch[1]);
    if (!target) {
      throw new HttpError(404, "not_found", "目标服务不存在。");
    }
    await markTargetHealthChecking(env.DB, target.id);
    ctx.waitUntil(repairTargetService(env, target.id));
    return ok({ id: target.id, automationStatus: "cloudflare_zone", healthStatus: "checking" });
  }

  if (pathname === "/api/groups") {
    if (request.method === "GET") {
      return ok(await listGroups(env.DB));
    }
    if (request.method === "POST") {
      const body = await readJson<CreateGroupBody>(request);
      if (!body.name?.trim()) {
        throw new HttpError(400, "bad_request", "请输入 Group 名称。");
      }
      return ok(await ensureGroup(env.DB, body.name.trim()), { status: 201 });
    }
  }

  if (pathname === "/api/domains") {
    if (request.method === "GET") {
      const daysValue = query(url, "days");
      return ok(
        await listDomains(env.DB, {
          search: query(url, "search"),
          groupId: query(url, "groupId"),
          status: query(url, "status"),
          days: daysValue ? Number(daysValue) : undefined,
        }),
      );
    }
    if (request.method === "POST") {
      const body = await readJson<CreateDomainsBody>(request);
      const domains = splitDomains(body.domains);
      if (domains.length === 0) {
        throw new HttpError(400, "bad_request", "请至少输入一个入口域名。");
      }
      if (domains.length > 1) {
        throw new HttpError(400, "bad_request", "该接口一次只处理一个入口域名，请由前端逐个提交。");
      }
      const redirectMode: RedirectMode = body.redirectMode === "target_service_forward" ? "target_service_forward" : "direct";
      const directTargetHost = optionalRedirectUrl(body.directTargetHost);
      const targetForwardHost = optionalRedirectUrl(body.targetForwardHost);
      if (redirectMode === "target_service_forward" && !body.targetServiceId) {
        throw new HttpError(400, "bad_request", "请选择目标跳转服务。");
      }
      if (redirectMode === "direct" && !directTargetHost) {
        throw new HttpError(400, "bad_request", "请输入直接跳转 URL。");
      }
      if (redirectMode === "target_service_forward" && !targetForwardHost) {
        throw new HttpError(400, "bad_request", "请输入二段跳最终 URL。");
      }
      if (redirectMode === "target_service_forward" && body.targetServiceId) {
        const target = await getTargetById(env.DB, body.targetServiceId);
        if (!target) {
          throw new HttpError(400, "bad_request", "目标服务不存在。");
        }
      }
      let groupId = body.groupId ?? null;
      if (body.newGroupName?.trim()) {
        groupId = (await ensureGroup(env.DB, body.newGroupName.trim())).id;
      }
      const results: Array<{ domain: string; ok: boolean; id?: string; jobId?: string; error?: string }> = [];
      for (const domain of domains) {
        if (!isValidDomain(domain)) {
          results.push({ domain, ok: false, error: "域名格式不合法。" });
          continue;
        }
        const existing = await findDomainByName(env.DB, domain);
        if (existing) {
          if (!existing.listVisible) {
            await deleteDomains(env.DB, [existing.id]);
          } else {
            results.push({ domain, ok: false, error: "域名已存在。" });
            continue;
          }
        }
        try {
          const created = await createRedirectDomain(env.DB, {
            domain,
            redirectMode,
            targetServiceId: redirectMode === "target_service_forward" ? body.targetServiceId ?? null : null,
            directTargetHost: redirectMode === "direct" ? directTargetHost : null,
            targetForwardHost: redirectMode === "target_service_forward" ? targetForwardHost : null,
            groupId,
            hideReferer: Boolean(body.hideReferer),
          });
          ctx.waitUntil(processDomainJob(env, created.domain.id, created.jobId));
          results.push({ domain, ok: true, id: created.domain.id, jobId: created.jobId });
        } catch (error) {
          results.push({
            domain,
            ok: false,
            error: error instanceof Error ? "创建失败，请检查目标服务是否存在。" : "创建失败。",
          });
        }
      }
      return ok({ results }, { status: 201 });
    }
    if (request.method === "DELETE") {
      const body = await readJson<DeleteDomainsBody>(request);
      if (!Array.isArray(body.ids) || body.ids.length === 0) {
        throw new HttpError(400, "bad_request", "请选择要删除的域名。");
      }
      if (body.ids.length > 1) {
        throw new HttpError(400, "bad_request", "该接口一次只删除一个域名，请由前端逐个提交。");
      }
      const deleted = await deleteDomains(env.DB, body.ids);
      return ok({
        deleted,
        cleanup: {
          routes: Boolean(body.cleanupRoutes),
          dns: Boolean(body.cleanupDns),
          zone: Boolean(body.cleanupZone),
          performed: false,
          message: "V1 默认仅删除系统内配置；Cloudflare 清理选项已预留但不会自动执行。",
        },
      });
    }
  }

  const detailMatch = pathname.match(/^\/api\/domains\/([^/]+)$/);
  if (detailMatch) {
    assertMethod(request, "GET");
    const detail = await getDomainDetail(env.DB, detailMatch[1]);
    if (!detail) {
      throw new HttpError(404, "not_found", "域名不存在。");
    }
    return ok(detail);
  }

  const retryMatch = pathname.match(/^\/api\/domains\/([^/]+)\/retry$/);
  if (retryMatch) {
    assertMethod(request, "POST");
    const detail = await getDomainDetail(env.DB, retryMatch[1]);
    if (!detail) {
      throw new HttpError(404, "not_found", "域名不存在。");
    }
    const jobId = await retryDomain(env.DB, retryMatch[1]);
    ctx.waitUntil(processDomainJob(env, retryMatch[1], jobId));
    return ok({ jobId });
  }

  if (pathname === "/api/stats/summary") {
    assertMethod(request, "GET");
    return ok(await summaryStats(env.DB));
  }

  const statsMatch = pathname.match(/^\/api\/stats\/domains\/([^/]+)$/);
  if (statsMatch) {
    assertMethod(request, "GET");
    const detail = await getDomainDetail(env.DB, statsMatch[1]);
    if (!detail) {
      throw new HttpError(404, "not_found", "域名不存在。");
    }
    return ok({
      sources: detail.sources,
      trend: detail.trend,
      recentVisits: detail.recentVisits,
    });
  }

  throw new HttpError(404, "not_found", "接口不存在。");
}

export function apiError(error: unknown): Response {
  if (error instanceof HttpError) {
    return fail(error.status, error.code, error.message);
  }
  const message = error instanceof Error ? error.message : "服务器内部错误。";
  console.error(JSON.stringify({ event: "api_error", message }));
  const sanitized = message.includes("TOKEN") || message.includes("KEY") ? "服务器配置错误。" : message;
  return fail(500, "server_error", sanitized);
}
