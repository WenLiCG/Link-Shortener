/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { afterAll, afterEach, beforeAll, expect } from "vitest";

declare module "cloudflare:workers" {
  interface ProvidedEnv extends Env {
    TEST_MIGRATIONS: D1Migration[];
    PASSWORD_PEPPER: string;
  }
}

const testEnv = env as Env & { TEST_MIGRATIONS: D1Migration[] };

let unexpectedOutboundRequests = 0;
// Spies restore to this guard, so restoreAllMocks cannot re-enable real fetch.
globalThis.fetch = async () => {
  unexpectedOutboundRequests += 1;
  throw new Error("Mock outbound fetch explicitly in Worker tests.");
};

function assertNoUnexpectedRequests() {
  const count = unexpectedOutboundRequests;
  unexpectedOutboundRequests = 0;
  expect(count, "Unexpected outbound fetch occurred, even if application code caught its error.").toBe(0);
}

afterEach(assertNoUnexpectedRequests);
afterAll(assertNoUnexpectedRequests);

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});
