-- Workspace values retain their own encrypted scope; project storage is unchanged.
CREATE TABLE ci_workspace_variables (
 id TEXT PRIMARY KEY CHECK(substr(id,1,4)='wcv_'), workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 owner_id TEXT NOT NULL REFERENCES users(id), key TEXT NOT NULL, environment TEXT NOT NULL DEFAULT '*',
 encrypted TEXT NOT NULL, secret INTEGER NOT NULL DEFAULT 1, protected INTEGER NOT NULL DEFAULT 1,
 refs TEXT NOT NULL DEFAULT '["main"]', enabled INTEGER NOT NULL DEFAULT 1, revision INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
 UNIQUE(workspace_id,key,environment),CHECK(secret IN(0,1)),CHECK(protected IN(0,1)),CHECK(enabled IN(0,1))
);
CREATE INDEX ci_workspace_variable_owner ON ci_workspace_variables(owner_id,enabled);
CREATE VIEW ci_authorized_workspace_variables AS
SELECT v.* FROM ci_workspace_variables v JOIN users u ON u.id=v.owner_id
WHERE v.enabled=1 AND u.disabled=0 AND EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=v.workspace_id AND m.user_id=v.owner_id AND m.role='owner');
CREATE VIEW ci_authorized_project_variables AS
SELECT v.* FROM ci_variables v JOIN repositories r ON r.id=v.repo_id JOIN users u ON u.id=v.owner_id
WHERE v.enabled=1 AND r.deleted_at IS NULL AND r.archived_at IS NULL AND u.disabled=0 AND (
 (r.workspace_id IS NULL AND r.owner_id=u.id) OR
 EXISTS(SELECT 1 FROM members m WHERE m.repo_id=r.id AND m.user_id=u.id AND m.role IN('maintainer','owner')) OR
 EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=r.workspace_id AND m.user_id=u.id AND m.role IN('maintainer','owner'))
);
DROP VIEW ci_authorized_variables;
CREATE VIEW ci_variable_definitions AS
SELECT v.*,0 AS scope_rank,v.repo_id AS scope_id FROM ci_variables v
UNION ALL
SELECT v.id,r.id AS repo_id,v.owner_id,v.key,v.environment,v.encrypted,v.secret,v.protected,v.refs,v.enabled,v.revision,v.created_at,v.updated_at,1 AS scope_rank,v.workspace_id AS scope_id
FROM ci_workspace_variables v JOIN repositories r ON r.workspace_id=v.workspace_id;
CREATE VIEW ci_authorized_variables AS
SELECT v.* FROM ci_variable_definitions v JOIN repositories r ON r.id=v.repo_id
WHERE r.deleted_at IS NULL AND r.archived_at IS NULL AND ((v.scope_rank=0 AND EXISTS(SELECT 1 FROM ci_authorized_project_variables a WHERE a.id=v.id)) OR (v.scope_rank=1 AND EXISTS(SELECT 1 FROM ci_authorized_workspace_variables a WHERE a.id=v.id)));

CREATE TRIGGER ci_workspace_variable_stop_update AFTER UPDATE ON ci_workspace_variables
WHEN NEW.revision!=OLD.revision OR NEW.enabled=0
BEGIN
 UPDATE ci_runs SET status='canceled',error='CI variable changed or revoked',finished_at=datetime('now'),lease_hash=NULL,lease_until=NULL
 WHERE status IN('queued','running') AND id IN (SELECT COALESCE(r.parent_id,r.id) FROM ci_runs r JOIN ci_run_variables v ON v.run_id=r.id WHERE v.variable_id=OLD.id);
 UPDATE ci_runs SET status='canceled',error='CI variable changed or revoked',finished_at=datetime('now'),lease_hash=NULL,lease_until=NULL
 WHERE status IN('queued','running') AND id IN (SELECT run_id FROM ci_run_variables WHERE variable_id=OLD.id);
END;

CREATE TRIGGER ci_workspace_variable_stop_delete BEFORE DELETE ON ci_workspace_variables

BEGIN
 UPDATE ci_runs SET status='canceled',error='CI variable changed or revoked',finished_at=datetime('now'),lease_hash=NULL,lease_until=NULL
 WHERE status IN('queued','running') AND id IN (SELECT COALESCE(r.parent_id,r.id) FROM ci_runs r JOIN ci_run_variables v ON v.run_id=r.id WHERE v.variable_id=OLD.id);
 UPDATE ci_runs SET status='canceled',error='CI variable changed or revoked',finished_at=datetime('now'),lease_hash=NULL,lease_until=NULL
 WHERE status IN('queued','running') AND id IN (SELECT run_id FROM ci_run_variables WHERE variable_id=OLD.id);
END;

DROP TRIGGER ci_variable_revoke_members_update;
CREATE TRIGGER ci_variable_revoke_members_update AFTER UPDATE ON members
BEGIN
 UPDATE ci_variables SET enabled=0,revision=revision+1,updated_at=datetime('now') WHERE enabled=1 AND id NOT IN(SELECT id FROM ci_authorized_project_variables);
END;

DROP TRIGGER ci_variable_revoke_members_delete;
CREATE TRIGGER ci_variable_revoke_members_delete AFTER DELETE ON members
BEGIN
 UPDATE ci_variables SET enabled=0,revision=revision+1,updated_at=datetime('now') WHERE enabled=1 AND id NOT IN(SELECT id FROM ci_authorized_project_variables);
END;

DROP TRIGGER ci_variable_revoke_workspace_members_update;
CREATE TRIGGER ci_variable_revoke_workspace_members_update AFTER UPDATE ON workspace_members
BEGIN
 UPDATE ci_variables SET enabled=0,revision=revision+1,updated_at=datetime('now') WHERE enabled=1 AND id NOT IN(SELECT id FROM ci_authorized_project_variables);
END;

DROP TRIGGER ci_variable_revoke_workspace_members_delete;
CREATE TRIGGER ci_variable_revoke_workspace_members_delete AFTER DELETE ON workspace_members
BEGIN
 UPDATE ci_variables SET enabled=0,revision=revision+1,updated_at=datetime('now') WHERE enabled=1 AND id NOT IN(SELECT id FROM ci_authorized_project_variables);
END;

DROP TRIGGER ci_variable_revoke_users_update;
CREATE TRIGGER ci_variable_revoke_users_update AFTER UPDATE OF disabled ON users
BEGIN
 UPDATE ci_variables SET enabled=0,revision=revision+1,updated_at=datetime('now') WHERE enabled=1 AND id NOT IN(SELECT id FROM ci_authorized_project_variables);
END;

CREATE TRIGGER ci_workspace_variable_revoke_members_update AFTER UPDATE ON workspace_members BEGIN
 UPDATE ci_workspace_variables SET enabled=0,revision=revision+1,updated_at=datetime('now') WHERE enabled=1 AND id NOT IN(SELECT id FROM ci_authorized_workspace_variables);
END;

CREATE TRIGGER ci_workspace_variable_revoke_members_delete AFTER DELETE ON workspace_members BEGIN
 UPDATE ci_workspace_variables SET enabled=0,revision=revision+1,updated_at=datetime('now') WHERE enabled=1 AND id NOT IN(SELECT id FROM ci_authorized_workspace_variables);
END;

CREATE TRIGGER ci_workspace_variable_revoke_users_update AFTER UPDATE OF disabled ON users BEGIN
 UPDATE ci_workspace_variables SET enabled=0,revision=revision+1,updated_at=datetime('now') WHERE enabled=1 AND id NOT IN(SELECT id FROM ci_authorized_workspace_variables);
END;

CREATE TRIGGER ci_workspace_variable_repository_move AFTER UPDATE OF workspace_id ON repositories
WHEN NEW.workspace_id IS NOT OLD.workspace_id
BEGIN
 UPDATE ci_runs SET status='canceled',error='Inherited CI variable workspace changed',finished_at=datetime('now'),lease_hash=NULL,lease_until=NULL
 WHERE status IN('queued','running') AND id IN(SELECT COALESCE(r.parent_id,r.id) FROM ci_runs r JOIN ci_run_variables b ON b.run_id=r.id WHERE r.repo_id=NEW.id AND substr(b.variable_id,1,4)='wcv_');
 UPDATE ci_runs SET status='canceled',error='Inherited CI variable workspace changed',finished_at=datetime('now'),lease_hash=NULL,lease_until=NULL
 WHERE status IN('queued','running') AND repo_id=NEW.id AND id IN(SELECT run_id FROM ci_run_variables WHERE substr(variable_id,1,4)='wcv_');
END;
