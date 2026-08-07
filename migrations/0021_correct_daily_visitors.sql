DELETE FROM traffic_daily_visitors AS visitor
WHERE visitor.subject_type = 'redirect_domain'
  AND EXISTS (
    SELECT 1
    FROM visit_events AS event
    WHERE event.redirect_domain_id = visitor.subject_id
      AND date(event.visited_at) = visitor.day
      AND event.visitor_key = visitor.visitor_key
      AND COALESCE(event.is_bot, 0) = 0
      AND event.visitor_key IS NOT NULL
  );

INSERT OR IGNORE INTO traffic_daily_visitors
  (subject_type, subject_id, day, visitor_key, first_seen_at, referer_host, country, region, city, latitude, longitude, timezone, language, operating_system, browser, device_type)
SELECT
  'redirect_domain', redirect_domain_id, date(visited_at, '+8 hours'), visitor_key, MIN(visited_at),
  NULL, MAX(country), MAX(region), MAX(city), MAX(latitude), MAX(longitude), MAX(timezone), MAX(language), MAX(operating_system), MAX(browser), MAX(device_type)
FROM visit_events
WHERE COALESCE(is_bot, 0) = 0 AND visitor_key IS NOT NULL
GROUP BY redirect_domain_id, date(visited_at, '+8 hours'), visitor_key;

CREATE INDEX IF NOT EXISTS idx_traffic_visitors_day ON traffic_daily_visitors(day);
