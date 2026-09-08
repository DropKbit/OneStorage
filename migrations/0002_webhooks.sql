CREATE TABLE webhooks (id TEXT PRIMARY KEY, repo_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE, url TEXT NOT NULL, secret TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX webhooks_repo ON webhooks(repo_id);
CREATE TABLE deliveries (id TEXT PRIMARY KEY, webhook_id TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE, payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','delivered','failed')), attempts INTEGER NOT NULL DEFAULT 0, last_status INTEGER, available_at INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX deliveries_pending ON deliveries(state,available_at);
