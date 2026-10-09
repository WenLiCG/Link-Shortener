ALTER TABLE domain_jobs ADD COLUMN lease_loss_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE domain_jobs ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 0;

CREATE TABLE job_request_keys (
  request_key TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES domain_jobs(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO job_request_keys (request_key, job_id)
SELECT idempotency_key, id FROM domain_jobs;

CREATE INDEX idx_job_request_keys_job ON job_request_keys(job_id);
