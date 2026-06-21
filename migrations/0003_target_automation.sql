ALTER TABLE target_services ADD COLUMN automation_status TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE target_services ADD COLUMN nameserver_status TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE target_services ADD COLUMN dns_status TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE target_services ADD COLUMN cloudflare_zone_id TEXT;
ALTER TABLE target_services ADD COLUMN cloudflare_zone_status TEXT;
ALTER TABLE target_services ADD COLUMN cloudflare_nameservers TEXT;
ALTER TABLE target_services ADD COLUMN dynadot_status TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE target_services ADD COLUMN last_error TEXT;
ALTER TABLE target_services ADD COLUMN last_checked_at TEXT;

CREATE INDEX IF NOT EXISTS idx_target_services_automation_status ON target_services(automation_status);
