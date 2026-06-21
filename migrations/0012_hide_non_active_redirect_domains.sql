UPDATE redirect_domains
SET list_visible = 0,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE status != 'active';
