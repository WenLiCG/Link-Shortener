PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS target_services (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  target_host TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS redirect_domains (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL UNIQUE,
  target_service_id TEXT NOT NULL REFERENCES target_services(id) ON DELETE RESTRICT,
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

CREATE INDEX IF NOT EXISTS idx_redirect_domains_status ON redirect_domains(status);
CREATE INDEX IF NOT EXISTS idx_redirect_domains_group ON redirect_domains(group_id);
CREATE INDEX IF NOT EXISTS idx_redirect_domains_target ON redirect_domains(target_service_id);

CREATE TABLE IF NOT EXISTS domain_jobs (
  id TEXT PRIMARY KEY,
  redirect_domain_id TEXT NOT NULL REFERENCES redirect_domains(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  current_step TEXT NOT NULL DEFAULT 'validating',
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_domain_jobs_status ON domain_jobs(status);
CREATE INDEX IF NOT EXISTS idx_domain_jobs_domain ON domain_jobs(redirect_domain_id);

CREATE TABLE IF NOT EXISTS job_steps (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES domain_jobs(id) ON DELETE CASCADE,
  step TEXT NOT NULL,
  status TEXT NOT NULL,
  message TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_job_steps_job ON job_steps(job_id);

CREATE TABLE IF NOT EXISTS visit_events (
  id TEXT PRIMARY KEY,
  redirect_domain_id TEXT NOT NULL REFERENCES redirect_domains(id) ON DELETE CASCADE,
  host TEXT NOT NULL,
  path TEXT NOT NULL,
  referer TEXT,
  country TEXT,
  user_agent TEXT,
  target_host TEXT NOT NULL,
  hide_referer INTEGER NOT NULL DEFAULT 0,
  visited_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_visit_events_domain_time ON visit_events(redirect_domain_id, visited_at);
CREATE INDEX IF NOT EXISTS idx_visit_events_referer ON visit_events(referer);

CREATE TABLE IF NOT EXISTS visit_daily_stats (
  redirect_domain_id TEXT NOT NULL REFERENCES redirect_domains(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  visits INTEGER NOT NULL DEFAULT 0,
  unique_referers INTEGER NOT NULL DEFAULT 0,
  last_accessed_at TEXT,
  PRIMARY KEY (redirect_domain_id, day)
);

CREATE INDEX IF NOT EXISTS idx_visit_daily_stats_day ON visit_daily_stats(day);
