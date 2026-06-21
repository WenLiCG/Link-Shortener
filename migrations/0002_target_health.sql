ALTER TABLE target_services ADD COLUMN health_status TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE target_services ADD COLUMN health_http_status INTEGER;
ALTER TABLE target_services ADD COLUMN health_error TEXT;
ALTER TABLE target_services ADD COLUMN health_checked_at TEXT;

CREATE INDEX IF NOT EXISTS idx_target_services_health_checked ON target_services(health_checked_at);
