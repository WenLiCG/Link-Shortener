ALTER TABLE job_steps RENAME TO job_steps_old;
ALTER TABLE domain_jobs RENAME TO domain_jobs_old;

CREATE TABLE domain_jobs (
  id TEXT PRIMARY KEY,
  redirect_domain_id TEXT REFERENCES redirect_domains(id) ON DELETE SET NULL,
  type TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  current_step TEXT NOT NULL DEFAULT 'queued',
  error_message TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  next_attempt_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  lease_token TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  finished_at TEXT
);

INSERT INTO domain_jobs (
  id, redirect_domain_id, type, subject_type, subject_id, payload, idempotency_key,
  status, current_step, error_message, attempt_count, max_attempts, next_attempt_at,
  created_at, updated_at, finished_at
)
SELECT
  id,
  redirect_domain_id,
  CASE WHEN type = 'retry' THEN 'domain_retry' ELSE 'domain_provision' END,
  'redirect_domain',
  redirect_domain_id,
  '{}',
  'legacy:' || id,
  CASE WHEN status = 'running' THEN 'queued' ELSE status END,
  current_step,
  error_message,
  0,
  5,
  updated_at,
  created_at,
  updated_at,
  finished_at
FROM domain_jobs_old;

CREATE TABLE job_steps (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES domain_jobs(id) ON DELETE CASCADE,
  step TEXT NOT NULL,
  status TEXT NOT NULL,
  message TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO job_steps (id, job_id, step, status, message, metadata, created_at)
SELECT id, job_id, step, status, message, metadata, created_at
FROM job_steps_old;

DROP TABLE job_steps_old;
DROP TABLE domain_jobs_old;

CREATE UNIQUE INDEX idx_domain_jobs_idempotency ON domain_jobs(idempotency_key);
CREATE INDEX idx_domain_jobs_claim ON domain_jobs(status, next_attempt_at, created_at);
CREATE INDEX idx_domain_jobs_subject ON domain_jobs(subject_type, subject_id, created_at);
CREATE INDEX idx_job_steps_job ON job_steps(job_id);
