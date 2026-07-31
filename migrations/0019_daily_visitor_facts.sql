ALTER TABLE redirect_domains ADD COLUMN verification_policy TEXT NOT NULL DEFAULT 'inherit';
ALTER TABLE short_links ADD COLUMN verification_policy TEXT NOT NULL DEFAULT 'inherit';

CREATE TABLE traffic_daily_visitors (
  subject_type TEXT NOT NULL CHECK(subject_type IN ('redirect_domain', 'short_link')),
  subject_id TEXT NOT NULL,
  day TEXT NOT NULL,
  visitor_key TEXT NOT NULL,
  classification TEXT NOT NULL DEFAULT 'server_filtered' CHECK(classification IN ('server_filtered', 'turnstile_verified')),
  first_seen_at TEXT NOT NULL,
  verified_at TEXT,
  referer_host TEXT,
  country TEXT,
  region TEXT,
  city TEXT,
  latitude REAL,
  longitude REAL,
  timezone TEXT,
  language TEXT,
  operating_system TEXT,
  browser TEXT,
  device_type TEXT,
  PRIMARY KEY(subject_type, subject_id, day, visitor_key)
);

CREATE TABLE traffic_daily_stats (
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  day TEXT NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  filtered_uv INTEGER NOT NULL DEFAULT 0,
  verified_uv INTEGER NOT NULL DEFAULT 0,
  rejected_request_count INTEGER NOT NULL DEFAULT 0,
  verification_attempts INTEGER NOT NULL DEFAULT 0,
  verification_passed INTEGER NOT NULL DEFAULT 0,
  verification_failed INTEGER NOT NULL DEFAULT 0,
  verification_timed_out INTEGER NOT NULL DEFAULT 0,
  last_accessed_at TEXT,
  PRIMARY KEY(subject_type, subject_id, day)
);

CREATE INDEX idx_traffic_visitors_subject_day ON traffic_daily_visitors(subject_type, subject_id, day);
CREATE INDEX idx_traffic_visitors_day_class ON traffic_daily_visitors(day, classification);
CREATE INDEX idx_traffic_stats_day ON traffic_daily_stats(day);

INSERT OR IGNORE INTO traffic_daily_visitors
  (subject_type, subject_id, day, visitor_key, first_seen_at, referer_host, country, region, city, latitude, longitude, timezone, language, operating_system, browser, device_type)
SELECT
  'redirect_domain', redirect_domain_id, date(visited_at), visitor_key, MIN(visited_at),
  NULL, MAX(country), MAX(region), MAX(city), MAX(latitude), MAX(longitude), MAX(timezone), MAX(language), MAX(operating_system), MAX(browser), MAX(device_type)
FROM visit_events
WHERE COALESCE(is_bot, 0) = 0 AND visitor_key IS NOT NULL
GROUP BY redirect_domain_id, date(visited_at), visitor_key;

INSERT OR IGNORE INTO traffic_daily_stats (subject_type, subject_id, day, request_count, filtered_uv, last_accessed_at)
SELECT 'redirect_domain', redirect_domain_id, day, visits, visits, last_accessed_at
FROM visit_daily_stats;
