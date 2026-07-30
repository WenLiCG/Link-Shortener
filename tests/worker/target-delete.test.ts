import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createTarget, deleteTarget } from "../../src/worker/db";

async function seed(): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO target_services (id, name, target_host) VALUES ('target-delete', 'delete', 'target.example.com')",
  ).run();
  await env.DB.prepare(
    `INSERT INTO redirect_domains
     (id, domain, target_service_id, redirect_mode, target_forward_host)
     VALUES ('domain-delete', 'entry.example.com', 'target-delete', 'target_service_forward', 'https://example.com/')`,
  ).run();
  await env.DB.prepare(
    "INSERT INTO short_links (id, target_service_id, code, original_url) VALUES ('short-delete', 'target-delete', 'abc', 'https://example.com/')",
  ).run();
}

beforeEach(async () => {
  await env.DB.prepare("DROP TRIGGER IF EXISTS fail_target_delete").run();
  await env.DB.prepare("DROP TRIGGER IF EXISTS fail_target_job").run();
  await env.DB.prepare("DELETE FROM short_links").run();
  await env.DB.prepare("DELETE FROM redirect_domains").run();
  await env.DB.prepare("DELETE FROM target_services").run();
  await seed();
});

describe("target deletion", () => {
  it("updates dependents and deletes the target in one batch", async () => {
    await expect(deleteTarget(env.DB, "target-delete", "target.example.com")).resolves.toMatchObject({
      deleted: true,
      domainsMarked: 1,
      shortLinksDeleted: 1,
    });
    expect(await env.DB.prepare("SELECT id FROM target_services WHERE id = 'target-delete'").first()).toBeNull();
    expect(await env.DB.prepare("SELECT id FROM short_links WHERE id = 'short-delete'").first()).toBeNull();
    await expect(env.DB.prepare("SELECT target_service_id, status, last_error FROM redirect_domains WHERE id = 'domain-delete'").first()).resolves.toMatchObject({
      target_service_id: null,
      status: "failed",
      last_error: "目标服务列表中服务被删除了",
    });
  });

  it("rolls back every dependent change when the target delete fails", async () => {
    await env.DB.prepare(
      "CREATE TRIGGER fail_target_delete BEFORE DELETE ON target_services BEGIN SELECT RAISE(ABORT, 'blocked'); END",
    ).run();

    await expect(deleteTarget(env.DB, "target-delete", "target.example.com")).rejects.toThrow();

    expect(await env.DB.prepare("SELECT id FROM target_services WHERE id = 'target-delete'").first("id")).toBe("target-delete");
    expect(await env.DB.prepare("SELECT id FROM short_links WHERE id = 'short-delete'").first("id")).toBe("short-delete");
    await expect(env.DB.prepare("SELECT target_service_id, status FROM redirect_domains WHERE id = 'domain-delete'").first()).resolves.toMatchObject({
      target_service_id: "target-delete",
      status: "validating",
    });
  });
});

describe("target creation", () => {
  it("rolls back the target when its initial repair job cannot be queued", async () => {
    await env.DB.prepare(
      `CREATE TRIGGER fail_target_job
       BEFORE INSERT ON domain_jobs
       WHEN NEW.type = 'target_repair'
       BEGIN SELECT RAISE(ABORT, 'blocked'); END`,
    ).run();

    await expect(createTarget(env.DB, {
      name: "atomic",
      targetHost: "atomic.example.com",
      forwardTargetHost: null,
      description: "",
    })).rejects.toThrow();

    expect(await env.DB.prepare(
      "SELECT id FROM target_services WHERE target_host = 'atomic.example.com'",
    ).first()).toBeNull();
    await env.DB.prepare("DROP TRIGGER fail_target_job").run();
  });
});
