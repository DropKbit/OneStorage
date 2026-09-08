CREATE TABLE ci_variables (
 id TEXT PRIMARY KEY, repo_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
 owner_id TEXT NOT NULL REFERENCES users(id), key TEXT NOT NULL, environment TEXT NOT NULL DEFAULT '*',
 encrypted TEXT NOT NULL, secret INTEGER NOT NULL DEFAULT 1, protected INTEGER NOT NULL DEFAULT 1,
 refs TEXT NOT NULL DEFAULT '["main"]', enabled INTEGER NOT NULL DEFAULT 1, revision INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
 UNIQUE(repo_id,key,environment), CHECK(secret IN(0,1)),CHECK(protected IN(0,1)),CHECK(enabled IN(0,1))
);
ALTER TABLE ci_runs ADD COLUMN source_trigger TEXT;
-- Existing runs remain unclassified; no archived run history is rewritten.
CREATE TABLE ci_run_variables (
 run_id TEXT NOT NULL REFERENCES ci_runs(id) ON DELETE CASCADE,
 variable_id TEXT NOT NULL, key TEXT NOT NULL, revision INTEGER NOT NULL,
 encrypted TEXT NOT NULL, secret INTEGER NOT NULL, protected INTEGER NOT NULL,
 PRIMARY KEY(run_id,key)
);
CREATE INDEX ci_run_variable_source ON ci_run_variables(variable_id,revision);
CREATE VIEW ci_authorized_variables AS
SELECT v.* FROM ci_variables v JOIN repositories r ON r.id=v.repo_id JOIN users u ON u.id=v.owner_id
WHERE v.enabled=1 AND r.deleted_at IS NULL AND r.archived_at IS NULL AND u.disabled=0 AND (
 (r.workspace_id IS NULL AND r.owner_id=u.id) OR
 EXISTS(SELECT 1 FROM members m WHERE m.repo_id=r.id AND m.user_id=u.id AND m.role IN('maintainer','owner')) OR
 EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=r.workspace_id AND m.user_id=u.id AND m.role IN('maintainer','owner'))
);

CREATE TRIGGER ci_variable_stop_update AFTER UPDATE ON ci_variables
WHEN NEW.revision!=OLD.revision OR NEW.enabled=0
BEGIN
 UPDATE ci_runs SET status='canceled',error='CI variable changed or revoked',finished_at=datetime('now'),lease_hash=NULL,lease_until=NULL
 WHERE status IN('queued','running') AND id IN (SELECT COALESCE(r.parent_id,r.id) FROM ci_runs r JOIN ci_run_variables v ON v.run_id=r.id WHERE v.variable_id=OLD.id);
 UPDATE ci_runs SET status='canceled',error='CI variable changed or revoked',finished_at=datetime('now'),lease_hash=NULL,lease_until=NULL
 WHERE status IN('queued','running') AND id IN (SELECT run_id FROM ci_run_variables WHERE variable_id=OLD.id);
END;

CREATE TRIGGER ci_variable_stop_delete BEFORE DELETE ON ci_variables

BEGIN
 UPDATE ci_runs SET status='canceled',error='CI variable changed or revoked',finished_at=datetime('now'),lease_hash=NULL,lease_until=NULL
 WHERE status IN('queued','running') AND id IN (SELECT COALESCE(r.parent_id,r.id) FROM ci_runs r JOIN ci_run_variables v ON v.run_id=r.id WHERE v.variable_id=OLD.id);
 UPDATE ci_runs SET status='canceled',error='CI variable changed or revoked',finished_at=datetime('now'),lease_hash=NULL,lease_until=NULL
 WHERE status IN('queued','running') AND id IN (SELECT run_id FROM ci_run_variables WHERE variable_id=OLD.id);
END;

CREATE TRIGGER ci_variable_revoke_members_update AFTER UPDATE ON members
BEGIN
 UPDATE ci_variables SET enabled=0,revision=revision+1,updated_at=datetime('now') WHERE enabled=1 AND id NOT IN(SELECT id FROM ci_authorized_variables);
END;

CREATE TRIGGER ci_variable_revoke_members_delete AFTER DELETE ON members
BEGIN
 UPDATE ci_variables SET enabled=0,revision=revision+1,updated_at=datetime('now') WHERE enabled=1 AND id NOT IN(SELECT id FROM ci_authorized_variables);
END;

CREATE TRIGGER ci_variable_revoke_workspace_members_update AFTER UPDATE ON workspace_members
BEGIN
 UPDATE ci_variables SET enabled=0,revision=revision+1,updated_at=datetime('now') WHERE enabled=1 AND id NOT IN(SELECT id FROM ci_authorized_variables);
END;

CREATE TRIGGER ci_variable_revoke_workspace_members_delete AFTER DELETE ON workspace_members
BEGIN
 UPDATE ci_variables SET enabled=0,revision=revision+1,updated_at=datetime('now') WHERE enabled=1 AND id NOT IN(SELECT id FROM ci_authorized_variables);
END;

CREATE TRIGGER ci_variable_revoke_users_update AFTER UPDATE OF disabled ON users
BEGIN
 UPDATE ci_variables SET enabled=0,revision=revision+1,updated_at=datetime('now') WHERE enabled=1 AND id NOT IN(SELECT id FROM ci_authorized_variables);
END;

CREATE TRIGGER ci_variable_revoke_repositories_update AFTER UPDATE OF archived_at,deleted_at,workspace_id,owner_id,namespace ON repositories
BEGIN
 UPDATE ci_variables SET enabled=0,revision=revision+1,updated_at=datetime('now') WHERE repo_id=NEW.id AND enabled=1 AND (NEW.archived_at IS NOT NULL OR NEW.deleted_at IS NOT NULL OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.owner_id IS NOT OLD.owner_id OR NEW.namespace!=OLD.namespace);
END;

CREATE TRIGGER ci_variable_protection_delete AFTER DELETE ON branch_protections
BEGIN
 UPDATE ci_runs SET status='canceled',error='Protected variable branch policy changed',finished_at=datetime('now'),lease_hash=NULL,lease_until=NULL
 WHERE status IN('queued','running') AND id IN (SELECT COALESCE(r.parent_id,r.id) FROM ci_runs r JOIN ci_run_variables v ON v.run_id=r.id WHERE r.repo_id=OLD.repo_id AND r.ref=OLD.branch AND v.protected=1);
 UPDATE ci_runs SET status='canceled',error='Protected variable branch policy changed',finished_at=datetime('now'),lease_hash=NULL,lease_until=NULL
 WHERE status IN('queued','running') AND repo_id=OLD.repo_id AND ref=OLD.branch AND id IN(SELECT run_id FROM ci_run_variables WHERE protected=1);
END;

CREATE TRIGGER ci_variable_protection_update AFTER UPDATE ON branch_protections
BEGIN
 UPDATE ci_runs SET status='canceled',error='Protected variable branch policy changed',finished_at=datetime('now'),lease_hash=NULL,lease_until=NULL
 WHERE status IN('queued','running') AND id IN (SELECT COALESCE(r.parent_id,r.id) FROM ci_runs r JOIN ci_run_variables v ON v.run_id=r.id WHERE r.repo_id=OLD.repo_id AND r.ref=OLD.branch AND v.protected=1);
 UPDATE ci_runs SET status='canceled',error='Protected variable branch policy changed',finished_at=datetime('now'),lease_hash=NULL,lease_until=NULL
 WHERE status IN('queued','running') AND repo_id=OLD.repo_id AND ref=OLD.branch AND id IN(SELECT run_id FROM ci_run_variables WHERE protected=1);
END;
