-- Deploy tokens belong to projects/workspaces, independently of their creator's membership.
CREATE TABLE deploy_tokens (
 id TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE,
 repo_id TEXT REFERENCES repositories(id) ON DELETE CASCADE,
 workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
 name TEXT NOT NULL, username TEXT NOT NULL, scopes TEXT NOT NULL CHECK(json_valid(scopes)),
 created_by TEXT NOT NULL REFERENCES users(id), created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
 revoked_at INTEGER, last_used_at INTEGER,
 CHECK((repo_id IS NOT NULL AND workspace_id IS NULL) OR (repo_id IS NULL AND workspace_id IS NOT NULL))
);
CREATE INDEX deploy_tokens_project ON deploy_tokens(repo_id,created_at,id);
CREATE INDEX deploy_tokens_workspace ON deploy_tokens(workspace_id,created_at,id);
CREATE TRIGGER deploy_tokens_transfer AFTER UPDATE OF workspace_id,namespace ON repositories
WHEN OLD.workspace_id IS NOT NEW.workspace_id OR (OLD.workspace_id IS NULL AND OLD.namespace<>NEW.namespace)
BEGIN
 UPDATE deploy_tokens SET revoked_at=COALESCE(revoked_at,CAST(unixepoch('now') AS INTEGER)*1000),revision=revision+1 WHERE repo_id=NEW.id AND revoked_at IS NULL;
END;
-- Keep historical attribution without treating the issuer as the token's live principal.
ALTER TABLE package_versions ADD COLUMN deploy_token_id TEXT REFERENCES deploy_tokens(id) ON DELETE SET NULL;
ALTER TABLE package_versions ADD COLUMN publisher_label TEXT;
