# Multi-Domain Redirect Manager

A Cloudflare-native redirect management app for operating many entry domains from one Worker. It includes a React/Vite admin console, a TypeScript Worker, D1 persistence, Cloudflare Zone/DNS/Worker Route automation, Dynadot nameserver automation, short links, traffic statistics, and optional no-referrer redirect pages.

## Features

- Single-admin login with an HttpOnly session cookie.
- Entry domain management with direct URL redirects and target-service two-step redirects.
- Target service domain management and health checks.
- Cloudflare Zone creation/reuse, nameserver discovery, proxied DNS records, and Worker Routes.
- Dynadot `domain_info` ownership checks and `set_ns` nameserver updates.
- Cloudflare NS intake tool for domains from any registrar.
- Cloudflare Zone deletion helper.
- Short link generation on configured target service domains.
- Traffic uses one privacy-safe IP hash per domain or short link per Shanghai calendar day; duplicate page requests add request volume but not UV.
- Frontend-driven one-at-a-time batch processing to avoid Cloudflare Worker subrequest limits.

## Security Notice

Do not commit secrets. Keep provider credentials only in Cloudflare Worker Secrets or local `.dev.vars`:

- `ADMIN_PASSWORD_HASH`
- `SESSION_SECRET`
- `PASSWORD_PEPPER`
- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`
- `DYNADOT_API_KEY`

This repository includes `.dev.vars.example` only. The real `.dev.vars` file is ignored by Git.

## Requirements

- Node.js 20+
- npm
- Cloudflare account
- Wrangler login: `npx wrangler login`
- Optional: Dynadot API key if you want automatic nameserver updates

## Install

```bash
npm install
```

## Configure Cloudflare

1. Create a D1 database:

```bash
npx wrangler d1 create multi-domain-redirect-manager
```

2. Copy the returned `database_id` into `wrangler.jsonc`.

3. Update `wrangler.jsonc`:

- `name`: your Worker script name
- `d1_databases[0].database_name`: your D1 database name
- `d1_databases[0].database_id`: your D1 database id
- `vars.ADMIN_HOST`: your admin host, for example `admin.example.com`
- `vars.WORKER_SCRIPT_NAME`: the Worker script name used for Worker Routes
- optional `routes`: uncomment and replace `admin.example.com` when deploying the admin console on a custom domain

You can also leave `routes` commented and use the `*.workers.dev` URL for the admin console.

## Local Development

Create local secrets:

```bash
cp .dev.vars.example .dev.vars
```

Generate an admin password hash:

```bash
node -e "crypto.subtle.digest('SHA-256', new TextEncoder().encode('your-password')).then(b=>console.log([...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('')))"
```

This SHA-256 value is accepted only as a one-time bootstrap format when `PASSWORD_PEPPER` is configured. The first successful login replaces it in D1 with a salted PBKDF2 hash.

Fill `.dev.vars` with your local values, then run:

```bash
npm run wrangler:types
npm run typecheck
npm test
npm run build
```

Run Worker locally:

```bash
npm run worker:dev
```

Run the Vite admin UI:

```bash
npm run dev
```

## Production Secrets

Set production secrets with Wrangler:

```bash
npx wrangler secret put ADMIN_PASSWORD_HASH
npx wrangler secret put SESSION_SECRET
npx wrangler secret put PASSWORD_PEPPER
npx wrangler secret put CLOUDFLARE_ACCOUNT_ID
npx wrangler secret put CLOUDFLARE_API_TOKEN
npx wrangler secret put DYNADOT_API_KEY
```

`DYNADOT_API_KEY` is optional if you only want manual nameserver instructions. Provider credentials cannot be edited in the admin UI and are never stored in D1.

## D1 Migrations

Apply migrations locally:

```bash
npx wrangler d1 migrations apply multi-domain-redirect-manager --local
```

For an existing deployment, first create the ignored deployment-only `.wrangler/deploy.jsonc` with the real D1 database ID, `ADMIN_HOST`, and custom-domain route. Configure all production secrets above, back up D1, deploy the updated Worker, then apply remote migrations:

```bash
npx wrangler d1 migrations apply multi-domain-redirect-manager --remote
```

Migration `0017` removes legacy provider credentials from D1, so applying it before the Worker reads Wrangler Secrets can interrupt automation. Migration `0019` adds the daily visitor facts table; it is additive and does not retain raw IP addresses.

## Cloudflare API Token Permissions

Use a least-privilege token. The app needs permissions for:

- Zone read/create/list
- DNS record read/edit
- Worker Routes read/edit
- Account read for the target account

Exact permission names can change in Cloudflare's dashboard. Review the token before use and avoid broad account-wide permissions where possible.

## Deploy

Build and validate:

```bash
npm run build
npm run deploy:dry-run
```

Deploy:

```bash
npm run deploy
```

Turnstile verification is intentionally disabled in this release. Do not enable it until a separate non-production cross-origin browser validation has passed.

After deployment:

1. Open your admin host or `*.workers.dev` URL.
2. Log in with the admin password that matches `ADMIN_PASSWORD_HASH`.
3. Go to the initialization check page and confirm all required configuration is present.
4. Add target service domains.
5. Add entry domains or use the Cloudflare NS intake tool.

## Redirect Behavior

- Entry-domain request path/query is not preserved.
- Direct redirects can point to any HTTP/HTTPS URL, including path/query.
- Target-service two-step redirects can also end at any HTTP/HTTPS URL.
- Optional no-referrer mode returns an HTML intermediate page with `Referrer-Policy: no-referrer`. This reduces referer leakage but does not guarantee complete anonymity.

## Batch Operation Model

Cloudflare Workers have subrequest limits per Worker invocation. To reduce failures, the frontend sends batch operations one item at a time:

- Add entry domains one at a time.
- Cloudflare NS intake one domain at a time.
- Cloudflare Zone deletion one domain at a time.
- Multi-select deletion one id at a time.

Failed or timed-out items stay visible in the result panel with a manual retry button.

## Public Repository Checklist

Before publishing:

```bash
rg -n --hidden --glob '!node_modules/**' --glob '!dist/**' --glob '!.wrangler/**' --glob '!.git/**' "cfut_|CLOUDFLARE_API_TOKEN|DYNADOT_API_KEY|ADMIN_PASSWORD_HASH|SESSION_SECRET|PASSWORD_PEPPER|your-real-domain|your-real-database-id" .
```

Confirm that `.dev.vars`, logs, `dist`, `.wrangler`, and `node_modules` are not staged.
