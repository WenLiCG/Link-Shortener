-- Deploy the Worker that no longer reads these tables before applying this migration.
-- Daily UV was backfilled in 0019/0021; export D1 before discarding legacy PV and event detail.
-- Keep both legacy daily_uniques tables: their full historical UV was never migrated.
DROP TABLE IF EXISTS traffic_daily_stats;
DROP TABLE IF EXISTS visit_daily_stats;
DROP TABLE IF EXISTS visit_events;
