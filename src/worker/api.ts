import {
  assertLoginAllowed,
  clearLoginFailures,
  clearSessionCookie,
  createSessionCookie,
  hashPasswordForDocs,
  recordLoginFailure,
  requireSession,
  verifyPassword,
} from "./auth";
import { processNextJob } from "./automation";
import { listZones } from "./cloudflare";
import {
  createShortLink,
  createRedirectDomain,
  createTarget,
  deleteShortLinks,
  enqueueJob,
  ensureGroup,
  findDomainByName,
  findTargetByHost,
  getDomainDetail,
  getJobById,
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
} from "./db";
import { HttpError, fail, ok, readJson } from "./http";
import { configuredValue, hasConfiguredValue, secret } from "./env-utils";
import { ProviderError } from "./provider-error";
import { type RedirectMode, isValidDomain, normalizeDomain } from "./shared";
import { refreshTargetHealth } from "./target-health";

interface LoginBody {
  password?: string;
}

interface ChangePasswordBody {
  currentPassword?: string;
  newPassword?: string;
}

interface UpdateRegistrarSettingsBody {
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
        configured: Boolean(secret(env, "CLOUDFLARE_ACCOUNT_ID") && secret(env, "CLOUDFLARE_API_TOKEN")),
      },
      {
        id: "dynadot",
        name: "Dynadot",
        role: "注册商 Nameserver 写入",
        automation: "已支持：domain_info 检查归属，set_ns 写入 Cloudflare Nameserver。",
        configured: Boolean(secret(env, "DYNADOT_API_KEY")),
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

function idempotencyKey(request: Request, prefix: string, fallback: string): string {
  const supplied = request.headers.get("idempotency-key")?.trim();
  if (supplied && !/^[A-Za-z0-9._:-]{1,128}$/.test(supplied)) {
    throw new HttpError(400, "bad_request", "Idempotency-Key 格式不合法。");
  }
  return `${prefix}:${supplied || fallback}`;
}

async function enqueueNameserverJob(env: Env, request: Request, input: NameserverToolBody) {
  const registrarId = input.registrarId || "manual";
  const domains = splitDomains(input.domains);
  if (domains.length === 0) {
    throw new HttpError(400, "bad_request", "请至少输入一个域名。");
  }
  if (domains.length > 1) {
    throw new HttpError(400, "bad_request", "该接口一次只处理一个域名，请由前端逐个提交。");
  }
  const domain = normalizeDomain(domains[0]);
  if (!isValidDomain(domain)) {
    throw new HttpError(400, "bad_request", "域名格式不合法。");
  }
  const job = await enqueueJob(env.DB, {
    type: "nameserver_connect",
    subjectType: "domain",
    subjectId: domain,
    payload: { domain, registrarId },
    idempotencyKey: idempotencyKey(request, "nameserver_connect", `${domain}:${registrarId}:${Math.floor(Date.now() / 30_000)}`),
  });
  return {
    results: [{
      domain,
      ok: true,
      status: job.status,
      jobId: job.id,
      message: "已加入串行处理队列。",
      nameservers: [],
    }],
  };
}

async function enqueueCloudflareZoneDelete(env: Env, request: Request, input: DeleteCloudflareZonesBody) {
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
  const domain = normalizeDomain(domains[0]);
  if (!isValidDomain(domain)) {
    throw new HttpError(400, "bad_request", "域名格式不合法。");
  }
  const job = await enqueueJob(env.DB, {
    type: "zone_delete",
    subjectType: "domain",
    subjectId: domain,
    payload: { domain },
    idempotencyKey: idempotencyKey(request, "zone_delete", `${domain}:${Math.floor(Date.now() / 30_000)}`),
  });
  return {
    results: [{
      domain,
      ok: true,
      status: job.status,
      jobId: job.id,
      message: "已加入串行删除队列。",
    }],
  };
}

export async function handleApi(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const pathname = url.pathname;

  if (pathname === "/api/auth/login") {
    assertMethod(request, "POST");
    const body = await readJson<LoginBody>(request);
    if (typeof body.password !== "string" || !body.password) {
      throw new HttpError(400, "bad_request", "请输入后台密码。");
    }
    if (body.password.length > 256) {
      throw new HttpError(400, "bad_request", "后台密码不能超过 256 位。");
    }
    await assertLoginAllowed(request, env);
    const valid = await verifyPassword(env, body.password);
    if (!valid) {
      await recordLoginFailure(request, env);
      throw new HttpError(401, "unauthorized", "密码不正确。");
    }
    await clearLoginFailures(request, env);
    return ok(
      { authenticated: true },
      {
        headers: {
          "Set-Cookie": await createSessionCookie(env),
        },
      },
    );
  }

  if (pathname === "/api/me") {
    try {
      await requireSession(request, env);
      return ok({ authenticated: true });
    } catch (error) {
      if (error instanceof HttpError && error.status === 401) {
        return ok({ authenticated: false });
      }
      throw error;
    }
  }

  await requireSession(request, env);
  const origin = request.headers.get("origin");
  if (request.method !== "GET" && request.method !== "HEAD" && origin && origin !== url.origin) {
    throw new HttpError(403, "forbidden", "请求来源无效。");
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

  if (pathname === "/api/auth/password") {
    assertMethod(request, "POST");
    const body = await readJson<ChangePasswordBody>(request);
    if (!body.currentPassword || !body.newPassword) {
      throw new HttpError(400, "bad_request", "请输入当前密码和新密码。");
    }
    if (body.newPassword.length < 10) {
      throw new HttpError(400, "bad_request", "新密码至少需要 10 位。");
    }
    if (body.newPassword.length > 256) {
      throw new HttpError(400, "bad_request", "新密码不能超过 256 位。");
    }
    const valid = await verifyPassword(env, body.currentPassword);
    if (!valid) {
      throw new HttpError(401, "unauthorized", "当前密码不正确。");
    }
    const pepper = secret(env, "PASSWORD_PEPPER");
    if (!pepper) {
      throw new HttpError(500, "server_error", "尚未配置 PASSWORD_PEPPER。");
    }
    await setSetting(env.DB, "ADMIN_PASSWORD_HASH", await hashPasswordForDocs(body.newPassword, pepper));
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
      hasPasswordPepper: Boolean(secret(env, "PASSWORD_PEPPER")),
      hasCloudflareAccountId: Boolean(secret(env, "CLOUDFLARE_ACCOUNT_ID")),
      hasCloudflareApiToken: Boolean(secret(env, "CLOUDFLARE_API_TOKEN")),
      hasDynadotApiKey: Boolean(secret(env, "DYNADOT_API_KEY")),
      dynadotSandbox: String(await configuredValue(env, "DYNADOT_SANDBOX")) === "true",
      visitEventRetentionDays: Number(env.VISIT_EVENT_RETENTION_DAYS || "30"),
    });
  }

  if (pathname === "/api/registrars") {
    if (request.method === "GET") {
      return ok(await registrarStatus(env));
    }
    if (request.method === "POST") {
      const body = await readJson<UpdateRegistrarSettingsBody & Record<string, unknown>>(request);
      if (["cloudflareAccountId", "cloudflareApiToken", "dynadotApiKey"].some((key) => Object.hasOwn(body, key))) {
        throw new HttpError(400, "bad_request", "API 凭据只能通过 Wrangler Secret 配置。");
      }
      const updates: string[] = [];
      if (typeof body.dynadotSandbox === "boolean") {
        await setSetting(env.DB, "DYNADOT_SANDBOX", body.dynadotSandbox ? "true" : "false");
        updates.push("DYNADOT_SANDBOX");
      }
      return ok({ updated: updates, ...(await registrarStatus(env)) });
    }
  }

  if (pathname === "/api/nameserver-tool") {
    assertMethod(request, "POST");
    const result = await enqueueNameserverJob(env, request, await readJson<NameserverToolBody>(request));
    ctx.waitUntil(processNextJob(env));
    return ok(result, { status: 202 });
  }

  if (pathname === "/api/cloudflare-zones" && request.method === "GET") {
    return ok({ zones: await listZones(env) });
  }

  if (pathname === "/api/cloudflare-zones/delete") {
    assertMethod(request, "POST");
    const result = await enqueueCloudflareZoneDelete(env, request, await readJson<DeleteCloudflareZonesBody>(request));
    ctx.waitUntil(processNextJob(env));
    return ok(result, { status: 202 });
  }

  const jobMatch = pathname.match(/^\/api\/jobs\/([^/]+)$/);
  if (jobMatch) {
    assertMethod(request, "GET");
    const job = await getJobById(env.DB, jobMatch[1]);
    if (!job) {
      throw new HttpError(404, "not_found", "任务不存在。");
    }
    if (job.status === "queued" || job.status === "retry_wait") {
      ctx.waitUntil(processNextJob(env));
    }
    const { leaseToken: _leaseToken, leaseExpiresAt: _leaseExpiresAt, ...publicJob } = job;
    return ok(publicJob);
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
      if (await findDomainByName(env.DB, targetHost)) {
        throw new HttpError(409, "conflict", "域名不能同时作为入口域名和目标服务域名。");
      }
      if (await findTargetByHost(env.DB, targetHost)) {
        throw new HttpError(409, "conflict", "目标服务域名已存在。");
      }
      const created = await createTarget(env.DB, {
        name: body.name.trim(),
        targetHost,
        forwardTargetHost,
        description: body.description?.trim() ?? "",
      });
      ctx.waitUntil(processNextJob(env));
      return ok({ ...created.target, jobId: created.jobId, jobStatus: "queued" }, { status: 202 });
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
    await updateTargetForward(env.DB, target.id, forwardTargetHost);
    return ok({ id: target.id, forwardTargetHost });
  }

  const targetDeleteMatch = pathname.match(/^\/api\/targets\/([^/]+)$/);
  if (targetDeleteMatch && request.method === "DELETE") {
    const target = await getTargetById(env.DB, targetDeleteMatch[1]);
    if (!target) {
      throw new HttpError(404, "not_found", "目标服务不存在。");
    }
    const job = await enqueueJob(env.DB, {
      type: "target_delete",
      subjectType: "target_service",
      subjectId: target.id,
      payload: { targetHost: target.targetHost },
      idempotencyKey: idempotencyKey(request, "target_delete", target.id),
    });
    ctx.waitUntil(processNextJob(env));
    return ok({ id: target.id, jobId: job.id, status: job.status }, { status: 202 });
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
    const job = await enqueueJob(env.DB, {
      type: "target_repair",
      subjectType: "target_service",
      subjectId: target.id,
      payload: {},
      idempotencyKey: idempotencyKey(
        request,
        "target_repair",
        `${target.id}:${target.lastCheckedAt ?? target.updatedAt}`,
      ),
    });
    ctx.waitUntil(processNextJob(env));
    return ok({
      id: target.id,
      jobId: job.id,
      status: job.status,
      automationStatus: "cloudflare_zone",
      healthStatus: "checking",
    }, { status: 202 });
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
        if (await findTargetByHost(env.DB, domain)) {
          throw new HttpError(409, "conflict", "域名不能同时作为入口域名和目标服务域名。");
        }
        const existing = await findDomainByName(env.DB, domain);
        if (existing) {
          if (!existing.listVisible) {
            const detail = await getDomainDetail(env.DB, existing.id);
            const pendingJob = detail?.jobs.find((job) => (
              job.status === "queued" || job.status === "running" || job.status === "retry_wait"
            ));
            const job = pendingJob ?? await retryDomain(
              env.DB,
              existing.id,
              `domain_retry:${existing.id}:${existing.lastCheckedAt ?? existing.createdAt}`,
            );
            ctx.waitUntil(processNextJob(env));
            results.push({ domain, ok: true, id: existing.id, jobId: job.id });
            continue;
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
          ctx.waitUntil(processNextJob(env));
          results.push({ domain, ok: true, id: created.domain.id, jobId: created.jobId });
        } catch (error) {
          results.push({
            domain,
            ok: false,
            error: error instanceof Error ? "创建失败，请检查目标服务是否存在。" : "创建失败。",
          });
        }
      }
      return ok({ results }, { status: 202 });
    }
    if (request.method === "DELETE") {
      const body = await readJson<DeleteDomainsBody>(request);
      if (!Array.isArray(body.ids) || body.ids.length === 0) {
        throw new HttpError(400, "bad_request", "请选择要删除的域名。");
      }
      if (body.ids.length > 1) {
        throw new HttpError(400, "bad_request", "该接口一次只删除一个域名，请由前端逐个提交。");
      }
      const id = body.ids[0];
      const job = await enqueueJob(env.DB, {
        type: "domain_delete",
        subjectType: "redirect_domain",
        subjectId: id,
        redirectDomainId: id,
        payload: {
          cleanupRoutes: Boolean(body.cleanupRoutes),
          cleanupDns: Boolean(body.cleanupDns),
          cleanupZone: Boolean(body.cleanupZone),
        },
        idempotencyKey: idempotencyKey(request, "domain_delete", id),
      });
      ctx.waitUntil(processNextJob(env));
      return ok({
        deleted: 0,
        jobId: job.id,
        status: job.status,
        cleanup: {
          routes: Boolean(body.cleanupRoutes),
          dns: Boolean(body.cleanupDns),
          zone: Boolean(body.cleanupZone),
          performed: false,
          message: "V1 默认仅删除系统内配置；Cloudflare 清理选项已预留但不会自动执行。",
        },
      }, { status: 202 });
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
    const job = await retryDomain(
      env.DB,
      retryMatch[1],
      `domain_retry:${detail.id}:${detail.lastCheckedAt ?? detail.createdAt}`,
    );
    ctx.waitUntil(processNextJob(env));
    return ok({ jobId: job.id, status: job.status }, { status: 202 });
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
  const requestId = crypto.randomUUID();
  if (error instanceof ProviderError) {
    console.error(JSON.stringify({
      event: "provider_error",
      requestId,
      provider: error.provider,
      status: error.status,
      code: error.code,
    }));
    return fail(error.retryable ? 503 : 502, "server_error", error.message);
  }
  console.error(JSON.stringify({ event: "api_error", requestId }));
  return fail(500, "server_error", "服务器内部错误。");
}
