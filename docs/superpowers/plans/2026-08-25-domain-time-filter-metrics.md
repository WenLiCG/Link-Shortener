# Domain Time Filter Metrics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the domain-console time filter return only domains with visits in the requested interval and display each domain's UV for that same interval.

**Architecture:** Reuse the existing `traffic_daily_visitors` table through one filtered CTE. The CTE supplies both the domain-membership predicate and the per-domain `traffic` / `trafficLastAccessedAt` values, so a bounded range cannot be satisfied by two different visitor rows. The frontend labels the existing column according to whether a time filter is active.

**Tech Stack:** TypeScript, Cloudflare D1, React, Vitest.

**Spec:** User request of 2026-08-25, which explicitly supersedes the older creation-date goal in `docs/superpowers/plans/2026-08-07-domain-time-filter-presets.md`.

## Global Constraints

- Reuse D1 and existing `traffic_daily_visitors`; do not add a migration or dependency.
- Dates remain Shanghai calendar dates and ranges are inclusive.
- Preserve the existing `RedirectDomain.traffic` API field; its value reflects the selected time range when one is selected.
- Deploy only the `link-shortener-manager` Worker after fresh tests, build, and dry-run verification.

---

### Task 1: Lock the visitor-range contract with D1 tests

**Files:**
- Modify: `tests/worker/domain-list-filters.test.ts`

**Interfaces:**
- Consumes: `listDomains(db, filters)` from `src/worker/db.ts`.
- Produces: coverage that rejects a domain whose visits fall on opposite sides of a selected range and asserts interval-local traffic totals.

- [x] **Step 1: Write the failing test**

```ts
it("uses one visitor interval for membership and traffic totals", async () => {
  await insertDomain("spanning", "2026-01-01T00:00:00.000Z");
  await insertDomain("inside", "2026-01-01T00:00:00.000Z");
  await recordVisit("spanning", "2026-08-09");
  await recordVisit("spanning", "2026-08-12");
  await recordVisit("inside", "2026-08-09");
  await recordVisit("inside", "2026-08-10");
  await recordVisit("inside", "2026-08-11");
  await recordVisit("inside", "2026-08-12");

  const domains = await listDomains(env.DB, { visitedFrom: "2026-08-10", visitedTo: "2026-08-11" });

  expect(domains.map((domain) => domain.id)).toEqual(["inside"]);
  expect(domains[0]?.traffic).toBe(2);
  expect(domains[0]?.lastAccessedAt).toBe("2026-08-11T00:00:00.000Z");
});
```

- [x] **Step 2: Run the focused Worker test and verify it fails**

Run: `npm.cmd run test:worker -- tests/worker/domain-list-filters.test.ts`

Expected: the current two-`EXISTS` query includes `spanning`, and `inside.traffic` reports four lifetime visits instead of two interval visits.

- [x] **Step 3: Implement the minimum shared visitor predicate**

```ts
const visitorWhere = ["v.subject_type = 'redirect_domain'", ...dateConditions].join(" AND ");
const visitorCte = `WITH filtered_visits AS (SELECT subject_id, visitor_key, first_seen_at FROM traffic_daily_visitors v WHERE ${visitorWhere})`;
```

Use `filtered_visits` in the list `EXISTS`, `COUNT(*)`, and `MAX(first_seen_at)` expressions; bind the visitor-date values before normal list-filter values because the CTE occurs first in SQL.

- [x] **Step 4: Run the focused Worker test and verify it passes**

Run: `npm.cmd run test:worker -- tests/worker/domain-list-filters.test.ts`

Expected: PASS, including the new interval membership and metric assertions.

### Task 2: Make the console communicate the statistic scope

**Files:**
- Modify: `src/app/src/main.tsx`

**Interfaces:**
- Consumes: the existing `filters` state and `RedirectDomain.traffic` values returned by `/api/domains`.
- Produces: a table header of `区间候选 UV` when any time control is active, otherwise `累计候选 UV`.

- [x] **Step 1: Implement the minimal derived label**

```ts
const hasTimeFilter = Boolean(filters.days || filters.visitedFrom || filters.visitedTo);
```

Pass the derived boolean to the existing domain-list rendering path and use it only for the traffic-column header. Do not alter global summary metrics, which are explicitly labelled as today-wide metrics.

- [x] **Step 2: Run the Node UI checks and build**

Run: `npm.cmd run test:node -- tests/domain-time-filter-options.test.ts; npm.cmd run build`

Expected: both commands exit 0.

### Task 3: Verify, commit, and deploy the isolated branch

**Files:**
- Modify: the files from Tasks 1-2 only.

- [x] **Step 1: Run full verification**

Run: `npm.cmd test; npm.cmd run typecheck; npm.cmd run build; npm.cmd run deploy:dry-run; git diff --check`

Expected: 0 failures, successful build/dry-run, and no whitespace errors.

- [x] **Step 2: Commit the fix**

```bash
git add src/worker/db.ts src/app/src/main.tsx tests/worker/domain-list-filters.test.ts docs/superpowers/plans/2026-08-25-domain-time-filter-metrics.md
git commit -m "fix: scope domain traffic to selected time"
```

- [ ] **Step 3: Deploy and verify production**

Run: `npm.cmd run deploy; npx.cmd wrangler deployments list --name link-shortener-manager --json`

Expected: a new version receives 100% traffic. Fetch the live HTML with cache bypass and confirm a new bundle contains `区间候选 UV` and `visitedFrom`.
