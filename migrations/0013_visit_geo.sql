ALTER TABLE visit_events ADD COLUMN region TEXT;
ALTER TABLE visit_events ADD COLUMN city TEXT;
ALTER TABLE visit_events ADD COLUMN timezone TEXT;
ALTER TABLE visit_events ADD COLUMN latitude REAL;
ALTER TABLE visit_events ADD COLUMN longitude REAL;
ALTER TABLE visit_events ADD COLUMN language TEXT;
ALTER TABLE visit_events ADD COLUMN operating_system TEXT;
ALTER TABLE visit_events ADD COLUMN browser TEXT;
ALTER TABLE visit_events ADD COLUMN device_type TEXT;

CREATE INDEX IF NOT EXISTS idx_visit_events_geo ON visit_events(country, region, city);
CREATE INDEX IF NOT EXISTS idx_visit_events_client ON visit_events(language, operating_system, browser, device_type);
