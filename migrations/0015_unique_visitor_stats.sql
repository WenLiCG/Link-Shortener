ALTER TABLE visit_events ADD COLUMN visitor_key TEXT;
ALTER TABLE visit_events ADD COLUMN is_bot INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS visit_daily_uniques (
  redirect_domain_id TEXT NOT NULL REFERENCES redirect_domains(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  visitor_key TEXT NOT NULL,
  PRIMARY KEY (redirect_domain_id, day, visitor_key)
);

CREATE TABLE IF NOT EXISTS short_link_daily_uniques (
  short_link_id TEXT NOT NULL REFERENCES short_links(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  visitor_key TEXT NOT NULL,
  PRIMARY KEY (short_link_id, day, visitor_key)
);

CREATE INDEX IF NOT EXISTS idx_visit_daily_uniques_day ON visit_daily_uniques(day);
CREATE INDEX IF NOT EXISTS idx_short_link_daily_uniques_day ON short_link_daily_uniques(day);

INSERT OR IGNORE INTO visit_daily_uniques (redirect_domain_id, day, visitor_key)
SELECT
  redirect_domain_id,
  date(visited_at) AS day,
  COALESCE(
    visitor_key,
    lower(COALESCE(country, '')) || '|' ||
    lower(COALESCE(city, '')) || '|' ||
    lower(COALESCE(user_agent, '')) || '|' ||
    lower(COALESCE(referer, '')) || '|' ||
    lower(COALESCE(path, ''))
  ) AS visitor_key
FROM visit_events
WHERE is_bot = 0
AND lower(COALESCE(user_agent, '')) NOT GLOB '*bot*'
AND lower(COALESCE(user_agent, '')) NOT GLOB '*crawler*'
AND lower(COALESCE(user_agent, '')) NOT GLOB '*spider*'
AND lower(COALESCE(user_agent, '')) NOT GLOB '*preview*'
AND lower(COALESCE(user_agent, '')) NOT GLOB '*monitor*'
AND lower(path) NOT IN (
  '/favicon.ico',
  '/robots.txt',
  '/sitemap.xml',
  '/apple-touch-icon.png',
  '/apple-touch-icon-precomposed.png',
  '/browserconfig.xml',
  '/manifest.json',
  '/site.webmanifest'
)
AND lower(path) NOT GLOB '*.avif'
AND lower(path) NOT GLOB '*.css'
AND lower(path) NOT GLOB '*.gif'
AND lower(path) NOT GLOB '*.ico'
AND lower(path) NOT GLOB '*.jpg'
AND lower(path) NOT GLOB '*.jpeg'
AND lower(path) NOT GLOB '*.js'
AND lower(path) NOT GLOB '*.json'
AND lower(path) NOT GLOB '*.map'
AND lower(path) NOT GLOB '*.png'
AND lower(path) NOT GLOB '*.svg'
AND lower(path) NOT GLOB '*.webp'
AND lower(path) NOT GLOB '*.woff'
AND lower(path) NOT GLOB '*.woff2'
AND lower(path) NOT GLOB '*.xml'
AND lower(path) NOT GLOB '*.txt';

DELETE FROM visit_daily_stats;

INSERT INTO visit_daily_stats (redirect_domain_id, day, visits, unique_referers, last_accessed_at)
SELECT
  redirect_domain_id,
  date(visited_at) AS day,
  COUNT(DISTINCT COALESCE(
    visitor_key,
    lower(COALESCE(country, '')) || '|' ||
    lower(COALESCE(city, '')) || '|' ||
    lower(COALESCE(user_agent, '')) || '|' ||
    lower(COALESCE(referer, '')) || '|' ||
    lower(COALESCE(path, ''))
  )) AS visits,
  COUNT(DISTINCT COALESCE(NULLIF(referer, ''), 'direct')) AS unique_referers,
  MAX(visited_at) AS last_accessed_at
FROM visit_events
WHERE is_bot = 0
AND lower(COALESCE(user_agent, '')) NOT GLOB '*bot*'
AND lower(COALESCE(user_agent, '')) NOT GLOB '*crawler*'
AND lower(COALESCE(user_agent, '')) NOT GLOB '*spider*'
AND lower(COALESCE(user_agent, '')) NOT GLOB '*preview*'
AND lower(COALESCE(user_agent, '')) NOT GLOB '*monitor*'
AND lower(path) NOT IN (
  '/favicon.ico',
  '/robots.txt',
  '/sitemap.xml',
  '/apple-touch-icon.png',
  '/apple-touch-icon-precomposed.png',
  '/browserconfig.xml',
  '/manifest.json',
  '/site.webmanifest'
)
AND lower(path) NOT GLOB '*.avif'
AND lower(path) NOT GLOB '*.css'
AND lower(path) NOT GLOB '*.gif'
AND lower(path) NOT GLOB '*.ico'
AND lower(path) NOT GLOB '*.jpg'
AND lower(path) NOT GLOB '*.jpeg'
AND lower(path) NOT GLOB '*.js'
AND lower(path) NOT GLOB '*.json'
AND lower(path) NOT GLOB '*.map'
AND lower(path) NOT GLOB '*.png'
AND lower(path) NOT GLOB '*.svg'
AND lower(path) NOT GLOB '*.webp'
AND lower(path) NOT GLOB '*.woff'
AND lower(path) NOT GLOB '*.woff2'
AND lower(path) NOT GLOB '*.xml'
AND lower(path) NOT GLOB '*.txt'
GROUP BY redirect_domain_id, date(visited_at);
