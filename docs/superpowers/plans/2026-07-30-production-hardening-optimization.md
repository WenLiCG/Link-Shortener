# Production Hardening and Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the production security, automation, queue, consistency, and client performance defects found in the 2026-07-30 review without redesigning visitor identity or traffic-count formulas.

**Architecture:** Keep the current React, Worker, and D1 structure. Use Worker Secrets for credentials, Web Crypto for authentication, the existing `domain_jobs` table as the single leased mutation queue, exact Cloudflare reconciliation, and one stable frontend polling loop. Keep Turnstile disabled until its cross-origin transport passes a real non-production browser gate.

**Tech Stack:** React 19, TypeScript 5.9, Cloudflare Workers, D1, Wrangler, Vitest, `@cloudflare/vitest-pool-workers`.

## Global Constraints

- Do not change the definition of a unique visitor in this plan.
- Do not deploy or merge the unverified Turnstile POC as production behavior.
- Every Cloudflare/Dynadot mutation must enter one durable serial queue.
- Every API still accepts at most one domain per mutation request.
- Failed or timed-out work must have a terminal error or a scheduled retry; it must never disappear.
- Incomplete domains remain hidden from the domain list and dashboard totals.
- Redirects continue even when analytics or verification writes fail.
- Do not add runtime dependencies.
- Use native Web Crypto, Worker Secrets, `AbortSignal.timeout`, and D1 `batch()` before adding helpers.
- Each task is independently testable and independently releasable.

---

### Task 1: Establish the Worker/D1 Test Baseline

**Files:**
- Reuse commit: `eb8862f test: add Worker D1 integration harness`
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `vitest.worker.config.ts`
- Create: `tests/worker/apply-migrations.ts`
- Create: `tests/worker/migrations-smoke.test.ts`

**Interfaces:**
- Consumes: every SQL file in `migrations/`.
- Produces: `npm run test:node`, `npm run test:worker`, and `npm test`.

- [ ] **Step 1: Apply only the committed test-harness change**

Run:

```powershell
git cherry-pick eb8862f
```

Do not stage or copy the uncommitted Turnstile POC files from its worktree.

- [ ] **Step 2: Verify dependency versions**

Run:

```powershell
npm.cmd install
npm.cmd audit
```

Upgrade Wrangler and the Worker Vitest pool together only when the audit or peer dependency output requires it.

- [ ] **Step 3: Run the Node and Worker suites separately**

Run:

```powershell
npm.cmd run test:node
npm.cmd run test:worker
```

Expected: all existing Node tests pass and the D1 migration smoke test applies migrations `0001` through `0016`.

- [ ] **Step 4: Run the complete baseline**

Run:

```powershell
npm.cmd test
npm.cmd run typecheck
npm.cmd run build
npm.cmd run wrangler:check
```

Expected: every command exits with code 0.

- [ ] **Step 5: Commit any dependency-only adjustment**

```powershell
git add package.json package-lock.json vitest.config.ts vitest.worker.config.ts tests/worker
git commit -m "test: establish Worker D1 baseline"
```

Skip this commit when cherry-pick `eb8862f` needs no follow-up adjustment.

---

### Task 2: Replace Stored Credentials and Hand-Written Authentication

**Files:**
- Modify: `src/worker/auth.ts`
- Modify: `src/worker/api.ts`
- Modify: `src/worker/env-utils.ts`
- Modify: `src/worker/secret-env.d.ts`
- Modify: `src/worker/http.ts`
- Modify: `src/app/src/main.tsx`
- Create: `migrations/0017_remove_stored_credentials.sql`
- Modify: `tests/auth.test.ts`
- Create: `tests/worker/auth-api.test.ts`
- Modify: `.dev.vars.example`
- Modify: `README.md`

**Interfaces:**
- Keeps: `verifyPassword(env, password): Promise<boolean>`.
- Keeps: `createSessionCookie(env): Promise<string>`.
- Keeps: `requireSession(request, env): Promise<void>`.
- Produces password hashes formatted as `pbkdf2-sha256$100000$<salt-base64url>$<digest-base64url>`.
- Produces HMAC-SHA-256 session signatures through `crypto.subtle`.

- [ ] **Step 1: Write failing authentication tests**

Add tests proving:

```ts
expect(await hashPasswordForDocs("correct horse battery staple")).toMatch(/^pbkdf2-sha256\$100000\$/);
expect(await verifyPassword(envWithHash, "correct horse battery staple")).toBe(true);
expect(await verifyPassword(envWithHash, "wrong")).toBe(false);
expect(await requireSession(tamperedRequest, env)).rejects.toMatchObject({ status: 401 });
expect(await requireSession(oldSessionAfterPasswordChange, changedEnv)).rejects.toMatchObject({ status: 401 });
```

Add a Worker API test proving six failed logins for the same HMAC-hashed IP produce HTTP 429, while a successful login clears that failure record.

- [ ] **Step 2: Run the focused tests and confirm failure**

```powershell
npm.cmd run test:node -- tests/auth.test.ts
npm.cmd run test:worker -- tests/worker/auth-api.test.ts
```

- [ ] **Step 3: Replace custom SHA and session signing with Web Crypto**

Implement PBKDF2 with:

```ts
const iterations = 100_000;
const salt = crypto.getRandomValues(new Uint8Array(16));
const material = await crypto.subtle.importKey("raw", encoder.encode(`${password}.${pepper}`), "PBKDF2", false, ["deriveBits"]);
const digest = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, material, 256);
```

Use the independent Worker Secret `PASSWORD_PEPPER` as the pepper. Verify session signatures with `crypto.subtle.verify("HMAC", key, signature, data)`, not a JavaScript byte loop. Rotating `SESSION_SECRET` must invalidate sessions without changing password verification.

Keep legacy 64-character SHA-256 verification for one successful login only. After that login, write the PBKDF2 hash to `settings.ADMIN_PASSWORD_HASH`.

- [ ] **Step 4: Invalidate sessions after password changes**

Add a fingerprint of the current encoded password hash to the signed session payload:

```ts
interface SessionPayload {
  sub: "admin";
  exp: number;
  passwordVersion: string;
}
```

`requireSession()` must compare the signed fingerprint to the current configured password hash. A password change therefore invalidates every old session without another table.

- [ ] **Step 5: Add bounded login throttling**

Store one JSON value in `settings` under `login_fail:<HMAC-IP>`:

```ts
interface LoginFailure {
  count: number;
  firstAt: number;
  blockedUntil: number;
}
```

Use a 15-minute window, block for 15 minutes after five failures, clear on success, and never store the raw IP.

- [ ] **Step 6: Remove provider-key editing from the application**

Delete the API writes for:

```text
CLOUDFLARE_API_TOKEN
DYNADOT_API_KEY
CLOUDFLARE_ACCOUNT_ID
```

Keep `/api/registrars` GET returning configured booleans. The UI shows status and the exact `wrangler secret put` commands, but no longer accepts secret values.

Keep `DYNADOT_SANDBOX` as a normal non-secret setting.

- [ ] **Step 7: Remove existing stored provider credentials**

Create `migrations/0017_remove_stored_credentials.sql`:

```sql
DELETE FROM settings
WHERE key IN ('CLOUDFLARE_API_TOKEN', 'DYNADOT_API_KEY', 'CLOUDFLARE_ACCOUNT_ID');
```

- [ ] **Step 8: Reject cross-origin authenticated mutations**

For authenticated non-GET requests, require:

```ts
new URL(request.headers.get("origin") ?? request.url).origin === new URL(request.url).origin
```

Return HTTP 403 when an explicit `Origin` differs. Keep the existing `SameSite=Lax`, `HttpOnly`, and `Secure` cookie attributes.

- [ ] **Step 9: Run the security tests**

```powershell
npm.cmd run test:node -- tests/auth.test.ts
npm.cmd run test:worker -- tests/worker/auth-api.test.ts
npm.cmd run typecheck
```

- [ ] **Step 10: Commit**

```powershell
git add migrations/0017_remove_stored_credentials.sql src/worker/auth.ts src/worker/api.ts src/worker/env-utils.ts src/worker/secret-env.d.ts src/worker/http.ts src/app/src/main.tsx tests/auth.test.ts tests/worker/auth-api.test.ts .dev.vars.example README.md
git commit -m "fix: harden administrator credentials"
```

---

### Task 3: Make Cloudflare Automation and Target Health Exact

**Files:**
- Modify: `src/worker/cloudflare.ts`
- Modify: `src/worker/dynadot.ts`
- Create: `src/worker/provider-error.ts`
- Modify: `src/worker/automation.ts`
- Modify: `src/worker/target-automation.ts`
- Modify: `src/worker/target-health.ts`
- Modify: `src/worker/api.ts`
- Modify: `tests/cloudflare.test.ts`
- Modify: `tests/target-health.test.ts`
- Create: `tests/dynadot.test.ts`

**Interfaces:**
- Keeps: `ensureDnsRecords(env, zoneId, domain): Promise<void>`.
- Keeps: `ensureWorkerRoutes(env, zoneId, domain): Promise<void>`.
- Keeps: `refreshTargetHealth(env, targetId): Promise<void>`.
- Produces:

```ts
export class ProviderError extends Error {
  constructor(
    public readonly provider: "cloudflare" | "dynadot",
    public readonly status: number | null,
    public readonly code: string,
    public readonly retryable: boolean,
    message: string,
  ) {
    super(message);
  }
}
```

- [ ] **Step 1: Write failing reconciliation tests**

Add tests proving:

```ts
// Existing wrong or unproxied A records are replaced.
expect(updatedRecord).toMatchObject({ content: "192.0.2.1", proxied: true });

// Existing route bound to another script is corrected.
expect(updatedRoute).toMatchObject({ pattern: "example.com/*", script: "multi-domain-redirect-manager" });

// Stored DNS status never makes an unreachable target healthy.
expect(health.status).toBe("failed");
```

Add Dynadot tests for timeout, HTTP 429, malformed JSON, domain-not-owned, and `set_ns` rejection.

- [ ] **Step 2: Run focused tests and confirm failure**

```powershell
npm.cmd run test:node -- tests/cloudflare.test.ts tests/target-health.test.ts tests/dynadot.test.ts
```

- [ ] **Step 3: Reuse the existing exact DNS helper**

Change `ensureDnsRecords()` to call:

```ts
await ensureWorkerDnsRecordForHost(env, zoneId, domain);
await ensureWorkerDnsRecordForHost(env, zoneId, `*.${domain}`);
```

Delete the duplicate “any A record is enough” implementation.

- [ ] **Step 4: Reconcile Worker Route pattern and script**

Include `script` in the route response type. A route is correct only when both fields match:

```ts
route.pattern === pattern && route.script === expectedScript
```

Replace or update a mismatched route before marking `routeStatus` configured.

- [ ] **Step 5: Bound provider requests**

Give every provider fetch a 10-second timeout with `AbortSignal.timeout(10_000)`.

Do not sleep or retry inside provider clients. Convert timeout, HTTP 429, and 5xx responses into retryable `ProviderError` values and let the durable job schedule the next attempt. POST creation calls are therefore never repeated blindly.

Handle non-JSON responses without exposing response bodies or credentials.

Read Cloudflare Zone pages until a page is empty or `result_info.total_pages` is reached. Remove the fixed ten-page/500-Zone ceiling.

- [ ] **Step 6: Make health checks real**

Delete the stored-status shortcut in `refreshTargetHealth()`. Always execute `checkTargetHealth(target.targetHost)`.

For a managed target service, HEAD `/` must return 204. Fall back to GET only for HTTP 405/501, where GET `/` must return 200. Treat unrelated 3xx responses as failed configuration rather than silently proving health.

- [ ] **Step 7: Sanitize API errors**

Unknown exceptions return:

```json
{"ok":false,"error":{"code":"server_error","message":"服务器内部错误。"}}
```

Log only a generated request ID, provider, HTTP status, and safe error code. Do not return or log upstream bodies, request URLs containing keys, or raw D1 errors.

- [ ] **Step 8: Run tests**

```powershell
npm.cmd run test:node -- tests/cloudflare.test.ts tests/target-health.test.ts tests/dynadot.test.ts
npm.cmd run typecheck
```

- [ ] **Step 9: Commit**

```powershell
git add src/worker/cloudflare.ts src/worker/dynadot.ts src/worker/provider-error.ts src/worker/automation.ts src/worker/target-automation.ts src/worker/target-health.ts src/worker/api.ts tests/cloudflare.test.ts tests/target-health.test.ts tests/dynadot.test.ts
git commit -m "fix: reconcile provider state exactly"
```

---

### Task 4: Turn `domain_jobs` Into the Single Durable Mutation Queue

**Files:**
- Create: `migrations/0018_domain_jobs_queue.sql`
- Modify: `src/worker/db.ts`
- Modify: `src/worker/automation.ts`
- Modify: `src/worker/api.ts`
- Modify: `src/worker/target-automation.ts`
- Modify: `src/worker/shared.ts`
- Modify: `src/app/src/main.tsx`
- Create: `tests/worker/domain-jobs-queue.test.ts`
- Create: `tests/worker/target-delete.test.ts`

**Interfaces:**
- Produces:

```ts
type JobStatus = "queued" | "running" | "retry_wait" | "completed" | "failed";

interface EnqueueJobInput {
  type: "domain_provision" | "domain_retry" | "domain_delete" | "target_repair" | "target_delete" | "nameserver_connect" | "zone_delete";
  subjectType: "redirect_domain" | "target_service" | "domain";
  subjectId: string;
  redirectDomainId?: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  maxAttempts?: number;
}

enqueueJob(db, input): Promise<{ id: string; status: JobStatus }>;
claimNextJob(db, leaseSeconds?: number): Promise<DomainJob | null>;
completeJob(db, jobId, leaseToken): Promise<void>;
recordJobFailure(db, jobId, leaseToken, error): Promise<JobStatus>;
processNextJob(env): Promise<boolean>;
```

- Removes: `withOperationLock()` and every caller.

- [ ] **Step 1: Write failing queue tests**

Add Worker/D1 tests with these concrete assertions:

```ts
const claims = await Promise.all([claimNextJob(db), claimNextJob(db)]);
expect(claims.filter((claim) => claim !== null)).toHaveLength(1);

const first = await enqueueJob(db, input);
const duplicate = await enqueueJob(db, input);
expect(duplicate.id).toBe(first.id);

expect(permanentFailure.status).toBe("failed");
expect(retryableFailure.status).toBe("retry_wait");
const next = await claimNextJob(db);
expect(next?.id).toBe(newerQueuedJob.id);
```

Also prove a waiting Nameserver job becomes `retry_wait` and is claimable after `next_attempt_at`, not `completed`.

- [ ] **Step 2: Rebuild the existing job tables**

`migrations/0018_domain_jobs_queue.sql` must:

1. Rename `job_steps` to `job_steps_old`.
2. Rename `domain_jobs` to `domain_jobs_old`.
3. Create one new `domain_jobs` table with nullable `redirect_domain_id`, `subject_type`, `subject_id`, `payload`, `idempotency_key`, `attempt_count`, `max_attempts`, `next_attempt_at`, `lease_token`, and `lease_expires_at`.
4. Copy legacy jobs with `subject_type='redirect_domain'`, `subject_id=redirect_domain_id`, and `idempotency_key='legacy:' || id`.
5. Recreate and copy `job_steps`.
6. Drop both old tables.
7. Create:

```sql
CREATE UNIQUE INDEX idx_domain_jobs_idempotency ON domain_jobs(idempotency_key);
CREATE INDEX idx_domain_jobs_claim ON domain_jobs(status, next_attempt_at, created_at);
CREATE INDEX idx_domain_jobs_subject ON domain_jobs(subject_type, subject_id, created_at);
```

- [ ] **Step 3: Implement one atomic global claim**

Use the following single `UPDATE` statement with `RETURNING`. It may claim a job only when no unexpired running job exists:

```sql
UPDATE domain_jobs
SET status = 'running',
    lease_token = ?,
    lease_expires_at = ?,
    attempt_count = attempt_count + 1,
    updated_at = ?
WHERE id = (
  SELECT id
  FROM domain_jobs
  WHERE status IN ('queued', 'retry_wait')
    AND next_attempt_at <= ?
    AND NOT EXISTS (
      SELECT 1 FROM domain_jobs
      WHERE status = 'running' AND lease_expires_at > ?
    )
  ORDER BY created_at
  LIMIT 1
)
RETURNING *;
```

Return `null` immediately when another operation owns the lease. Never poll or sleep inside a Worker request.

- [ ] **Step 4: Add bounded retries**

Use:

```ts
const delaySeconds = Math.min(3600, 30 * 2 ** Math.max(0, attemptCount - 1));
```

Retry only timeouts, 429, and 5xx provider errors. Authentication, validation, not-owned, and malformed-input errors are terminal.

Nameserver propagation uses `retry_wait` every five minutes for at most 48 hours.

- [ ] **Step 5: Queue every mutation endpoint**

The following endpoints enqueue exactly one job and return HTTP 202:

```text
POST /api/domains
POST /api/domains/:id/retry
DELETE /api/domains
POST /api/targets
POST /api/targets/:id/repair
DELETE /api/targets/:id
POST /api/tools/nameservers
POST /api/tools/cloudflare-zones/delete
```

`ctx.waitUntil(processNextJob(env))` may attempt one immediate claim. Concurrent invocations cannot claim a second job while the first lease is active.

- [ ] **Step 6: Make target deletion atomic**

Inside the queued target-delete handler, replace the three independent D1 writes with one `db.batch()` containing:

```sql
UPDATE redirect_domains
SET deleted_target_host = COALESCE(deleted_target_host, ?),
    target_service_id = NULL,
    status = 'failed',
    last_error = '目标服务列表中服务被删除了',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE target_service_id = ?;
DELETE FROM short_links WHERE target_service_id = ?;
DELETE FROM target_services WHERE id = ?;
```

D1 must roll back the full batch when any statement fails.

- [ ] **Step 7: Enforce host-role exclusivity**

Before creating a target service, reject a host already present in `redirect_domains`.

Before creating a redirect domain, reject a host already present in `target_services`.

Return HTTP 409 with `域名不能同时作为入口域名和目标服务域名。`.

- [ ] **Step 8: Process one scheduled job**

`runScheduled()` calls `processNextJob(env)` once, then health and retention maintenance. It must not loop through more jobs in the same Cron invocation.

- [ ] **Step 9: Run queue and consistency tests**

```powershell
npm.cmd run test:worker -- tests/worker/domain-jobs-queue.test.ts tests/worker/target-delete.test.ts
npm.cmd run typecheck
```

- [ ] **Step 10: Commit**

```powershell
git add migrations/0018_domain_jobs_queue.sql src/worker/db.ts src/worker/automation.ts src/worker/api.ts src/worker/target-automation.ts src/worker/shared.ts src/app/src/main.tsx tests/worker/domain-jobs-queue.test.ts tests/worker/target-delete.test.ts
git commit -m "fix: serialize mutations with durable jobs"
```

---

### Task 5: Fix Polling, Redirect Latency, and Dead Frontend Code

**Files:**
- Modify: `src/worker/index.ts`
- Modify: `src/worker/target-service.ts`
- Modify: `src/worker/redirect.ts`
- Modify: `src/app/src/main.tsx`
- Create: `src/app/src/job-results.ts`
- Modify: `tests/redirect.test.ts`
- Create: `tests/target-service.test.ts`
- Create: `tests/app-job-results.test.ts`

**Interfaces:**
- Changes: `handleTargetService(request, env, ctx): Promise<Response | null>`.
- Keeps result persistence in `localStorage`.
- Polls stable job IDs once every three seconds.

- [ ] **Step 1: Write failing hot-path tests**

Add tests proving:

```ts
expect(await handleTargetService(request, env, ctx)).toHaveStatus(302);
expect(ctx.waitUntil).toHaveBeenCalled();
expect(shouldRecordPageView(new Request(url, { method: "HEAD" }))).toBe(false);
```

Add a frontend helper test proving one timer refreshes pending job IDs once and does not reschedule merely because result objects were recreated.

- [ ] **Step 2: Run focused tests and confirm failure**

```powershell
npm.cmd run test:node -- tests/redirect.test.ts tests/target-service.test.ts tests/app-job-results.test.ts
```

- [ ] **Step 3: Move short-link writes off the redirect path**

Pass `ctx` into `handleTargetService()` and replace:

```ts
await recordShortLinkVisit(env.DB, shortLink.id, await visitorKeyFromRequest(request, env, host));
```

with:

```ts
ctx.waitUntil(recordShortLinkVisit(env.DB, shortLink.id, await visitorKeyFromRequest(request, env, host)));
```

The redirect response must not depend on analytics success.

- [ ] **Step 4: Exclude HEAD from page-view recording**

Change the first guard in `shouldRecordPageView()` to:

```ts
if (request.method !== "GET") return false;
```

This fixes request classification only; it does not redefine visitor identity.

- [ ] **Step 5: Replace result-dependent polling**

Derive one stable sorted key:

```ts
const pendingIds = result
  ?.filter((item) => item.id && isProcessingStatus(item.status))
  .map((item) => item.id as string)
  .sort()
  .join(",") ?? "";
```

The effect depends on `pendingIds`, schedules one `setTimeout` after each completed refresh, and updates state only when status or error changed. Remove the current `setInterval` plus immediate self-trigger pattern.

- [ ] **Step 6: Submit batches without waiting for completion**

For every entered domain:

1. POST one domain.
2. Store its returned job ID.
3. Continue to the next domain immediately.
4. Let the shared polling loop update status.

Keep a 15-second timeout for each submission. A missing response becomes a visible failed result with a manual retry button.

- [ ] **Step 7: Delete unused components**

Delete the unused `AddView` and `TargetsView` functions. Keep `AddViewV2` and `TargetsViewV2`; rename those two active functions to `AddView` and `TargetsView`.

Do not split `main.tsx` in this task. Deletion removes the immediate maintenance cost without a structural refactor.

- [ ] **Step 8: Run tests and build**

```powershell
npm.cmd run test:node -- tests/redirect.test.ts tests/target-service.test.ts tests/app-job-results.test.ts
npm.cmd run typecheck
npm.cmd run build
```

- [ ] **Step 9: Commit**

```powershell
git add src/worker/index.ts src/worker/target-service.ts src/worker/redirect.ts src/app/src/main.tsx src/app/src/job-results.ts tests/redirect.test.ts tests/target-service.test.ts tests/app-job-results.test.ts
git commit -m "fix: bound polling and redirect latency"
```

---

### Task 6: Harden and Prove the Turnstile Transport

**Files:**
- Modify in the isolated Turnstile branch only: `src/worker/verification.ts`
- Modify in the isolated Turnstile branch only: `src/worker/verification-page.ts`
- Modify in the isolated Turnstile branch only: `src/worker/verification-crypto.ts`
- Modify in the isolated Turnstile branch only: `src/worker/index.ts`
- Create after the browser gate passes: `migrations/0019_verification_nonces.sql`
- Modify: `tests/verification-page.test.ts`
- Create: `tests/worker/verification-routes.test.ts`
- Modify: `docs/verification/iframe-poc-results.md`

**Interfaces:**
- Parent/complete routes operate only on configured entry hosts.
- Frame/siteverify routes operate only on configured relay hosts.
- A signed state binds `subjectId`, `parentOrigin`, `relayHost`, `targetUrl`, `nonce`, and `exp`.
- Failure always redirects within a fixed deadline and produces no verified result.

- [ ] **Step 1: Write failing host and binding tests**

Add tests proving:

```ts
expect(await probeOnAdminHost()).toHaveStatus(404);
expect(await frameOnEntryHost()).toHaveStatus(404);
expect(await completeWithWrongRelayHostname()).toHaveStatus(400);
expect(await completeWithWrongAction()).toHaveStatus(400);
expect(await completeWithExpiredState()).toHaveStatus(400);
```

Add a browser-page test proving navigation occurs after the hard deadline even when `/complete` never resolves.

- [ ] **Step 2: Remove the arbitrary target query parameter**

Delete `?target=` from the production flow. Look up the target from the current entry-domain configuration in D1. Preview routes may use a fixed `https://example.com/` target only in local development.

- [ ] **Step 3: Move verification routing behind Host classification**

Do not call `handleVerificationProbe()` before admin/target/entry Host classification.

Route:

```text
entry host:  parent, complete
relay host:  frame, siteverify
admin host:  no verification endpoint
other host:  no verification endpoint
```

- [ ] **Step 4: Bind Siteverify strictly**

Require:

```ts
result.success === true
&& result.action === expectedAction
&& result.hostname === expectedRelayHost
```

During the transport POC, validate the signed nonce and rely on Turnstile's single-use token without recording traffic. Do not add verification tables before the browser gate passes.

- [ ] **Step 5: Guarantee fail-open navigation**

Use one hard navigation deadline that is never cancelled by proof receipt. Bound `/complete` with `AbortSignal.timeout(1_500)` and redirect in `finally`.

No verification failure, timeout, blocked script, disabled JavaScript fallback, or D1 failure may stop the original redirect.

Render `<noscript><meta http-equiv="refresh" content="0;url=${escapedTargetUrl}"></noscript>` with the same HTML-attribute escaping used by the iframe URL.

- [ ] **Step 6: Run local tests**

```powershell
npm.cmd run test:node -- tests/verification-page.test.ts
npm.cmd run test:worker -- tests/worker/verification-routes.test.ts
npm.cmd run typecheck
```

- [ ] **Step 7: Run the real non-production browser gate**

Use a separate Worker, one entry hostname, one relay hostname, and a real Turnstile widget restricted to the relay hostname.

Record pass/fail for:

```text
Chrome
Edge
Firefox
Safari/iOS
mobile viewport
third-party-cookie blocking
strict tracking protection
Turnstile script blocked
complete endpoint timeout
final Referer behavior
```

No untested browser is recorded as passed.

- [ ] **Step 8: Choose the transport**

If every supported browser passes, commit the hidden-iframe transport.

If any supported browser cannot reliably obtain and return a token, delete the iframe POC and implement a full-page relay using the same signed state and fail-open deadline. Do not maintain both transports.

- [ ] **Step 9: Add one-time nonce consumption after the gate**

Create `migrations/0019_verification_nonces.sql`:

```sql
CREATE TABLE verification_nonces (
  nonce_hash TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);
CREATE INDEX idx_verification_nonces_expiry ON verification_nonces(expires_at);
```

Insert the HMAC-hashed nonce when rendering a production parent page. Siteverify completion must atomically set `consumed_at` only when it is NULL and `expires_at` is in the future. Reuse returns HTTP 400. Scheduled cleanup deletes expired rows.

- [ ] **Step 10: Commit only proven behavior**

```powershell
git add migrations/0019_verification_nonces.sql src/worker/verification.ts src/worker/verification-page.ts src/worker/verification-crypto.ts src/worker/index.ts tests/verification-page.test.ts tests/worker/verification-routes.test.ts docs/verification/iframe-poc-results.md
git commit -m "feat: prove Turnstile verification transport"
```

---

### Task 7: Verify, Stage, and Release

**Files:**
- Modify: `README.md`
- Create: `docs/releases/2026-07-production-hardening.md`
- Modify: `.dev.vars.example`
- Modify: deployment-only `.wrangler/deploy.jsonc` without committing it

**Interfaces:**
- Produces one release record containing migration, deployment, smoke-test, and rollback evidence.

- [ ] **Step 1: Document secret configuration**

Document:

```powershell
npx.cmd wrangler secret put ADMIN_PASSWORD_HASH
npx.cmd wrangler secret put SESSION_SECRET
npx.cmd wrangler secret put PASSWORD_PEPPER
npx.cmd wrangler secret put CLOUDFLARE_API_TOKEN
npx.cmd wrangler secret put DYNADOT_API_KEY
```

Never include real values in Git, logs, screenshots, or the release record.

- [ ] **Step 2: Run the complete local gate**

```powershell
npm.cmd test
npm.cmd run typecheck
npm.cmd run build
npm.cmd run wrangler:check
npm.cmd audit
```

Expected: tests, typecheck, build, and dry-run pass. Audit has no known high-severity production or deployment-tool vulnerability.

- [ ] **Step 3: Back up D1**

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\Link-Shortener-Backups"
npx.cmd wrangler d1 export multi-domain-redirect-manager --remote --output "$env:USERPROFILE\Link-Shortener-Backups\pre-hardening.sql" --config .wrangler/deploy.jsonc
```

- [ ] **Step 4: Apply migrations 0017 and 0018**

```powershell
npx.cmd wrangler d1 migrations apply multi-domain-redirect-manager --remote --config .wrangler/deploy.jsonc
```

Verify migration `0017` removed stored provider credentials and migration `0018` added the `domain_jobs` lease columns.

- [ ] **Step 5: Deploy with Turnstile disabled**

```powershell
npx.cmd wrangler deploy --config .wrangler/deploy.jsonc
```

Do not set the production Turnstile enable flag in this release.

- [ ] **Step 6: Run production smoke tests**

Verify one item at a time:

```text
login and logout
password change invalidates the old session
target-service creation and real health check
existing wrong DNS record is repaired
existing wrong Worker Route is repaired
Dynadot not-owned returns manual instructions
waiting Nameserver schedules another check
permanent failure does not block the next job
target deletion updates dependents atomically
three-domain frontend batch submits all three jobs
short-link redirect succeeds when analytics write fails
```

- [ ] **Step 7: Observe before Turnstile work**

Observe Worker errors, D1 writes, queue age, retry counts, provider 429s, target health failures, and redirect latency for at least 24 hours.

Turnstile work begins only when:

```text
no permanent job blocks later jobs
no waiting-Nameserver job is stranded
no configured DNS/Route state is a false positive
redirect errors and latency remain within the pre-release baseline
```

- [ ] **Step 8: Record rollback**

Rollback application code by deploying the previous saved Worker version. Migrations `0017` and `0018` preserve business records and legacy job history; do not attempt a destructive schema downgrade during an incident.

- [ ] **Step 9: Commit documentation**

```powershell
git add README.md .dev.vars.example docs/releases/2026-07-production-hardening.md
git commit -m "docs: record production hardening release"
```

---

## Completion Gate

- [ ] Provider credentials exist only in Worker Secrets.
- [ ] Password hashes are salted PBKDF2 and sessions use Web Crypto HMAC.
- [ ] Login throttling and password-change session invalidation are tested.
- [ ] Cloudflare DNS and Routes are reconciled by exact content and script.
- [ ] Target health always comes from a real request.
- [ ] Every mutation uses one durable leased queue.
- [ ] Waiting Nameserver jobs retry and permanent failures never starve the queue.
- [ ] Target deletion is atomic.
- [ ] Frontend batches submit sequentially without waiting for full provisioning.
- [ ] Polling uses one stable timer and short-link analytics never block redirects.
- [ ] Dead V1 components are removed.
- [ ] Turnstile remains disabled until the real browser gate passes.
- [ ] Full tests, typecheck, build, dry-run, backup, migration, deploy, and smoke tests are recorded.
