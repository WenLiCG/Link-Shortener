# 2026-07 Production Hardening Release

## Included

- Administrator passwords use salted PBKDF2 and sessions use Web Crypto HMAC.
- Provider mutations run through one leased D1 queue.
- Cloudflare DNS and Worker Routes are reconciled against the intended state.
- Frontend batch actions submit one request at a time and expose retryable job failures.
- Redirect analytics run in `waitUntil`; they cannot delay a redirect.
- Daily UV is one privacy-safe IP hash per entry domain or short link per Shanghai calendar day. Repeated navigations remain request volume, not additional visitors.

## Required deployment configuration

Keep `.wrangler/deploy.jsonc` local and ignored. It must contain the real D1 database ID, the Worker script name, `ADMIN_HOST`, and the custom admin route for `link.g60.net`. Set all secrets with `wrangler secret put`; never place their values in this file, Git, screenshots, or release notes.

Before a remote migration, export D1 to a local backup outside the repository. Then run the migration and deployment commands from `README.md`, and smoke-test login, one redirect, one target repair, and one queued domain operation.

## Turnstile status

Turnstile remains disabled. A real non-production browser gate must validate the entry-host/relay-host transport, strict Siteverify hostname and action binding, third-party-cookie blocking, script blocking, timeout fail-open behavior, and Referer behavior before it can record verified visitors.

## Deployment record

- Date: 2026-07-31
- D1 backup: completed before migration, outside the repository.
- Applied migrations: `0017_remove_stored_credentials.sql`, `0018_domain_jobs_queue.sql`, `0019_daily_visitor_facts.sql`.
- Worker version: `21cc389d-43f8-4f5d-b7bc-5efb3f38a899`.
- Smoke checks: `https://link.g60.net/` returned 200; unauthenticated `GET /api/me` returned `{ authenticated: false }`.

## Rollback

Roll back by deploying the prior Worker version. The migrations are additive; do not attempt a destructive D1 schema downgrade during an incident.
