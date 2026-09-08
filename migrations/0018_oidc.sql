CREATE TABLE oidc_providers (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, issuer TEXT NOT NULL, client_id TEXT NOT NULL,
 secret TEXT, config TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0,
 registration INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE oidc_identities (
 id TEXT PRIMARY KEY, provider_id TEXT NOT NULL REFERENCES oidc_providers(id),
 subject TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 created_at TEXT NOT NULL DEFAULT (datetime('now')),
 UNIQUE(provider_id,subject), UNIQUE(provider_id,user_id)
);
CREATE INDEX oidc_identity_user ON oidc_identities(user_id);
ALTER TABLE users ADD COLUMN has_password INTEGER NOT NULL DEFAULT 1;
ALTER TABLE credentials ADD COLUMN oidc_provider_id TEXT REFERENCES oidc_providers(id);
ALTER TABLE credentials ADD COLUMN authenticated_at INTEGER;
CREATE INDEX credential_oidc ON credentials(oidc_provider_id,user_id);
CREATE TABLE oidc_flows (
 state_hash TEXT PRIMARY KEY, browser_hash TEXT NOT NULL, provider_id TEXT NOT NULL REFERENCES oidc_providers(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL, mode TEXT NOT NULL, stage TEXT NOT NULL DEFAULT 'pending',
 user_id TEXT REFERENCES users(id) ON DELETE CASCADE, credential_hash TEXT, auth_epoch INTEGER,
 encrypted TEXT NOT NULL, subject TEXT, mfa_version TEXT,
 expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX oidc_flow_expiry ON oidc_flows(expires_at);
CREATE INDEX oidc_flow_provider ON oidc_flows(provider_id);
CREATE TRIGGER oidc_provider_revoke AFTER UPDATE ON oidc_providers BEGIN
 DELETE FROM credentials WHERE oidc_provider_id=NEW.id;
 DELETE FROM oidc_flows WHERE provider_id=NEW.id;
END;
CREATE TRIGGER oidc_identity_revoke AFTER DELETE ON oidc_identities BEGIN
 DELETE FROM credentials WHERE oidc_provider_id=OLD.provider_id AND user_id=OLD.user_id;
 DELETE FROM oidc_flows WHERE provider_id=OLD.provider_id AND user_id=OLD.user_id;
END;
