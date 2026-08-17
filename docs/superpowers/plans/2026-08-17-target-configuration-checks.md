# 服务域名逐项配置检查 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复同 Zone Worker 健康检查误判，并在服务域名配置说明中提供四项独立的检查、修复与人工指引。

**Architecture:** 保持 `repairTargetService()` 为列表页的一键修复入口。新增 `target-configuration` 模块为 Zone、Nameserver、DNS、Worker Route 提供单项检查和修复；API 直接返回当前结果，弹窗只更新被操作的行，不建立历史表。

**Tech Stack:** Cloudflare Workers、D1、TypeScript、React 19、Vite、Vitest、Wrangler。

## Global Constraints

- 不新增依赖或数据库迁移。
- 列表页“重新配置”继续调用全量 `repairTargetService()`；弹窗操作不得调用它。
- 状态只允许 `passed`、`failed`、`unknown`；未知必须是黄色问号。
- 子域名使用父 Zone 时，Nameserver 项显示继承关系，不要求为子域名设置 NS。
- Cloudflare 错误不向客户端泄露请求细节或密钥。
- 启用 `global_fetch_strictly_public`，使健康检查按公网 Worker Route 路由。

---

## 文件结构

- Create: `src/worker/target-configuration.ts` — 单项类型、检查、修复及手动指引。
- Create: `tests/target-configuration.test.ts` — 配置项判定与按项修复测试。
- Modify: `src/worker/cloudflare.ts` — 读取精确 Worker Route 的 helper。
- Modify: `src/worker/api.ts` — 两个单项 API 路由。
- Modify: `src/app/src/main.tsx` — 配置说明的逐项行与按钮。
- Modify: `src/app/src/styles.css` — 逐项行和小屏样式。
- Modify: `wrangler.jsonc` — 公网 fetch 兼容性标志。
- Create: `tests/wrangler-config.test.ts` — 标志回归测试。

### Task 1: 建立 Cloudflare 读取能力和配置项服务

**Files:**

- Create: `src/worker/target-configuration.ts`
- Modify: `src/worker/cloudflare.ts:258-290`
- Test: `tests/target-configuration.test.ts`

**Interfaces:**

- Consumes: `findBestZoneForHost()`, `ensureZone()`, `getZone()`, `findAddressRecordsForHost()`, `ensureWorkerDnsRecordForHost()`, `ensureWorkerRouteForHost()` from `src/worker/cloudflare.ts`; `getTargetById()` and `updateTargetAutomation()` from `src/worker/db.ts`.
- Produces: `TargetConfigurationItem`, `TargetConfigurationResult`, `checkTargetConfigurationItem(env, targetId, item)`, and `configureTargetConfigurationItem(env, targetId, item)`.

- [ ] **Step 1: Write the failing configuration-service tests**

```ts
it("confirms an inherited subdomain Nameserver without changing registrar NS", async () => {
  vi.mocked(getTargetById).mockResolvedValue(target({ targetHost: "s.g60.net" }));
  vi.mocked(findBestZoneForHost).mockResolvedValue(zone({ name: "g60.net", status: "active" }));

  await expect(checkTargetConfigurationItem(env, "target-1", "nameserver")).resolves.toMatchObject({
    status: "passed",
    summary: "继承 g60.net 的已激活 Nameserver，无需为子域名单独设置。",
  });
  expect(setNameservers).not.toHaveBeenCalled();
});

it("reports conflicting DNS records as failed", async () => {
  vi.mocked(getTargetById).mockResolvedValue(target());
  vi.mocked(findBestZoneForHost).mockResolvedValue(zone());
  vi.mocked(findAddressRecordsForHost).mockResolvedValue([
    { id: "old", type: "CNAME", name: "s.g60.net", content: "old.example.com", proxied: true },
  ]);

  await expect(checkTargetConfigurationItem(env, "target-1", "dns")).resolves.toMatchObject({
    status: "failed",
    summary: "DNS 记录未由当前 Worker 接管。",
  });
});

it("confirms only an exact Worker Route bound to the configured script", async () => {
  vi.mocked(getTargetById).mockResolvedValue(target());
  vi.mocked(findBestZoneForHost).mockResolvedValue(zone());
  vi.mocked(findWorkerRouteForHost).mockResolvedValue({ id: "route-1", pattern: "s.g60.net/*", script: "multi-domain-redirect-manager" });

  await expect(checkTargetConfigurationItem(env, "target-1", "route")).resolves.toMatchObject({ status: "passed" });
});

it("repairs only the requested DNS item", async () => {
  vi.mocked(getTargetById).mockResolvedValue(target());
  vi.mocked(findBestZoneForHost).mockResolvedValue(zone());
  vi.mocked(findAddressRecordsForHost).mockResolvedValue([]);

  await configureTargetConfigurationItem(env, "target-1", "dns");

  expect(ensureWorkerDnsRecordForHost).toHaveBeenCalledWith(env, "zone-1", "s.g60.net");
  expect(ensureWorkerRouteForHost).not.toHaveBeenCalled();
  expect(setNameservers).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:node -- tests/target-configuration.test.ts`

Expected: FAIL because the configuration module and `findWorkerRouteForHost()` do not exist.

- [ ] **Step 3: Export a minimal exact-route reader**

In `src/worker/cloudflare.ts`, export `WorkerRoute` and add this read-only helper without changing the existing route-upsert behavior:

```ts
export async function findWorkerRouteForHost(env: Env, zoneId: string, host: string): Promise<WorkerRoute | null> {
  const routes = await cfRequest<WorkerRoute[]>(env, `/zones/${zoneId}/workers/routes`);
  return routes.find((route) => route.pattern === `${host}/*`) ?? null;
}
```

- [ ] **Step 4: Implement the smallest per-item configuration module**

Create `src/worker/target-configuration.ts` with the following public API:

```ts
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

export async function checkTargetConfigurationItem(env: Env, targetId: string, item: TargetConfigurationItem): Promise<TargetConfigurationResult>;
export async function configureTargetConfigurationItem(env: Env, targetId: string, item: TargetConfigurationItem): Promise<TargetConfigurationResult>;
```

Zone: find the best Zone and pass only when it is active; configure creates a Zone only when no matching Zone exists. Nameserver: for an active parent Zone, pass a subdomain as inherited; for an apex, reuse `isDomainInDynadot()` and `setNameservers()`, otherwise return unknown with the Cloudflare nameservers and registrar steps. DNS: pass only for exactly one proxied A record at `192.0.2.1`; configure uses `ensureWorkerDnsRecordForHost()`. Route: pass only for an exact `${host}/*` route bound to `env.WORKER_SCRIPT_NAME || "link-shortener-manager"`; configure uses `ensureWorkerRouteForHost()`. Every failed or unknown result returns Chinese manual steps using known Zone, record name, nameservers and Worker script.

- [ ] **Step 5: Run the configuration-service test to verify it passes**

Run: `npm run test:node -- tests/target-configuration.test.ts`

Expected: PASS with all four tests green.

- [ ] **Step 6: Commit the configuration service**

```bash
git add src/worker/cloudflare.ts src/worker/target-configuration.ts tests/target-configuration.test.ts
git commit -m "feat: add per-item target configuration checks"
```

### Task 2: Expose safe per-item configuration APIs

**Files:**

- Modify: `src/worker/api.ts:540-585`
- Create: `tests/worker/target-configuration-api.test.ts`

**Interfaces:**

- Consumes: `TargetConfigurationItem`, `checkTargetConfigurationItem()`, and `configureTargetConfigurationItem()` from `src/worker/target-configuration.ts`.
- Produces: `POST /api/targets/:id/configuration/:item/check` and `POST /api/targets/:id/configuration/:item/configure`, returning `TargetConfigurationResult`.

- [ ] **Step 1: Write the failing API tests**

```ts
it("checks only the requested target configuration item", async () => {
  vi.mocked(checkTargetConfigurationItem).mockResolvedValue(result("dns", "passed"));

  const response = await env.fetch("https://example.com/api/targets/target-1/configuration/dns/check", {
    method: "POST",
    headers: authHeaders(),
    body: "{}",
  });

  await expect(response.json()).resolves.toMatchObject({ ok: true, data: { item: "dns", status: "passed" } });
  expect(configureTargetConfigurationItem).not.toHaveBeenCalled();
});

it("rejects a configuration item outside the four supported names", async () => {
  const response = await env.fetch("https://example.com/api/targets/target-1/configuration/unknown/check", {
    method: "POST",
    headers: authHeaders(),
    body: "{}",
  });

  expect(response.status).toBe(404);
});
```

- [ ] **Step 2: Run the worker API test to verify it fails**

Run: `npm run test:worker -- tests/worker/target-configuration-api.test.ts`

Expected: FAIL because the configuration routes are not registered.

- [ ] **Step 3: Register the exact routes before generic target handling**

In `src/worker/api.ts`, add this route block before the generic `DELETE /api/targets/:id` match:

```ts
const match = pathname.match(/^\/api\/targets\/([^/]+)\/configuration\/(zone|nameserver|dns|route)\/(check|configure)$/);
if (match) {
  assertMethod(request, "POST");
  const [, targetId, rawItem, action] = match;
  if (!await getTargetById(env.DB, targetId)) throw new HttpError(404, "not_found", "目标服务不存在。");
  const item = rawItem as TargetConfigurationItem;
  return ok(action === "check"
    ? await checkTargetConfigurationItem(env, targetId, item)
    : await configureTargetConfigurationItem(env, targetId, item));
}
```

Do not enqueue a job and do not invoke `repairTargetService()` in these routes. Existing `ProviderError` handling remains responsible for safe Cloudflare error responses.

- [ ] **Step 4: Run the worker API test to verify it passes**

Run: `npm run test:worker -- tests/worker/target-configuration-api.test.ts`

Expected: PASS with only the selected operation invoked.

- [ ] **Step 5: Commit the API routes**

```bash
git add src/worker/api.ts tests/worker/target-configuration-api.test.ts
git commit -m "feat: expose target configuration item actions"
```

### Task 3: Render per-item configuration rows in the modal

**Files:**

- Modify: `src/app/src/main.tsx:1842-1931`
- Modify: `src/app/src/styles.css:842-925`
- Create: `tests/target-configuration-ui.test.ts`

**Interfaces:**

- Consumes: the two Task 2 API endpoints.
- Produces: one stateful row for each of `zone`, `nameserver`, `dns`, `route`, with item-local pending state and manual instructions.

- [ ] **Step 1: Write the failing UI-state tests**

```ts
it("keeps an unverified Worker Route unknown even when DNS is configured", () => {
  expect(initialConfigurationResult(target({ dnsStatus: "configured", cloudflareZoneStatus: "active" }), "route")).toMatchObject({ status: "unknown" });
});

it("shows an active inherited Nameserver as passed", () => {
  expect(initialConfigurationResult(target({ nameserverStatus: "active", cloudflareZoneName: "g60.net" }), "nameserver")).toMatchObject({ status: "passed" });
});
```

- [ ] **Step 2: Run the UI-state test to verify it fails**

Run: `npm run test:node -- tests/target-configuration-ui.test.ts`

Expected: FAIL because `initialConfigurationResult()` is not exported.

- [ ] **Step 3: Replace the section blocks with a mapped checklist**

In `src/app/src/main.tsx`, add the frontend `TargetConfigurationResult` type and export `initialConfigurationResult(target, item)`. Update `ManualConfigModal` to own `results` and `pendingItems`, and pass `onCreated` to it as `onUpdated`.

Render fixed-order `config-check-row` entries. Each row maps `passed` to `CheckCircle2`, `failed` to `X`, and `unknown` to a yellow `CircleDot`; renders its own summary and ordered manual steps; has both buttons below:

```tsx
<div className={`config-check-row ${result.status}`}>
  <div>{icon}</div><div><strong>{label}</strong><small>{result.summary}</small></div>
  <div className="config-check-actions">
    <button onClick={() => void runItem(item, "configure")}>再次配置</button>
    <button onClick={() => void runItem(item, "check")}>信息检查</button>
  </div>
  <ol>{result.manualSteps.map((step) => <li key={step}>{step}</li>)}</ol>
</div>
```

`runItem()` calls only its matching endpoint, updates only that item, disables only its row, and calls `onUpdated()` after a successful configure action. Keep the existing overall HTTP health badges in the modal header and leave list-page “重新配置” and “重新检测” unchanged.

- [ ] **Step 4: Add responsive row styles**

Replace no-longer-used `config-grid`, `config-card`, `config-section`, `record-table`, and `config-steps` rules. Add `.config-check-list`, `.config-check-row`, `.config-check-actions`; use the project colors `#067647`, `#b42318`, `#b54708`. At `max-width: 640px`, collapse each row to one column and left-align its actions.

- [ ] **Step 5: Run UI-state tests and build**

Run: `npm run test:node -- tests/target-configuration-ui.test.ts && npm run build`

Expected: PASS and a successful TypeScript/Vite build.

- [ ] **Step 6: Commit the modal UI**

```bash
git add src/app/src/main.tsx src/app/src/styles.css tests/target-configuration-ui.test.ts
git commit -m "feat: show per-item target configuration guidance"
```

### Task 4: Enable public health checks and run regression verification

**Files:**

- Modify: `wrangler.jsonc:5`
- Create: `tests/wrangler-config.test.ts`
- Test: `tests/target-health.test.ts`

**Interfaces:**

- Consumes: `wrangler.jsonc` compatibility flags and `checkTargetHealth()`.
- Produces: health `fetch()` calls that enter Cloudflare’s public routing layer.

- [ ] **Step 1: Write the failing Wrangler configuration test**

```ts
it("enables strictly public fetch routing for target health checks", async () => {
  const config = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  expect(config).toContain('"global_fetch_strictly_public"');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:node -- tests/wrangler-config.test.ts`

Expected: FAIL because the flag is absent.

- [ ] **Step 3: Add the compatibility flag**

```jsonc
"compatibility_flags": ["nodejs_compat_v2", "global_fetch_strictly_public"],
```

- [ ] **Step 4: Run focused checks**

Run: `npm run test:node -- tests/wrangler-config.test.ts tests/target-health.test.ts && npm run wrangler:check`

Expected: PASS and Wrangler dry-run exits 0.

- [ ] **Step 5: Run full verification**

Run: `npm run test:all && npm run build && npm run wrangler:check`

Expected: all Node and Worker Vitest tests pass, build exits 0, dry-run exits 0.

- [ ] **Step 6: Confirm the reported domain publicly**

Run: `curl.exe -sS -o NUL -w "%{http_code}" -X HEAD --max-time 15 https://s.g60.net/` and `curl.exe -sS -o NUL -w "%{http_code}" --max-time 15 https://s.g60.net/`

Expected: `204` for HEAD and `200` for GET.

- [ ] **Step 7: Commit configuration and tests**

```bash
git add wrangler.jsonc tests/wrangler-config.test.ts
git commit -m "fix: route target health checks through Cloudflare"
```

## Self-review

- Spec coverage: Task 1 implements the four independent checks, repairs and manual guidance; Task 2 constrains every API operation to one item; Task 3 renders the requested status icons, guidance and two buttons; Task 4 fixes the health-check route and verifies `s.g60.net`.
- Scope: no history table, database migration, dependency, or unrelated UI refactor is included.
- Type consistency: API and UI use only `zone`, `nameserver`, `dns`, and `route`; every API response uses `TargetConfigurationResult`.
- Placeholder scan: no incomplete placeholders or unspecified test steps remain.
