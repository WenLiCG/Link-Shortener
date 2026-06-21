ALTER TABLE target_services ADD COLUMN forward_target_host TEXT;

PRAGMA foreign_keys = OFF;

CREATE TABLE redirect_domains_new (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL UNIQUE,
  target_service_id TEXT REFERENCES target_services(id) ON DELETE RESTRICT,
  redirect_mode TEXT NOT NULL DEFAULT 'target_service',
  direct_target_host TEXT,
  group_id TEXT REFERENCES groups(id) ON DELETE SET NULL,
  hide_referer INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'validating',
  nameserver_status TEXT NOT NULL DEFAULT 'pending',
  dns_status TEXT NOT NULL DEFAULT 'pending',
  route_status TEXT NOT NULL DEFAULT 'pending',
  cloudflare_zone_id TEXT,
  cloudflare_zone_status TEXT,
  cloudflare_nameservers TEXT,
  dynadot_status TEXT NOT NULL DEFAULT 'pending',
  last_error TEXT,
  last_checked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_accessed_at TEXT
);

INSERT INTO redirect_domains_new (
  id, domain, target_service_id, redirect_mode, direct_target_host, group_id, hide_referer,
  status, nameserver_status, dns_status, route_status, cloudflare_zone_id,
  cloudflare_zone_status, cloudflare_nameservers, dynadot_status, last_error,
  last_checked_at, created_at, updated_at, last_accessed_at
)
SELECT
  id, domain, target_service_id, 'target_service', NULL, group_id, hide_referer,
  status, nameserver_status, dns_status, route_status, cloudflare_zone_id,
  cloudflare_zone_status, cloudflare_nameservers, dynadot_status, last_error,
  last_checked_at, created_at, updated_at, last_accessed_at
FROM redirect_domains;

DROP TABLE redirect_domains;
ALTER TABLE redirect_domains_new RENAME TO redirect_domains;

PRAGMA foreign_keys = ON;

CREATE INDEX IF NOT EXISTS idx_redirect_domains_status ON redirect_domains(status);
CREATE INDEX IF NOT EXISTS idx_redirect_domains_group ON redirect_domains(group_id);
CREATE INDEX IF NOT EXISTS idx_redirect_domains_target ON redirect_domains(target_service_id);
CREATE INDEX IF NOT EXISTS idx_redirect_domains_mode ON redirect_domains(redirect_mode);
