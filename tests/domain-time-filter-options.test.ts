// @ts-expect-error This Node-only test is also included by the Worker typecheck project.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("offers the domain time filter presets", () => {
  const source = readFileSync("src/app/src/main.tsx", "utf8");

  expect(source).toContain('<option value="0">今天</option>');
  expect(source).toContain('<option value="-1">昨天</option>');
  expect(source).toContain('<option value="7">过去 7 天</option>');
});

it("shows visitor hash readiness in the initialization checks", () => {
  const source = readFileSync("src/app/src/main.tsx", "utf8");

  expect(source).toContain('settings.hasVisitorHashSecret');
  expect(source).toContain('VISITOR_HASH_SECRET');
});
