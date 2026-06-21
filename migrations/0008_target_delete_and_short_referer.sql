ALTER TABLE redirect_domains ADD COLUMN deleted_target_host TEXT;
ALTER TABLE short_links ADD COLUMN hide_referer INTEGER NOT NULL DEFAULT 0;
