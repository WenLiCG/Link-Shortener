# 域名时间筛选预设 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 域名控制台可按今天、昨天和含今天在内的最近 7 个自然日筛选创建时间。

**Architecture:** 保持前端的 `days` 查询参数和 `/api/domains` 接口不变。`listDomains` 将数值预设转换为精确的中国标准时间日期条件；前端只提供正确的预设值和文案。

**Tech Stack:** React 19、TypeScript、Cloudflare Workers D1、Vitest。

## Global Constraints

- 不增加依赖或接口。
- 时间按中国标准时间计算。
- `0` 为今天，`-1` 为昨天；正整数 `N` 表示含今天的最近 `N` 个自然日。

---

### Task 1: 服务器端日期范围

**Files:**
- Modify: `src/worker/db.ts:502-533`
- Create: `tests/worker/domain-list-filters.test.ts`

**Interfaces:**
- Consumes: `listDomains(db, { days?: number })` 和 `daysAgo(days)`。
- Produces: `listDomains` 对 `0`、`-1` 与正整数 `N` 的创建日期筛选。

- [x] **Step 1: Write the failing test**

```ts
it("filters domains by today, yesterday, and seven calendar days", async () => {
  await insertDomain("today", today());
  await insertDomain("yesterday", daysAgo(1));
  await insertDomain("week", daysAgo(6));
  await insertDomain("old", daysAgo(7));
  await insertDomain("thirtyDays", daysAgo(29));
  await insertDomain("thirtyOneDays", daysAgo(30));

  await expectDomains({ days: 0 }, ["today"]);
  await expectDomains({ days: -1 }, ["yesterday"]);
  await expectDomains({ days: 7 }, ["today", "yesterday", "week"]);
  await expectDomains({ days: 30 }, ["today", "yesterday", "week", "old", "thirtyDays"]);
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm.cmd run test:worker -- tests/worker/domain-list-filters.test.ts`

Expected: FAIL because `days: 0` does not filter and `days: -1`/`7` do not form the specified ranges.

- [x] **Step 3: Write minimal implementation**

```ts
if (filters.days !== undefined) {
  if (filters.days === 0 || filters.days === -1) {
    clauses.push("date(d.created_at) = date(?)");
    binds.push(daysAgo(-filters.days));
  } else if (filters.days > 0) {
    clauses.push("date(d.created_at) >= date(?)");
    binds.push(daysAgo(filters.days - 1));
  }
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npm.cmd run test:worker -- tests/worker/domain-list-filters.test.ts`

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/worker/db.ts tests/worker/domain-list-filters.test.ts
git commit -m "feat: support precise domain date presets"
```

### Task 2: 域名控制台预设

**Files:**
- Modify: `src/app/src/main.tsx:1107-1114`
- Create: `tests/domain-time-filter-options.test.ts`

**Interfaces:**
- Consumes: `filters.days` 字符串值会作为 `/api/domains?days=` 发送。
- Produces: 今天为 `0`、昨天为 `-1`、过去 7 天为 `7` 的下拉选项。

- [x] **Step 1: Write the failing test**

```ts
const source = readFileSync("src/app/src/main.tsx", "utf8");
expect(source).toContain('<option value="0">今天</option>');
expect(source).toContain('<option value="-1">昨天</option>');
expect(source).toContain('<option value="7">过去 7 天</option>');
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm.cmd run test:node -- tests/domain-time-filter-options.test.ts`

Expected: FAIL because the new option values do not yet exist.

- [x] **Step 3: Write minimal implementation**

```tsx
<option value="0">今天</option>
<option value="-1">昨天</option>
<option value="7">过去 7 天</option>
<option value="30">过去一个月</option>
```

The server-side positive-day cutoff is complete in Task 1; no API changes are needed.

- [x] **Step 4: Run test to verify it passes**

Run: `npm.cmd run test:node -- tests/domain-time-filter-options.test.ts`

Expected: PASS.

- [x] **Step 5: Verify the application**

Run: `npm.cmd test && npm.cmd run typecheck && npm.cmd run build`

Expected: all commands exit successfully.

- [x] **Step 6: Commit**

```bash
git add src/app/src/main.tsx src/worker/db.ts tests/worker/domain-list-filters.test.ts tests/domain-time-filter-options.test.ts
git commit -m "feat: add domain time filter presets"
```
