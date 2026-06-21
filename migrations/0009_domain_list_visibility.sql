ALTER TABLE redirect_domains ADD COLUMN list_visible INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_redirect_domains_list_visible ON redirect_domains(list_visible);
