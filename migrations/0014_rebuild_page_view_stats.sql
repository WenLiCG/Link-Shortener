DELETE FROM visit_daily_stats;

INSERT INTO visit_daily_stats (redirect_domain_id, day, visits, unique_referers, last_accessed_at)
SELECT
  redirect_domain_id,
  date(visited_at) AS day,
  COUNT(*) AS visits,
  COUNT(DISTINCT COALESCE(NULLIF(referer, ''), 'direct')) AS unique_referers,
  MAX(visited_at) AS last_accessed_at
FROM visit_events
WHERE lower(path) NOT IN (
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
