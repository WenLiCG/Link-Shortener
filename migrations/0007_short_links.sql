CREATE TABLE IF NOT EXISTS short_links (
  id TEXT PRIMARY KEY,
  target_service_id TEXT NOT NULL REFERENCES target_services(id) ON DELETE RESTRICT,
  code TEXT NOT NULL,
  original_url TEXT NOT NULL,
  visit_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_accessed_at TEXT,
  UNIQUE(target_service_id, code)
);

CREATE INDEX IF NOT EXISTS idx_short_links_target ON short_links(target_service_id);
CREATE INDEX IF NOT EXISTS idx_short_links_code ON short_links(code);
