# Daily Anonymous Visitor Counting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Count each eligible client IP once per entry domain or short link per Shanghai day without storing raw IPs or maintaining per-request aggregates.

**Architecture:** The redirect path derives an HMAC visitor key solely from trusted Cloudflare IP headers and the subject/day scope. `traffic_daily_visitors` is the source of truth: one `INSERT OR IGNORE` records the first eligible visit, while dashboard totals and trends query that table directly. Existing event and aggregate tables remain untouched for historical compatibility but receive no new traffic writes.

**Tech Stack:** Cloudflare Workers, Web Crypto, D1/SQLite, TypeScript, Vitest.

## Global Constraints

- No new dependencies, Analytics Engine binding, browser beacon, or Turnstile flow.
- Trust only Cloudflare IP headers; never persist raw IP addresses.
- Use Asia/Shanghai calendar days.
- Statistics failures must remain asynchronous and must not change redirect responses.

---

### Task 1: Define and prove the anonymous visitor key and eligibility boundary

**Files:**
- Modify: `tests/redirect.test.ts`
- Modify: `src/worker/redirect.ts`
- Modify: `src/worker/secret-env.d.ts`
- Modify: `.dev.vars.example`

**Interfaces:**
- Produces `visitorKeyFromRequest(request, env, subject): Promise<string | null>`.
- Produces `shouldRecordPageView(request): boolean` that accepts only eligible `GET` navigations.

- [x] **Step 1: Write failing tests**

```ts
expect(shouldRecordPageView(request("/", { accept: "text/html" }, "HEAD"))).toBe(false)
expect(await visitorKeyFromRequest(ipv6Request, env, "domain-a.example")).not.toBe(
  await visitorKeyFromRequest(ipv6Request, env, "domain-b.example"),
)
expect(await visitorKeyFromRequest(ipv6Request, env, "domain-a.example")).not.toContain("2001:db8")
```

- [x] **Step 2: Run the node test and verify RED**

Run: `npm run test:node -- tests/redirect.test.ts`

Expected: the `HEAD` assertion fails and the scoped-key assertion fails under the old SHA-256 implementation.

- [x] **Step 3: Write minimal implementation**

```ts
const ip = request.headers.get("cf-connecting-ipv6") ?? request.headers.get("cf-connecting-ip")
return hmacSha256(env.VISITOR_HASH_SECRET ?? env.SESSION_SECRET, `${subject}|${today()}|${ip}`)
```

Return `null` when no trusted Cloudflare header or no secret exists; callers skip statistics. Restrict page-view eligibility to `GET`.

- [x] **Step 4: Run the node test and verify GREEN**

Run: `npm run test:node -- tests/redirect.test.ts`

Expected: PASS.

### Task 2: Make daily visitor facts the only live traffic write and read source

**Files:**
- Create: `migrations/0020_compact_daily_visitors.sql`
- Modify: `tests/worker/redirect-routing.test.ts`
- Modify: `src/worker/db.ts`
- Modify: `src/worker/redirect.ts`
- Modify: `src/worker/target-service.ts`

**Interfaces:**
- `recordVisit` and `recordShortLinkVisit` insert at most one new row into `traffic_daily_visitors` for an eligible visitor.
- Dashboard list, detail trend, short-link count, and summary read exact UVs from `traffic_daily_visitors`.

- [x] **Step 1: Write failing integration tests**

```ts
await eventually("SELECT COUNT(*) AS total FROM traffic_daily_visitors WHERE subject_id = 'domain-visit'", 1)
expect(Number(await env.DB.prepare("SELECT COUNT(*) AS total FROM traffic_daily_stats WHERE subject_id = 'domain-visit'").first("total"))).toBe(0)
expect(Number(await env.DB.prepare("SELECT COUNT(*) AS total FROM visit_events WHERE redirect_domain_id = 'domain-visit'").first("total"))).toBe(0)
```

Also fetch the short-link list after a redirect and assert its displayed `visitCount` comes from the visitor fact table.

- [x] **Step 2: Run the worker test and verify RED**

Run: `npm run test:worker -- tests/worker/redirect-routing.test.ts`

Expected: assertions for the legacy tables fail.

- [x] **Step 3: Write minimal implementation**

```sql
CREATE TABLE traffic_daily_visitors_new (..., PRIMARY KEY(subject_type, subject_id, day, visitor_key)) WITHOUT ROWID;
INSERT INTO traffic_daily_visitors_new SELECT ... FROM traffic_daily_visitors;
DROP TABLE traffic_daily_visitors;
ALTER TABLE traffic_daily_visitors_new RENAME TO traffic_daily_visitors;
```

Remove all per-request inserts and updates outside `traffic_daily_visitors`. Replace every live `traffic_daily_stats.filtered_uv` read with a count or daily grouping of the fact table. Derive displayed short-link counts and last-access times with correlated fact-table subqueries.

- [x] **Step 4: Run the worker test and verify GREEN**

Run: `npm run test:worker -- tests/worker/redirect-routing.test.ts`

Expected: PASS.

- [x] **Step 5: Run the full verification suite**

Run: `npm test && npm run typecheck && npm run build`

Expected: all commands exit 0.
