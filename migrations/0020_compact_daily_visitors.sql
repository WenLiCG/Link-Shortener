CREATE TABLE traffic_daily_visitors_new (
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
) WITHOUT ROWID;

INSERT OR IGNORE INTO traffic_daily_visitors_new
SELECT * FROM traffic_daily_visitors;

DROP TABLE traffic_daily_visitors;
ALTER TABLE traffic_daily_visitors_new RENAME TO traffic_daily_visitors;
