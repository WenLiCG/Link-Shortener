# Turnstile Verified Traffic and Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add fail-open Turnstile verification through a small relay-domain pool, correct all traffic metrics to one IP per subject per Shanghai day, and harden the queue, Cloudflare automation, health checks, frontend polling, authentication, storage, and rollout process.

**Architecture:** Entry domains render a minimal parent page that runs an Invisible Turnstile widget inside a cross-origin relay iframe. A successful server-side Siteverify produces a short-lived HMAC proof that upgrades the daily visitor from server-filtered to Cloudflare-verified; every failure path continues the original redirect without incrementing verified UV. D1 stores one daily visitor fact per subject/IP plus long-lived aggregates, while a leased operation queue serializes all Cloudflare and Dynadot mutations.

**Tech Stack:** React 19, Vite 7, TypeScript 5.9, Cloudflare Workers, D1, Wrangler 4, Cloudflare Turnstile, Vitest 4.1+, `@cloudflare/vitest-pool-workers`, Web Crypto.

## Global Constraints

- The approved design is `docs/superpowers/specs/2026-07-15-turnstile-verified-traffic-hardening-design.md`.
- A visitor is unique by `subject + Asia/Shanghai day + HMAC(normalized IP)`; User-Agent does not create another UV.
- Preserve three distinct metrics: raw requests, server-filtered UV, and Cloudflare-verified UV.
- Verification is fail-open with a 3,500 ms browser deadline and 2,500 ms Siteverify deadline.
- Verification failure, timeout, D1 failure, or relay failure must never block the original redirect.
- Direct redirects, target-service two-step redirects, and short links all support verification and default to hidden Referer.
- Entry domains continue returning 404 for `/api/*`; public verification uses only `/.well-known/link-verify/*`.
- Batch operations are frontend-serial and server-serial; no `Promise.all()` may issue Cloudflare or Dynadot mutations.
- Never commit or log real Cloudflare, Dynadot, Turnstile, session, visitor-hash, signing, or encryption secrets.
- New schema changes are additive; historical rows must never be labeled Turnstile-verified.
- The hidden-iframe browser gate must pass before any production database migration or verification rollout.
- Use TDD for every task and make the listed commit before starting the next task.

---

## File Responsibility Map

### New Worker modules

- `src/worker/time.ts`: Shanghai day and expiry calculations.
- `src/worker/traffic-classifier.ts`: IP normalization, HMAC visitor key, page-navigation and bot classification.
- `src/worker/traffic.ts`: D1 writes and reads for daily visitors and aggregates.
- `src/worker/verification-crypto.ts`: versioned HMAC state/proof/cookie tokens.
- `src/worker/verification-page.ts`: escaped parent and relay HTML responses.
- `src/worker/verification.ts`: relay selection, Siteverify, completion endpoint, cookie, and fail-open decisions.
- `src/worker/verification-relays.ts`: relay CRUD, health, and stable selection.
- `src/worker/operation-queue.ts`: enqueue, atomic lease, retry, completion, and status APIs.
- `src/worker/automation-errors.ts`: retryable/permanent error mapping and safe metadata.
- `src/worker/traffic-maintenance.ts`: chunked backfill, aggregate rebuild, and retention cleanup.
- `src/worker/crypto-settings.ts`: AES-GCM settings encryption.

### New frontend modules

- `src/app/src/api.ts`: API client, timeout errors, and CSRF header handling.
- `src/app/src/types.ts`: frontend API contracts shared by extracted views.
- `src/app/src/hooks/useOperationPolling.ts`: one timer per stable operation-id set.
- `src/app/src/components/VerificationSettings.tsx`: relay and global verification controls.
- `src/app/src/components/TrafficAnalytics.tsx`: metric selector, map, breakdowns, and daily visitor table.
- `src/app/src/components/BatchResults.tsx`: persistent serial-operation results and retry controls.

### Migrations

- `migrations/0017_verified_traffic.sql`: relay pool, verification policy, activation marker, visitor facts, and aggregates.
- `migrations/0018_operation_queue.sql`: leased global operation queue and mutex.
- `migrations/0019_auth_security.sql`: login throttling and session-version state.

### Tests

- Existing Node unit tests remain in `tests/*.test.ts`.
- D1/Worker integration tests go in `tests/worker/*.test.ts`.
- `tests/worker/apply-migrations.ts` applies every migration to isolated test D1 storage.

---

### Task 1: Add the Cloudflare Worker and D1 Test Harness

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `vitest.worker.config.ts`
- Create: `tests/worker/tsconfig.json`
- Create: `tests/worker/apply-migrations.ts`
- Create: `tests/worker/migrations-smoke.test.ts`

**Interfaces:**
- Produces: a `test:worker` command with a migrated `env.DB` binding in every Worker test file.
- Produces: `ProvidedEnv.TEST_MIGRATIONS: D1Migration[]` for `applyD1Migrations()`.

- [ ] **Step 1: Upgrade Vitest and install the official Worker pool**

Run:

```powershell
npm.cmd install --save-dev vitest@^4.1.0 @cloudflare/vitest-pool-workers
```

Add scripts to `package.json`:

```json
{
  "scripts": {
    "test": "vitest run --config vitest.config.ts",
    "test:worker": "vitest run --config vitest.worker.config.ts",
    "test:all": "npm run test && npm run test:worker"
  }
}
```

- [ ] **Step 2: Create the Worker Vitest configuration**

Create `vitest.worker.config.ts`:

```ts
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { readD1Migrations } from "@cloudflare/vitest-pool-workers/config";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(path.join(root, "migrations")),
          ADMIN_HOST: "admin.example.com",
          SESSION_SECRET: "test-session-secret",
          VISITOR_HASH_SECRET: "test-visitor-secret",
          VERIFICATION_SIGNING_SECRET: "test-verification-secret",
          TURNSTILE_SITE_KEY: "1x00000000000000000000BB",
          TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
          SETTINGS_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
        },
      },
    })),
  ],
  test: {
    include: ["tests/worker/**/*.test.ts"],
    setupFiles: ["./tests/worker/apply-migrations.ts"],
  },
});
```

- [ ] **Step 3: Add Worker test types and migration setup**

Create `tests/worker/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.worker.json",
  "compilerOptions": {
    "types": ["@cloudflare/vitest-pool-workers/types"]
  },
  "include": ["./**/*.ts", "../../src/worker/**/*.ts", "../../src/worker/worker-configuration.d.ts"]
}
```

Create `tests/worker/apply-migrations.ts`:

```ts
import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll } from "vitest";

declare module "cloudflare:workers" {
  interface ProvidedEnv extends Env {
    TEST_MIGRATIONS: D1Migration[];
  }
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
```

- [ ] **Step 4: Write and run the migration smoke test**

Create `tests/worker/migrations-smoke.test.ts`:

```ts
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("D1 migrations", () => {
  it("creates the current schema", async () => {
    const row = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'redirect_domains'",
    ).first<{ name: string }>();
    expect(row?.name).toBe("redirect_domains");
  });
});
```

Run:

```powershell
npm.cmd run test:all
```

Expected: all existing Node tests pass and `migrations-smoke.test.ts` passes in workerd.

- [ ] **Step 5: Commit the test harness**

```powershell
git add package.json package-lock.json vitest.worker.config.ts tests/worker
git commit -m "test: add Worker D1 integration harness"
```

---

### Task 2: Prove the Hidden Relay Iframe Before Schema Work

**Files:**
- Create: `src/worker/verification-crypto.ts`
- Create: `src/worker/verification-page.ts`
- Create: `src/worker/verification.ts`
- Modify: `src/worker/index.ts`
- Modify: `src/worker/secret-env.d.ts`
- Modify: `.dev.vars.example`
- Create: `tests/verification-crypto.test.ts`
- Create: `tests/verification-page.test.ts`
- Create after browser run: `docs/verification/iframe-poc-results.md`

**Interfaces:**
- Produces: `signVerificationToken<T>(payload, secret): Promise<string>`.
- Produces: `verifyVerificationToken<T>(token, secret): Promise<T | null>`.
- Produces: `renderVerificationParent(input): Response` and `renderRelayFrame(input): Response`.
- Produces: preview-only `handleVerificationProbe(request, env): Promise<Response | null>`.

- [ ] **Step 1: Write failing crypto and HTML tests**

Create `tests/verification-crypto.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { signVerificationToken, verifyVerificationToken } from "../src/worker/verification-crypto";

describe("verification tokens", () => {
  it("rejects tampering", async () => {
    const token = await signVerificationToken({ sub: "domain-1", exp: 2_000_000_000 }, "secret-a");
    expect(await verifyVerificationToken(token, "secret-a")).toEqual({ sub: "domain-1", exp: 2_000_000_000 });
    expect(await verifyVerificationToken(`${token}x`, "secret-a")).toBeNull();
  });
});
```

Create `tests/verification-page.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { renderVerificationParent } from "../src/worker/verification-page";

describe("verification parent", () => {
  it("contains one relay iframe and a fail-open deadline", async () => {
    const response = renderVerificationParent({
      relayUrl: "https://relay.example/.well-known/link-verify/probe-frame?state=signed",
      relayOrigin: "https://relay.example",
      targetUrl: "https://final.example/path?q=1",
      timeoutMs: 3500,
      hideReferer: true,
    });
    const html = await response.text();
    expect(html).toContain('referrerpolicy="no-referrer"');
    expect(html).toContain("3500");
    expect(html).toContain("event.origin !== relayOrigin");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });
});
```

Run `npm.cmd test -- verification-crypto verification-page` and expect import failures.

- [ ] **Step 2: Implement versioned Web Crypto tokens**

Create `src/worker/verification-crypto.ts` with this public shape:

```ts
const encoder = new TextEncoder();

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

async function hmac(secret: string, value: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

export async function signVerificationToken<T>(payload: T, secret: string): Promise<string> {
  const body = base64Url(encoder.encode(JSON.stringify({ v: 1, payload })));
  return `${body}.${base64Url(await hmac(secret, body))}`;
}

export async function verifyVerificationToken<T>(token: string, secret: string): Promise<T | null> {
  const [body, signature] = token.split(".");
  if (!body || !signature) return null;
  const expected = await hmac(secret, body);
  const actual = decodeBase64Url(signature);
  if (actual.length !== expected.length || actual.some((byte, index) => byte !== expected[index])) return null;
  const decoded = JSON.parse(new TextDecoder().decode(decodeBase64Url(body))) as { v: number; payload: T };
  return decoded.v === 1 ? decoded.payload : null;
}
```

- [ ] **Step 3: Implement safe parent/frame HTML and preview routes**

`verification-page.ts` must JSON-encode every dynamic JavaScript value and HTML-escape every attribute. The parent script must use this state machine:

```ts
let finished = false;
const finish = (proof?: string) => {
  if (finished) return;
  finished = true;
  if (proof) {
    fetch("/.well-known/link-verify/probe-complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ proof }),
      keepalive: true,
    }).finally(() => location.replace(targetUrl));
    return;
  }
  location.replace(targetUrl);
};
addEventListener("message", (event) => {
  if (event.origin !== relayOrigin || event.source !== relay.contentWindow) return;
  if (event.data?.type === "link-verify" && typeof event.data.proof === "string") finish(event.data.proof);
});
setTimeout(() => finish(), timeoutMs);
```

`handleVerificationProbe()` must only respond when `VERIFICATION_POC_ENABLED === "true"`. Use Cloudflare's official always-pass Invisible test sitekey `1x00000000000000000000BB` and always-pass test secret `1x0000000000000000000000000000000AA` in `.dev.vars.example`; never use them in production.

- [ ] **Step 4: Run tests and perform the local cross-origin browser gate**

Run:

```powershell
npm.cmd test -- verification-crypto verification-page
npm.cmd run worker:dev
```

Open the parent as `http://localhost:8787/.well-known/link-verify/probe-parent` and load the relay iframe from `http://127.0.0.1:8787/.well-known/link-verify/probe-frame`. Verify successful `postMessage`, a 3.5-second forced timeout, blocked script, and disabled JavaScript.

Record actual pass/fail evidence in `docs/verification/iframe-poc-results.md` for Chrome, Edge, Firefox, Safari/iOS or the available closest browser, mobile viewport, strict privacy mode, and third-party-cookie blocking. A missing platform must be tested on a real device before production, not marked as passed.

- [ ] **Step 5: Run a non-production hostname gate**

Deploy the probe to a non-production Worker route using one non-production parent hostname and one non-production relay hostname. Configure a real Invisible Widget for the relay hostname, verify returned `hostname` and `action`, and confirm the final target receives the expected Referer behavior.

Hard gate: if the iframe cannot reliably obtain a token in any supported browser, stop this plan and write a design amendment for full-page relay validation. Do not start Task 3.

- [ ] **Step 6: Commit the proven transport**

```powershell
git add src/worker/verification-crypto.ts src/worker/verification-page.ts src/worker/verification.ts src/worker/index.ts src/worker/secret-env.d.ts .dev.vars.example tests/verification-crypto.test.ts tests/verification-page.test.ts docs/verification/iframe-poc-results.md
git commit -m "feat: prove Turnstile relay iframe transport"
```

---

### Task 3: Add the Verified Traffic and Relay Schema

**Files:**
- Create: `migrations/0017_verified_traffic.sql`
- Create: `tests/worker/verified-traffic-migration.test.ts`
- Modify: `src/worker/shared.ts`

**Interfaces:**
- Produces: `VerificationPolicy`, `TrafficMetric`, `TrafficSubjectType`, `VerificationRelay`, and expanded domain/short-link contracts.
- Produces D1 tables: `verification_relays`, `traffic_daily_visitors`, `traffic_daily_stats`, and privacy-safe `traffic_debug_samples`.

- [ ] **Step 1: Write the failing migration assertions**

```ts
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("verified traffic schema", () => {
  it("creates visitor uniqueness and relay tables", async () => {
    const tables = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('verification_relays','traffic_daily_visitors','traffic_daily_stats','traffic_debug_samples') ORDER BY name",
    ).all<{ name: string }>();
    expect(tables.results.map((row) => row.name)).toEqual([
      "traffic_debug_samples",
      "traffic_daily_stats",
      "traffic_daily_visitors",
      "verification_relays",
    ]);
  });
});
```

Run `npm.cmd run test:worker -- verified-traffic-migration` and expect failure.

- [ ] **Step 2: Create migration 0017**

`migrations/0017_verified_traffic.sql` must contain these exact structural rules:

```sql
ALTER TABLE redirect_domains ADD COLUMN verification_policy TEXT NOT NULL DEFAULT 'inherit';
ALTER TABLE redirect_domains ADD COLUMN activated_at TEXT;
UPDATE redirect_domains
SET activated_at = COALESCE(last_checked_at, updated_at, created_at)
WHERE status = 'active' OR list_visible = 1;

ALTER TABLE short_links ADD COLUMN verification_policy TEXT NOT NULL DEFAULT 'inherit';

CREATE TABLE verification_relays (
  id TEXT PRIMARY KEY,
  target_service_id TEXT NOT NULL UNIQUE REFERENCES target_services(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 100,
  health_status TEXT NOT NULL DEFAULT 'unknown',
  last_error TEXT,
  last_checked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE traffic_daily_visitors (
  subject_type TEXT NOT NULL CHECK(subject_type IN ('redirect_domain', 'short_link')),
  subject_id TEXT NOT NULL,
  day TEXT NOT NULL,
  visitor_key TEXT NOT NULL,
  classification TEXT NOT NULL CHECK(classification IN ('server_filtered', 'turnstile_verified')),
  first_seen_at TEXT NOT NULL,
  verified_at TEXT,
  referer_host TEXT,
  country TEXT,
  region TEXT,
  city TEXT,
  timezone TEXT,
  language TEXT,
  operating_system TEXT,
  browser TEXT,
  device_type TEXT,
  PRIMARY KEY(subject_type, subject_id, day, visitor_key)
);

CREATE TABLE traffic_daily_stats (
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  day TEXT NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  filtered_uv INTEGER NOT NULL DEFAULT 0,
  verified_uv INTEGER NOT NULL DEFAULT 0,
  rejected_request_count INTEGER NOT NULL DEFAULT 0,
  verification_attempts INTEGER NOT NULL DEFAULT 0,
  verification_passed INTEGER NOT NULL DEFAULT 0,
  verification_failed INTEGER NOT NULL DEFAULT 0,
  verification_timed_out INTEGER NOT NULL DEFAULT 0,
  last_accessed_at TEXT,
  PRIMARY KEY(subject_type, subject_id, day)
);

CREATE TABLE traffic_debug_samples (
  id TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  day TEXT NOT NULL,
  rejection_reason TEXT NOT NULL,
  path_category TEXT NOT NULL,
  user_agent_family TEXT,
  country TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_traffic_visitors_subject_day ON traffic_daily_visitors(subject_type, subject_id, day);
CREATE INDEX idx_traffic_visitors_day_class ON traffic_daily_visitors(day, classification);
CREATE INDEX idx_traffic_stats_day ON traffic_daily_stats(day);
CREATE INDEX idx_traffic_debug_samples_day ON traffic_debug_samples(day, rejection_reason);
CREATE INDEX idx_verification_relays_health ON verification_relays(enabled, health_status, priority);
```

`traffic_debug_samples` must never store raw IPs, visitor hashes, full User-Agent strings, query strings, or arbitrary full paths. `path_category` is a bounded enum such as `root`, `asset`, `scanner`, or `other`, and `user_agent_family` is a coarse parser result.

- [ ] **Step 3: Add shared contracts**

Add to `shared.ts`:

```ts
export type VerificationPolicy = "inherit" | "always" | "never";
export type TrafficMetric = "verified_uv" | "filtered_uv" | "request_count";
export type TrafficSubjectType = "redirect_domain" | "short_link";

export interface VerificationRelay {
  id: string;
  targetServiceId: string;
  targetHost: string;
  enabled: boolean;
  priority: number;
  healthStatus: "unknown" | "checking" | "ok" | "failed";
  lastError: string | null;
  lastCheckedAt: string | null;
}
```

Add `verificationPolicy` and `activatedAt` to `RedirectDomain`, `verificationPolicy` to `ShortLink`, and `requestCount`, `filteredUv`, `verifiedUv` to summary/detail contracts.

- [ ] **Step 4: Run migration and type tests**

```powershell
npm.cmd run test:worker -- verified-traffic-migration
npm.cmd run typecheck
```

Expected: migration test and TypeScript pass.

- [ ] **Step 5: Commit the schema**

```powershell
git add migrations/0017_verified_traffic.sql tests/worker/verified-traffic-migration.test.ts src/worker/shared.ts
git commit -m "feat: add verified traffic schema"
```

---

### Task 4: Implement Shanghai Time, IP Identity, and Request Classification

**Files:**
- Create: `src/worker/time.ts`
- Create: `src/worker/traffic-classifier.ts`
- Modify: `src/worker/redirect.ts:4-121`
- Modify: `src/worker/shared.ts:256-264`
- Modify: `tests/redirect.test.ts`
- Create: `tests/time.test.ts`
- Create: `tests/traffic-classifier.test.ts`

**Interfaces:**
- Produces: `shanghaiDay(date?: Date): string`.
- Produces: `secondsUntilNextShanghaiDay(date?: Date): number`.
- Produces: `visitorKeyFromRequest(request, env): Promise<string>` using IP only.
- Produces: `classifyTrafficRequest(request): TrafficDecision` with a structured rejection reason.

- [ ] **Step 1: Write failing time and identity tests**

```ts
expect(shanghaiDay(new Date("2026-07-15T15:59:59Z"))).toBe("2026-07-15");
expect(shanghaiDay(new Date("2026-07-15T16:00:00Z"))).toBe("2026-07-16");

const first = new Request("https://entry.example/", { headers: { "CF-Connecting-IP": "203.0.113.8", "user-agent": "Browser A" } });
const second = new Request("https://entry.example/other", { headers: { "CF-Connecting-IP": "203.0.113.8", "user-agent": "Browser B" } });
expect(await visitorKeyFromRequest(first, env)).toBe(await visitorKeyFromRequest(second, env));
```

Also assert `HEAD`, `sec-fetch-dest: image`, `purpose: prefetch`, empty UA, Palo Alto scanners, Censys, Netcraft, FeedBurner, `Go-http-client`, and known bot UAs return `kind: "rejected"`.

- [ ] **Step 2: Implement Shanghai date helpers**

```ts
const SHANGHAI = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function shanghaiDay(date = new Date()): string {
  return SHANGHAI.format(date);
}

export function secondsUntilNextShanghaiDay(date = new Date()): number {
  const currentDay = shanghaiDay(date);
  let cursor = new Date(date.getTime() + 60_000);
  while (shanghaiDay(cursor) === currentDay) cursor = new Date(cursor.getTime() + 3_600_000);
  const boundary = Date.parse(`${shanghaiDay(cursor)}T00:00:00+08:00`);
  return Math.max(1, Math.ceil((boundary - date.getTime()) / 1000));
}
```

Replace `today()`/`daysAgo()` callers that define traffic dates; keep UTC timestamps for storage.

- [ ] **Step 3: Implement HMAC(IP) and classification**

Use Web Crypto HMAC-SHA-256 with required `VISITOR_HASH_SECRET`. Normalize IPv4 decimal octets and IPv6 through URL hostname parsing. Export:

```ts
export type TrafficRejectionReason =
  | "method"
  | "non_document"
  | "prefetch"
  | "asset_path"
  | "empty_user_agent"
  | "known_bot"
  | "scanner_path";

export type TrafficDecision =
  | { kind: "candidate" }
  | { kind: "rejected"; reason: TrafficRejectionReason };
```

Do not include host or User-Agent in the visitor HMAC source.

- [ ] **Step 4: Remove duplicate logic from `redirect.ts`**

Replace local `getClientIp`, `sha256Hex`, `isLikelyBotRequest`, and `shouldRecordPageView` logic with imports from `traffic-classifier.ts`. Keep a compatibility export during this task:

```ts
export { classifyTrafficRequest, visitorKeyFromRequest } from "./traffic-classifier";
export function shouldRecordPageView(request: Request): boolean {
  return classifyTrafficRequest(request).kind === "candidate";
}
```

- [ ] **Step 5: Run tests and commit**

```powershell
npm.cmd test -- time traffic-classifier redirect shared
npm.cmd run typecheck
git add src/worker/time.ts src/worker/traffic-classifier.ts src/worker/redirect.ts src/worker/shared.ts tests
git commit -m "fix: define Shanghai daily visitor identity"
```

---

### Task 5: Write One Daily Visitor Fact and Correct Short-Link Counts

**Files:**
- Create: `src/worker/traffic.ts`
- Modify: `src/worker/redirect.ts:124-169`
- Modify: `src/worker/target-service.ts:31-87`
- Modify: `src/worker/index.ts:35-39`
- Modify: `src/worker/db.ts:194-241,372-444,655-866,1070-1188`
- Create: `tests/worker/traffic-repository.test.ts`
- Modify: `tests/redirect.test.ts`

**Interfaces:**
- Produces: `recordTrafficRequest(db, input): Promise<{ isNewFilteredVisitor: boolean }>`.
- Produces: `markTrafficVerified(db, input): Promise<{ upgraded: boolean }>`.
- Produces: `incrementVerificationOutcome(db, input): Promise<void>`.
- Produces: `getTrafficStats(db, subject): Promise<TrafficStats>`.
- Produces: `trafficInputFromRequest(request, subject, env, occurredAt?): Promise<TrafficWriteInput>`.

- [ ] **Step 1: Write failing D1 tests for one-IP/day behavior**

```ts
const candidate = (overrides: Partial<TrafficWriteInput> = {}): TrafficWriteInput => ({
  subjectType: "redirect_domain",
  subjectId: "domain-1",
  day: "2026-07-16",
  visitorKey: "ip-a",
  decision: { kind: "candidate" },
  occurredAt: "2026-07-16T00:00:00.000Z",
  refererHost: null,
  country: null,
  region: null,
  city: null,
  timezone: null,
  language: null,
  operatingSystem: null,
  browser: null,
  deviceType: null,
  ...overrides,
});

await recordTrafficRequest(env.DB, candidate({ subjectId: "domain-1", visitorKey: "ip-a" }));
await recordTrafficRequest(env.DB, candidate({ subjectId: "domain-1", visitorKey: "ip-a", occurredAt: "2026-07-16T00:01:00.000Z" }));
const stats = await getTrafficStats(env.DB, { type: "redirect_domain", id: "domain-1", day: "2026-07-16" });
expect(stats.requestCount).toBe(2);
expect(stats.filteredUv).toBe(1);
expect(stats.verifiedUv).toBe(0);
```

Add tests proving the same visitor upgrades once, another domain counts separately, and one IP visiting the same short link repeatedly counts once.

- [ ] **Step 2: Implement the traffic repository**

Define:

```ts
export interface TrafficWriteInput {
  subjectType: TrafficSubjectType;
  subjectId: string;
  day: string;
  visitorKey: string | null;
  decision: TrafficDecision;
  occurredAt: string;
  refererHost: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  timezone: string | null;
  language: string | null;
  operatingSystem: string | null;
  browser: string | null;
  deviceType: string | null;
}
```

Always upsert `request_count`. For candidates, `INSERT OR IGNORE` the visitor fact; increment `filtered_uv` only when `meta.changes === 1`. For rejected requests, increment `rejected_request_count` without a visitor row. `markTrafficVerified()` must conditionally update only rows whose classification is not already verified and increment `verified_uv` only when that update changes one row.

For diagnostics, deterministically sample at most 1% of rejected requests using the first byte of an HMAC over subject/day/request characteristics. Store only the bounded fields allowed by `traffic_debug_samples`; do not store IP-derived keys or raw request strings. Sampling failure must never delay or fail a redirect.

- [ ] **Step 3: Integrate redirects and short links**

Change `handleTargetService` to accept `ctx: ExecutionContext`; pass it from `index.ts`. Entry redirects and short links call a shared `trafficInputFromRequest()` and use `ctx.waitUntil(recordTrafficRequest(...))` for non-critical filtered writes.

Remove `recordShortLinkVisit()` increments from the request path. Map `ShortLink.visitCount` from `SUM(filtered_uv)` where `subject_type='short_link'`.

- [ ] **Step 4: Move detail/summary reads behind compatibility queries**

During transition, expose new traffic fields while retaining old `visits` as an alias of `filteredUv`:

```ts
return {
  requestCount: numberValue(row.request_count),
  filteredUv: numberValue(row.filtered_uv),
  verifiedUv: numberValue(row.verified_uv),
  visits: numberValue(row.filtered_uv),
};
```

- [ ] **Step 5: Run integration tests and commit**

```powershell
npm.cmd run test:worker -- traffic-repository
npm.cmd test -- redirect
npm.cmd run typecheck
git add src/worker/traffic.ts src/worker/redirect.ts src/worker/target-service.ts src/worker/index.ts src/worker/db.ts tests
git commit -m "fix: count one daily visitor per IP"
```

---

### Task 6: Complete Relay Selection, Siteverify, Proof, Cookie, and Fail-Open

**Files:**
- Create: `src/worker/verification-relays.ts`
- Modify: `src/worker/verification.ts`
- Modify: `src/worker/verification-page.ts`
- Modify: `src/worker/verification-crypto.ts`
- Modify: `src/worker/redirect.ts`
- Modify: `src/worker/target-service.ts`
- Modify: `src/worker/index.ts`
- Modify: `src/worker/env-utils.ts`
- Modify: `src/worker/secret-env.d.ts`
- Create: `tests/verification.test.ts`
- Create: `tests/worker/verification-flow.test.ts`

**Interfaces:**
- Produces: `resolveVerificationPlan(env, subject, request): Promise<VerificationPlan>`.
- Produces: `handlePublicVerification(request, env): Promise<Response | null>`.
- Produces: `validateTurnstile(env, input, fetcher?): Promise<TurnstileResult>`.
- Produces signed cookie `__Secure-lsv` expiring at the next Shanghai midnight.

Define the plan union exactly:

```ts
export type VerificationPlan =
  | { kind: "skip"; reason: "disabled" | "cookie" | "no_relay" }
  | { kind: "challenge"; relay: VerificationRelay; stateToken: string; timeoutMs: number };
```

- [ ] **Step 1: Write failing fail-open and proof tests**

Test these cases explicitly:

```ts
const siteverify = (body: object) => vi.fn(async () => Response.json(body));
expect(await validateTurnstile(env, input, siteverify({ success: true, hostname: "relay.example", action: "redirect_verify" }))).toMatchObject({ verified: true });
expect(await validateTurnstile(env, input, siteverify({ success: true, hostname: "wrong.example", action: "redirect_verify" }))).toMatchObject({ verified: false, reason: "hostname_mismatch" });
expect(await validateTurnstile(env, input, siteverify({ success: false, "error-codes": ["timeout-or-duplicate"] }))).toMatchObject({ verified: false, reason: "siteverify_rejected" });
```

Worker integration tests must assert no healthy relay returns the original redirect, invalid proof returns `{ verified: false }` without a 5xx, and repeated valid proof leaves verified UV at one.

- [ ] **Step 2: Implement relay repository and stable selection**

`verification-relays.ts` exports:

```ts
export async function listHealthyRelays(db: D1Database): Promise<VerificationRelay[]>;
export async function selectRelay(db: D1Database, stableKey: string): Promise<VerificationRelay | null>;
export async function setRelayEnabled(db: D1Database, targetServiceId: string, enabled: boolean): Promise<VerificationRelay>;
export async function refreshRelayHealth(env: Env, relayId: string): Promise<VerificationRelay>;
```

Select from enabled `health_status='ok'` rows checked within 20 minutes. Sort by priority and stable hash so the same subject/day favors the same healthy relay.

- [ ] **Step 3: Implement strict Siteverify and proof validation**

POST JSON to `https://challenges.cloudflare.com/turnstile/v0/siteverify` with `secret`, `response`, `remoteip`, and a UUID `idempotency_key`. Abort at 2,500 ms. Require success, expected relay hostname, and `action === "redirect_verify"`.

State and proof payloads use these exact fields:

```ts
export interface VerificationState {
  kind: "state";
  subjectType: TrafficSubjectType;
  subjectId: string;
  day: string;
  visitorKey: string;
  parentOrigin: string;
  relayHost: string;
  iat: number;
  exp: number;
  nonce: string;
}

export interface VerificationProof extends Omit<VerificationState, "kind" | "parentOrigin" | "nonce"> {
  kind: "proof";
  verifiedAt: string;
}
```

Both expire after 60 seconds. The completion endpoint recomputes visitor key and day before calling `markTrafficVerified()`.

- [ ] **Step 4: Replace probe routes with production reserved routes**

`index.ts` must dispatch `/.well-known/link-verify/*` before target-service and redirect handlers. Implement:

```text
GET  /.well-known/link-verify/frame
POST /.well-known/link-verify/siteverify
POST /.well-known/link-verify/complete
GET  /.well-known/link-verify/health
```

Delete preview-only probe routes and `VERIFICATION_POC_ENABLED` after the browser gate is recorded. `frame` and `siteverify` only operate on enabled relay hosts; `complete` only operates on the subject host.

- [ ] **Step 5: Integrate the challenge page and signed daily cookie**

Before normal redirect response, call `resolveVerificationPlan()`. Return a normal redirect when policy is `never`, global mode is off, the signed daily cookie is valid, or no relay is healthy. Otherwise render the parent page.

Cookie requirements:

```text
__Secure-lsv=<signed token>; Path=/; Domain=<configured root>; Max-Age=<seconds to Shanghai midnight>; Secure; HttpOnly; SameSite=Lax
```

The cookie token contains only subject id, day, visitor key, and expiry. Missing/invalid cookie causes another challenge but does not duplicate UV.

- [ ] **Step 6: Verify fail-open and Referer behavior**

Run tests, then use the existing Referer test endpoint for all combinations: direct/two-step/short-link and hide Referer on/off. Force iframe network failure and Siteverify timeout; final navigation must happen within 3.5 seconds.

- [ ] **Step 7: Commit the complete verification flow**

```powershell
npm.cmd test -- verification
npm.cmd run test:worker -- verification-flow
npm.cmd run typecheck
git add src/worker tests
git commit -m "feat: add fail-open Turnstile verification"
```

---

### Task 7: Add Verification Administration and Relay Health UI

**Files:**
- Modify: `src/worker/api.ts:327-727`
- Modify: `src/worker/db.ts`
- Modify: `src/worker/shared.ts`
- Create: `src/app/src/api.ts`
- Create: `src/app/src/types.ts`
- Create: `src/app/src/components/VerificationSettings.tsx`
- Modify: `src/app/src/main.tsx`
- Modify: `src/app/src/styles.css`
- Create: `tests/verification-api.test.ts`
- Create: `tests/worker/helpers.ts`

**Interfaces:**
- Produces admin APIs from the approved spec.
- Produces `VerificationSettingsView` with global mode, relay list, health, and privacy acknowledgement.

- [ ] **Step 1: Write API contract tests**

```ts
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { createSessionCookie } from "../../src/worker/auth";
import { handleApi } from "../../src/worker/api";

export async function authenticatedJson<T>(method: string, path: string, body?: unknown): Promise<T> {
  const cookie = await createSessionCookie(env);
  const ctx = createExecutionContext();
  const response = await handleApi(
    new Request(`https://${env.ADMIN_HOST}${path}`, {
      method,
      headers: {
        cookie,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  expect(response.ok).toBe(true);
  return (await response.json() as { data: T }).data;
}

expect(await authenticatedJson("GET", "/api/verification/settings")).toMatchObject({
  globalMode: "off",
  hasSiteKey: false,
  hasSecretKey: false,
  privacyAcknowledged: false,
});

expect(await authenticatedJson("POST", "/api/verification/relays", { targetServiceId: "target-1", enabled: true })).toMatchObject({
  targetServiceId: "target-1",
  enabled: true,
});
```

Also test disabling, manual check, deleting relay membership, and rejecting a target host not routed to this Worker.

- [ ] **Step 2: Add management routes**

Implement exact routes:

```text
GET/PATCH /api/verification/settings
GET/POST  /api/verification/relays
PATCH/DELETE /api/verification/relays/:id
POST /api/verification/relays/:id/check
```

Settings values use `settings` keys `VERIFICATION_GLOBAL_MODE` and `TURNSTILE_PRIVACY_ACKNOWLEDGED`. API responses only expose booleans for secrets.

- [ ] **Step 3: Extract frontend API/types without changing behavior**

Move the current `ApiBody`, API contracts, timeout client, and date formatter into `types.ts` and `api.ts`. Export:

```ts
export class ApiRequestError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number) {
    super(message);
  }
}

export async function api<T>(path: string, init?: RequestInit, timeoutMs = 45_000): Promise<T>;
```

Run the existing build before adding new UI to ensure extraction has no behavior change.

- [ ] **Step 4: Build the verification settings module**

The component displays:

- Turnstile sitekey/secret configured badges.
- Privacy acknowledgement checkbox.
- Global off/enabled segmented control.
- Eligible target-service list with “作为验证中转” toggle.
- Relay health, last check, error, refresh, disable, and manual configuration modal.
- Warning when more than 10 relay hosts are selected for one Widget.

Use icons for refresh/settings/delete and preserve the quiet operations-console style.

- [ ] **Step 5: Run tests/build and commit**

```powershell
npm.cmd test -- verification-api
npm.cmd run typecheck
npm.cmd run build
git add src/worker/api.ts src/worker/db.ts src/worker/shared.ts src/app/src
git commit -m "feat: manage Turnstile relay domains"
```

---

### Task 8: Rebuild Domain and Short-Link Analytics on Daily Visitor Facts

**Files:**
- Modify: `src/worker/db.ts:372-444,580-866,1149-1169`
- Modify: `src/worker/shared.ts`
- Create: `src/app/src/components/TrafficAnalytics.tsx`
- Modify: `src/app/src/main.tsx:407-761,974-1132,2683-2743`
- Modify: `src/app/src/styles.css`
- Use existing: `public/countries.geojson`
- Create: `tests/worker/traffic-queries.test.ts`

**Interfaces:**
- Produces detail query parameter `metric=verified_uv|filtered_uv|request_count`.
- Produces `TrafficBreakdownRow { key, label, value, percentage }` where every percentage uses the selected metric denominator.
- Produces recent daily visitors rather than raw path events.

- [ ] **Step 1: Write failing query consistency tests**

Seed two filtered daily visitors, verify one, and add 20 rejected requests. Assert:

```ts
expect(detail.metrics).toEqual({ requestCount: 22, filteredUv: 2, verifiedUv: 1 });
expect(detail.geography.countries.reduce((sum, row) => sum + row.visits, 0)).toBe(1);
expect(detail.recentVisitors).toHaveLength(1);
```

Repeat for `metric=filtered_uv` and short-link detail.

- [ ] **Step 2: Replace analytics SQL**

All geography/client/source queries read `traffic_daily_visitors` and apply:

```sql
AND (? = 'filtered_uv' OR classification = 'turnstile_verified')
```

Request-count charts read `traffic_daily_stats`; do not fabricate request-level geography. Return an empty breakdown with explanatory label when `metric=request_count`.

- [ ] **Step 3: Extract and correct the analytics UI**

`TrafficAnalytics.tsx` owns the metric segmented control, country choropleth, country/region/city tabs, source, language, OS, browser, device, trend, and recent visitors. The map joins `country.toUpperCase()` to `properties.ISO_A2` in `countries.geojson`; remove point-blob rendering and approximate country centroids.

- [ ] **Step 4: Update list cards and short-link counts**

Show exact labels:

```text
请求数
服务器过滤 UV
Cloudflare 验证 UV
```

Domain and short-link list defaults to verified UV when global verification is enabled and to filtered UV otherwise. Never label request count as “访问人数”.

- [ ] **Step 5: Run tests and visual verification**

```powershell
npm.cmd run test:worker -- traffic-queries
npm.cmd run typecheck
npm.cmd run build
```

Use browser screenshots at 1440x900, 1024x768, and 390x844. Check map/list totals, no overlaps, independent scroll areas, and empty states.

- [ ] **Step 6: Commit analytics**

```powershell
git add src/worker/db.ts src/worker/shared.ts src/app/src public/countries.geojson tests/worker/traffic-queries.test.ts
git commit -m "fix: align analytics with daily visitors"
```

---

### Task 9: Replace the Process Lock with a Leased Durable Operation Queue

**Files:**
- Create: `migrations/0018_operation_queue.sql`
- Create: `src/worker/operation-queue.ts`
- Modify: `src/worker/automation.ts`
- Modify: `src/worker/api.ts`
- Modify: `src/worker/db.ts:90-130,1171-1183`
- Create: `tests/worker/operation-queue.test.ts`

**Interfaces:**
- Produces: `enqueueOperation`, `claimNextOperation`, `renewOperationLease`, `completeOperation`, `failOperation`, `retryOperation`.
- Produces operation statuses `queued | running | retry_wait | completed | failed`.
- Produces one global lease with a 60-second expiration.

- [ ] **Step 1: Write failing queue concurrency tests**

```ts
const input = (subjectId: string): EnqueueOperationInput => ({
  idempotencyKey: `provision:${subjectId}`,
  kind: "domain_provision",
  subjectType: "redirect_domain",
  subjectId,
  payload: {},
});

const first = await enqueueOperation(env.DB, input("domain-1"));
const second = await enqueueOperation(env.DB, input("domain-2"));
const [claimA, claimB] = await Promise.all([
  claimNextOperation(env.DB, "worker-a", new Date("2026-07-16T00:00:00Z")),
  claimNextOperation(env.DB, "worker-b", new Date("2026-07-16T00:00:00Z")),
]);
expect([claimA, claimB].filter(Boolean)).toHaveLength(1);
```

Add permanent-failure starvation, lease expiry recovery, idempotency key, retry time, and FIFO tests.

- [ ] **Step 2: Add the queue schema**

```sql
CREATE TABLE operation_queue (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  lease_owner TEXT,
  lease_expires_at TEXT,
  error_code TEXT,
  error_message TEXT,
  result TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  finished_at TEXT
);
CREATE INDEX idx_operation_queue_claim ON operation_queue(status, next_attempt_at, created_at);

CREATE TABLE operation_mutex (
  id TEXT PRIMARY KEY CHECK(id = 'global'),
  owner TEXT,
  lease_expires_at TEXT
);
INSERT INTO operation_mutex(id) VALUES ('global');
```

- [ ] **Step 3: Implement atomic lease acquisition**

Acquire the mutex with one conditional UPDATE and check `meta.changes`:

```sql
UPDATE operation_mutex
SET owner = ?, lease_expires_at = ?
WHERE id = 'global'
  AND (owner IS NULL OR lease_expires_at < ? OR owner = ?)
```

Only the lease owner can transition one eligible queue row to running. Permanent failures use `status='failed'`; retryable failures use `status='retry_wait'` with exponential backoff and jitter.

- [ ] **Step 4: Bridge existing domain jobs and scheduled processing**

Keep `domain_jobs` and `job_steps` as user-visible progress records, but queue all mutating work through `operation_queue`. `runScheduled()` claims at most one operation and performs at most one idempotent step. Remove `withOperationLock()` callers after every mutation path is queued.

- [ ] **Step 5: Add operation status/retry API**

```text
GET  /api/operations/:id
POST /api/operations/:id/retry
```

The retry endpoint only accepts terminal failed operations and creates no duplicate when the same idempotency key is already queued/running.

- [ ] **Step 6: Run tests and commit**

```powershell
npm.cmd run test:worker -- operation-queue
npm.cmd run typecheck
git add migrations/0018_operation_queue.sql src/worker tests/worker/operation-queue.test.ts
git commit -m "feat: serialize mutations with durable leases"
```

---

### Task 10: Make Cloudflare and Dynadot Automation Exact, Idempotent, and Retryable

**Files:**
- Create: `src/worker/automation-errors.ts`
- Modify: `src/worker/cloudflare.ts`
- Modify: `src/worker/dynadot.ts`
- Modify: `src/worker/automation.ts`
- Modify: `src/worker/target-automation.ts`
- Modify: `src/worker/api.ts:183-326,440-567`
- Modify: `tests/cloudflare.test.ts`
- Create: `tests/dynadot.test.ts`
- Create: `tests/automation-errors.test.ts`

**Interfaces:**
- Produces: `AutomationError { code, message, retryable, retryAfterMs, safeMetadata }`.
- Produces exact `ensureDnsRecords()` and `ensureWorkerRoutes()` behavior.
- Produces Chinese manual configuration details for every permanent failure.

- [ ] **Step 1: Add failing exactness tests**

Test these cases with mock fetch:

```ts
it("updates an existing wrong A record", async () => {
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ success: true, result: [{ id: "dns-1", type: "A", name: "example.com", content: "203.0.113.9", proxied: false }] }))
    .mockResolvedValueOnce(Response.json({ success: true, result: { id: "dns-1" } }))
    .mockResolvedValueOnce(Response.json({ success: true, result: [] }))
    .mockResolvedValueOnce(Response.json({ success: true, result: { id: "dns-2" } }));
  vi.stubGlobal("fetch", fetchMock);
  await ensureDnsRecords(env, "zone-1", "example.com");
  expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/dns_records/dns-1"), expect.objectContaining({ method: "PUT" }));
});

it("replaces a route pointing at another script", async () => {
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ success: true, result: [{ id: "route-1", pattern: "example.com/*", script: "other-worker" }] }))
    .mockResolvedValueOnce(Response.json({ success: true, result: { id: "route-1" } }));
  vi.stubGlobal("fetch", fetchMock);
  await ensureWorkerRoutes(env, "zone-1", "example.com");
  const update = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT");
  expect(JSON.parse(String(update?.[1]?.body))).toMatchObject({ pattern: "example.com/*", script: env.WORKER_SCRIPT_NAME });
});
```

Add tests for existing Zone reuse, already-matching nameservers, 429 `Retry-After`, 5xx retry, permission failure, expired Dynadot domain, and `set_ns` failure.

- [ ] **Step 2: Implement structured API errors and retry policy**

`cfRequest()` and Dynadot parsing throw `AutomationError`. Map:

- HTTP 429, 5xx, network timeout, DNS pending: retryable.
- Zone/DNS/Route permission error, ownership failure, expired domain, conflicting resource: permanent.
- Cloudflare `Retry-After` controls next attempt when present.

Never include Authorization headers, full API response bodies, or tokens in `safeMetadata`.

- [ ] **Step 3: Enforce exact DNS and Route state**

For `@` and `*`, desired record is:

```ts
{ type: "A", name: host, content: "192.0.2.1", proxied: true, ttl: 1 }
```

Update an existing wrong A record in place; remove only conflicting A/AAAA records owned by this automation path. For routes, compare both `pattern` and `script`; update mismatches and leave correct routes untouched.

- [ ] **Step 4: Queue every mutation**

Nameserver tool, Zone deletion, target repair, domain provisioning, manual retry, dependent target updates, and advanced cleanup enqueue one operation per domain. No backend handler loops through multiple domains and no mutation path uses `Promise.all()`.

- [ ] **Step 5: Return manual configuration instructions**

Permanent errors return a structured list:

```ts
interface ManualConfiguration {
  nameservers: string[];
  dnsRecords: Array<{ type: "A"; name: string; content: "192.0.2.1"; proxied: true }>;
  workerRoutes: Array<{ pattern: string; script: string }>;
  registrarAction: string | null;
}
```

Map Dynadot `was expired` to “域名已过期，注册商拒绝修改 NS；续费后点击重试。”

- [ ] **Step 6: Run tests and commit**

```powershell
npm.cmd test -- cloudflare dynadot automation-errors
npm.cmd run typecheck
git add src/worker tests
git commit -m "fix: make provider automation idempotent"
```

---

### Task 11: Correct Target Health, Activation Visibility, and Forced Deletion

**Files:**
- Modify: `src/worker/target-health.ts`
- Modify: `src/worker/target-service.ts`
- Modify: `src/worker/target-automation.ts`
- Modify: `src/worker/db.ts:280-535,580-654,868-1069`
- Modify: `src/worker/api.ts:454-567`
- Modify: `tests/target-health.test.ts`
- Create: `tests/worker/target-lifecycle.test.ts`

**Interfaces:**
- Produces independent `dnsStatus`, `routeStatus`, `workerHealthStatus`, and `httpStatus`.
- Produces list visibility from `activated_at IS NOT NULL`, not current active status.
- Produces idempotent forced target deletion with dependent-domain failure reasons.

- [ ] **Step 1: Write failing target health/lifecycle tests**

Assert a target with database status `active/configured` but failing `/.well-known/link-verify/health` is red. Assert a never-active failed domain is absent from list/summary, while an activated domain whose target was deleted remains visible with `last_error = '目标服务已删除'`.

- [ ] **Step 2: Replace shortcut health with real health endpoint checks**

`checkTargetHealth()` always fetches:

```text
https://<target-host>/.well-known/link-verify/health
```

Expected status is `204`. Keep an 8-second outer timeout, record DNS/Route separately, and never report green solely from stored automation fields.

- [ ] **Step 3: Set activation exactly once**

When a domain first reaches `active`, update:

```sql
activated_at = COALESCE(activated_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
list_visible = 1
```

List and summary queries use `activated_at IS NOT NULL`. Failed new domains remain in operation results only.

- [ ] **Step 4: Make forced target deletion deterministic**

Within one D1 batch: disable/delete relay membership, set dependent domains' `target_service_id=NULL`, preserve `deleted_target_host`, mark status failed with the explicit reason, delete dependent short links, then delete the target. Repeated deletion returns the same terminal shape instead of throwing an intermittent conflict.

- [ ] **Step 5: Run tests and commit**

```powershell
npm.cmd test -- target-health
npm.cmd run test:worker -- target-lifecycle
npm.cmd run typecheck
git add src/worker tests
git commit -m "fix: make target lifecycle observable"
```

---

### Task 12: Fix Frontend Serial Batches, Stable Polling, and Persistent Results

**Files:**
- Create: `src/app/src/hooks/useOperationPolling.ts`
- Create: `src/app/src/components/BatchResults.tsx`
- Modify: `src/app/src/main.tsx:225-282,1145-1618,2110-2499`
- Modify: `src/app/src/styles.css`
- Create: `tests/app-batch-state.test.ts`

**Interfaces:**
- Produces: `runSerialBatch<TInput, TResult>(items, worker, onResult): Promise<void>`.
- Produces: `useOperationPolling(operationIds, fetchOperation, intervalMs)` with one timer and cancellation.
- Produces persistent result rows with retry payload and operation id.

- [ ] **Step 1: Extract and test serial batch state**

```ts
const calls: string[] = [];
await runSerialBatch(["a", "b", "c"], async (item) => {
  calls.push(`start:${item}`);
  await Promise.resolve();
  calls.push(`end:${item}`);
  return { item, ok: true };
}, () => undefined);
expect(calls).toEqual(["start:a", "end:a", "start:b", "end:b", "start:c", "end:c"]);
```

Add timeout-as-failure and continue-next-item tests.

- [ ] **Step 2: Implement stable operation polling**

The hook derives a sorted, joined key from non-terminal operation ids. It owns one `setInterval`, uses an `AbortController`, stops on unmount, and does not depend on the result array it updates:

```ts
const operationKey = useMemo(() => [...operationIds].sort().join(","), [operationIds]);
useEffect(() => {
  if (!operationKey) return;
  const controller = new AbortController();
  const timer = window.setInterval(() => void refresh(controller.signal), intervalMs);
  void refresh(controller.signal);
  return () => { controller.abort(); window.clearInterval(timer); };
}, [operationKey, intervalMs, refresh]);
```

Memoize `refresh` with stable dependencies.

- [ ] **Step 3: Replace all batch loops**

Use `runSerialBatch()` for entry addition, Cloudflare intake, Zone deletion, multi-domain delete, and retries. Each item waits for a terminal operation status or a defined client timeout before continuing. A client timeout is a visible failed result with a manual retry button; it is not silently left “处理中”.

- [ ] **Step 4: Build persistent shared results UI**

Persist each module under a versioned localStorage key. `BatchResults` renders total/processed/success/failed/processing, error tooltip/detail, retry icon, and clear-results button. Clearing never calls a business delete API.

- [ ] **Step 5: Constrain long forms and verify responsive layout**

Set the Cloudflare intake form column to a stable max height; textarea and controls stay fixed while results scroll independently. Verify at 1440x900 and 390x844 with 100 result rows.

- [ ] **Step 6: Run tests/build and commit**

```powershell
npm.cmd test -- app-batch-state
npm.cmd run typecheck
npm.cmd run build
git add src/app/src tests/app-batch-state.test.ts
git commit -m "fix: stabilize serial batch operations"
```

---

### Task 13: Upgrade Passwords, Sessions, CSRF, Login Throttling, and Stored Secrets

**Files:**
- Create: `migrations/0019_auth_security.sql`
- Create: `src/worker/crypto-settings.ts`
- Modify: `src/worker/auth.ts`
- Modify: `src/worker/env-utils.ts`
- Modify: `src/worker/api.ts:331-439,727-735`
- Modify: `src/worker/http.ts`
- Modify: `src/app/src/api.ts`
- Modify: `src/app/src/main.tsx:762-973,2503-2682`
- Modify: `tests/auth.test.ts`
- Create: `tests/worker/auth-security.test.ts`

**Interfaces:**
- Produces password format `pbkdf2-sha256$100000$<salt-b64url>$<hash-b64url>`.
- Produces `hashPassword(password, pepper): Promise<string>` and `verifyPasswordHash(password, encoded, pepper): Promise<PasswordVerification>`.
- Produces HMAC session claims `{ sub, exp, csrf, version }`.
- Produces AES-GCM settings format `enc:v1:<iv-b64url>:<ciphertext-b64url>`.

- [ ] **Step 1: Write failing security tests**

Test:

```ts
const encoded = await hashPassword("correct horse battery staple", "test-pepper");
expect(encoded).toMatch(/^pbkdf2-sha256\$100000\$/);
expect(await verifyPasswordHash("correct horse battery staple", encoded, "test-pepper")).toMatchObject({ valid: true });
expect(await verifyPasswordHash("wrong", encoded, "test-pepper")).toMatchObject({ valid: false });
```

Also test legacy 64-hex SHA-256 returns `needsUpgrade=true`, invalid Origin/CSRF rejects writes, five failed logins trigger cooldown, ciphertext does not contain plaintext, and API responses never return decrypted keys.

- [ ] **Step 2: Add auth schema**

```sql
CREATE TABLE auth_attempts (
  ip_hash TEXT PRIMARY KEY,
  window_started_at TEXT NOT NULL,
  failure_count INTEGER NOT NULL DEFAULT 0,
  blocked_until TEXT,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO settings(key, value) VALUES ('SESSION_VERSION', '1');
```

- [ ] **Step 3: Implement PBKDF2 and Web Crypto HMAC sessions**

Use random 16-byte salts, 100,000 PBKDF2-HMAC-SHA-256 iterations, and a 32-byte result. Mix `SESSION_SECRET` into the password input as a server-side pepper so a D1-only disclosure is insufficient to verify password guesses. Replace the hand-written SHA-256/signature code with `crypto.subtle`. On successful legacy login, write the upgraded PBKDF2 hash to D1 because `configuredValue()` already gives D1 precedence over deployed env values.

Changing password increments `SESSION_VERSION`; `requireSession()` rejects older sessions.

- [ ] **Step 4: Add login throttling and CSRF**

Hash login IP with `SESSION_SECRET`; never store raw IP. Use a 15-minute window, block after five failures, and exponentially extend cooldown up to one hour. Successful login clears the row.

Return CSRF token from login and `/api/me`. For every authenticated non-GET request require both same-origin `Origin` and `X-CSRF-Token` equal to the session claim. Update `api.ts` to attach the in-memory token.

- [ ] **Step 5: Encrypt mutable provider keys**

`crypto-settings.ts` uses `SETTINGS_ENCRYPTION_KEY` with AES-GCM and a random 12-byte IV. `setSetting()` encrypts `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, and `DYNADOT_API_KEY` when supplied through UI; `configuredValue()` decrypts `enc:v1` values and still reads Worker Secrets. Responses expose configured booleans and a maximum four-character suffix only.

- [ ] **Step 6: Benchmark on a non-production Worker**

Deploy an authenticated benchmark route only on the non-production Worker and record at least 30 password-verification samples. The p95 CPU time must remain below 8 ms so it fits the Workers Free 10 ms CPU budget with request overhead. Remove the benchmark route immediately after measurement. If the gate fails, stop release and require Cloudflare Access or a Paid-plan/design amendment; do not silently reduce iterations.

- [ ] **Step 7: Run tests and commit**

```powershell
npm.cmd test -- auth
npm.cmd run test:worker -- auth-security
npm.cmd run typecheck
git add migrations/0019_auth_security.sql src/worker src/app/src tests
git commit -m "fix: harden admin authentication and secrets"
```

---

### Task 14: Add Chunked Backfill, Rebuild, and Retention Maintenance

**Files:**
- Create: `src/worker/traffic-maintenance.ts`
- Modify: `src/worker/automation.ts:125-133`
- Modify: `src/worker/api.ts`
- Modify: `src/worker/db.ts:1186-1188`
- Create: `tests/worker/traffic-maintenance.test.ts`

**Interfaces:**
- Produces operation kinds `traffic_backfill`, `traffic_rebuild_day`, and `traffic_cleanup`.
- Produces chunk size of 500 rows per invocation.
- Keeps daily aggregates long term, daily visitor facts 30 days, and debug samples 7 days.

- [ ] **Step 1: Write failing migration/retention tests**

Seed old `visit_events`, current traffic facts, and aggregates. Assert one chunk migrates no more than 500 old visitor keys, every migrated row is `server_filtered`, `verified_uv` remains zero, facts older than 30 days are deleted, and aggregates remain.

Historical `visit_events` do not contain raw IP and their old `visitor_key` included host/IP/User-Agent, so backfill cannot reconstruct the new IP-only identity. Tests and UI must label all pre-cutover rows as `历史过滤口径`; never claim that historical `filtered_uv` obeys the new one-IP/day definition.

- [ ] **Step 2: Implement resumable backfill checkpoints**

Store checkpoints in `settings` keys:

```text
TRAFFIC_BACKFILL_DAY
TRAFFIC_BACKFILL_LAST_EVENT_ID
TRAFFIC_BACKFILL_COMPLETE
```

Each operation reads a stable page ordered by `visited_at, id`, inserts the first event per old unique visitor, updates checkpoint, and requeues itself until complete. It never runs a full-table rebuild in one invocation.

Backfilled rows preserve the legacy visitor key only as an opaque compatibility identity. They remain `server_filtered`, never upgrade to verified, and the analytics response carries a `legacyMetricBefore` cutover date so the UI can display the historical-method label.

- [ ] **Step 3: Implement chunked cleanup and aggregate verification**

Delete facts with a bounded subquery:

```sql
DELETE FROM traffic_daily_visitors
WHERE rowid IN (
  SELECT rowid FROM traffic_daily_visitors WHERE day < ? ORDER BY day LIMIT 500
)
```

Delete `traffic_debug_samples` older than 7 days with the same bounded 500-row pattern. Debug cleanup never touches daily aggregates.

Before deleting old compatibility events, compare daily filtered totals between old and new tables and record mismatches as a failed maintenance operation.

- [ ] **Step 4: Schedule maintenance without starving business operations**

Cron priority order: one user/provider operation, one relay/target health item, then one maintenance chunk. Permanent failures never re-enter eligible selection. Maintenance may be paused via `TRAFFIC_MAINTENANCE_ENABLED=false`.

- [ ] **Step 5: Run tests and commit**

```powershell
npm.cmd run test:worker -- traffic-maintenance
npm.cmd run typecheck
git add src/worker tests/worker/traffic-maintenance.test.ts
git commit -m "feat: migrate and retain traffic in chunks"
```

---

### Task 15: Final Documentation, Full Verification, Safe Migration, and Gradual Release

**Files:**
- Modify: `.dev.vars.example`
- Modify: `wrangler.jsonc`
- Modify: `README.md`
- Create: `docs/deployment-turnstile.md`
- Create: `docs/operations-runbook.md`
- Modify after execution: `docs/verification/iframe-poc-results.md`

**Interfaces:**
- Produces a no-secret deployment guide, rollback runbook, monitoring checklist, and recorded release evidence.

- [ ] **Step 1: Document exact configuration**

Add public vars to `wrangler.jsonc`:

```jsonc
"TURNSTILE_SITE_KEY": "",
"VERIFICATION_TIMEOUT_MS": "3500",
"SITEVERIFY_TIMEOUT_MS": "2500",
"TRAFFIC_TIMEZONE": "Asia/Shanghai",
"TRAFFIC_FACT_RETENTION_DAYS": "30",
"TRAFFIC_DEBUG_RETENTION_DAYS": "7"
```

Document secrets commands without values:

```powershell
npm.cmd exec wrangler -- secret put TURNSTILE_SECRET_KEY --config .wrangler/deploy.jsonc
npm.cmd exec wrangler -- secret put VISITOR_HASH_SECRET --config .wrangler/deploy.jsonc
npm.cmd exec wrangler -- secret put VERIFICATION_SIGNING_SECRET --config .wrangler/deploy.jsonc
npm.cmd exec wrangler -- secret put SETTINGS_ENCRYPTION_KEY --config .wrangler/deploy.jsonc
```

Include Turnstile hostname limits, Invisible privacy-policy acknowledgement, test keys vs production keys, and relay health requirements.

- [ ] **Step 2: Run the complete local verification suite**

```powershell
npm.cmd run test:all
npm.cmd run typecheck
npm.cmd run build
npm.cmd run deploy:dry-run
```

Expected: all commands exit 0. Also run the public repository secret scan from `README.md`; it must find no real credential.

- [ ] **Step 3: Perform browser and flow verification**

Test desktop/mobile login, relay setup, privacy acknowledgement, direct redirect, two-step redirect, short link, Referer on/off, same-IP dedupe, another-domain count, forced timeout, disabled JavaScript, target deletion, batch timeout/retry, and analytics map totals. Capture screenshots and console/network errors in the operations runbook.

- [ ] **Step 4: Back up D1 and apply additive migrations**

Export production D1 to a timestamped local file outside Git. Then run:

```powershell
npm.cmd exec wrangler -- d1 migrations apply link-shortener-manager --remote --config .wrangler/deploy.jsonc
```

Verify migrations 0017-0019 are recorded. Do not enable global verification yet.

- [ ] **Step 5: Deploy with verification globally off**

```powershell
npm.cmd exec wrangler -- deploy --config .wrangler/deploy.jsonc --keep-vars
```

Smoke-test existing redirects and admin API. Configure one non-critical relay and one to three canary entry domains with policy `always`; keep global mode `off`.

- [ ] **Step 6: Observe the canary for at least 24 hours**

Record redirect success rate, verified success rate, fail-open count, P50/P95 added latency, D1 writes, Worker errors, and raw/filtered/verified ratios. Required release thresholds:

```text
Redirect success >= 99.9%
P95 added verification latency <= 3.5 seconds
No verified UV without a successful Siteverify
No duplicate verified UV for the controlled same-IP/day test
No permanent queue item blocks later operations
```

- [ ] **Step 7: Enable global verification and backfill gradually**

After canary approval, switch global mode to enabled. Enable short links separately after their own canary. Start backfill at low priority and compare old/new filtered totals before old-event cleanup.

- [ ] **Step 8: Verify rollback controls**

Exercise global mode off, relay disable, and Worker version rollback in a non-production environment. Confirm additive tables do not require schema downgrade and old filtered analytics remain readable.

- [ ] **Step 9: Commit documentation and release evidence**

```powershell
git add .dev.vars.example wrangler.jsonc README.md docs
git commit -m "docs: add verified traffic operations runbook"
```

Do not commit the production D1 export, screenshots containing tokens, browser storage, real domain secrets, or `.wrangler/deploy.jsonc`.

---

## Completion Gate

The implementation is complete only when all 15 task commits exist, every automated command passes, the hidden-iframe browser matrix is recorded, canary thresholds hold for at least 24 hours, production remains fail-open under forced verification failures, and the user confirms the global rollout result.
