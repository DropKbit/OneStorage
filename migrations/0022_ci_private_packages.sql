-- Bind private build inputs to immutable files and deployment credentials, never plaintext secrets.
CREATE TABLE ci_run_packages (
 run_id TEXT NOT NULL REFERENCES ci_runs(id) ON DELETE CASCADE,
 file_id TEXT NOT NULL, project_id TEXT NOT NULL, lifecycle_revision INTEGER NOT NULL,
 token_id TEXT NOT NULL, token_hash TEXT NOT NULL, token_revision INTEGER NOT NULL,
 PRIMARY KEY(run_id,file_id,token_id)
);
CREATE INDEX ci_run_packages_source ON ci_run_packages(project_id,file_id);
CREATE INDEX ci_run_packages_token ON ci_run_packages(token_id);
CREATE INDEX ci_run_package_root ON ci_runs(COALESCE(parent_id,id));
CREATE VIEW ci_authorized_run_packages AS
SELECT b.* FROM ci_run_packages b JOIN package_files f ON f.id=b.file_id AND f.deleted_at IS NULL
 JOIN package_versions v ON v.id=f.version_id AND v.deleted_at IS NULL AND v.repo_id=b.project_id
 JOIN repositories p ON p.id=b.project_id AND p.deleted_at IS NULL AND p.lifecycle_revision=b.lifecycle_revision
 JOIN deploy_tokens d ON d.id=b.token_id AND d.hash=b.token_hash AND d.revision=b.token_revision
 WHERE d.revoked_at IS NULL AND d.expires_at>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
 AND (d.repo_id=p.id OR d.workspace_id=p.workspace_id)
 AND EXISTS(SELECT 1 FROM json_each(d.scopes) WHERE value='read_package_registry');
-- Root and all jobs share input authority, including jobs which have already finished.
CREATE VIEW ci_invalid_package_runs AS
SELECT DISTINCT r.id FROM ci_runs r JOIN ci_runs producer ON COALESCE(producer.parent_id,producer.id)=COALESCE(r.parent_id,r.id)
 JOIN ci_run_packages b ON b.run_id=producer.id
 WHERE NOT EXISTS(SELECT 1 FROM ci_authorized_run_packages a WHERE a.run_id=b.run_id AND a.file_id=b.file_id AND a.token_id=b.token_id);
CREATE TRIGGER ci_private_artifact BEFORE INSERT ON ci_artifacts WHEN EXISTS(SELECT 1 FROM ci_invalid_package_runs b WHERE b.id=NEW.run_id)
BEGIN SELECT RAISE(ABORT,'Private package authority changed'); END;
CREATE TRIGGER ci_private_deployment BEFORE INSERT ON deployments WHEN EXISTS(SELECT 1 FROM ci_invalid_package_runs b WHERE b.id=NEW.run_id)
BEGIN SELECT RAISE(ABORT,'Private package authority changed'); END;
CREATE TRIGGER ci_private_cache_insert BEFORE INSERT ON ci_cache_entries WHEN EXISTS(SELECT 1 FROM ci_invalid_package_runs b WHERE b.id=NEW.run_id)
BEGIN SELECT RAISE(ABORT,'Private package authority changed'); END;
CREATE TRIGGER ci_private_cache_ready BEFORE UPDATE OF state ON ci_cache_entries WHEN NEW.state='ready' AND EXISTS(SELECT 1 FROM ci_invalid_package_runs b WHERE b.id=NEW.run_id)
BEGIN SELECT RAISE(ABORT,'Private package authority changed'); END;
CREATE TRIGGER ci_private_success BEFORE UPDATE OF status ON ci_runs WHEN NEW.status='succeeded' AND EXISTS(SELECT 1 FROM ci_invalid_package_runs b WHERE b.id=NEW.id)
BEGIN SELECT RAISE(ABORT,'Private package authority changed'); END;
CREATE TRIGGER ci_private_stop_token_update AFTER UPDATE OF hash,revision,revoked_at,expires_at,scopes ON deploy_tokens
BEGIN
 UPDATE ci_runs SET status='canceled',error='Private package authority changed',finished_at=datetime('now'),lease_hash=NULL,lease_until=NULL
 WHERE status IN('queued','running') AND EXISTS(SELECT 1 FROM ci_invalid_package_runs b WHERE b.id=ci_runs.id);
END;
CREATE TRIGGER ci_private_stop_token_delete AFTER DELETE ON deploy_tokens
BEGIN
 UPDATE ci_runs SET status='canceled',error='Private package authority changed',finished_at=datetime('now'),lease_hash=NULL,lease_until=NULL
 WHERE status IN('queued','running') AND EXISTS(SELECT 1 FROM ci_invalid_package_runs b WHERE b.id=ci_runs.id);
END;
CREATE TRIGGER ci_private_stop_file_update AFTER UPDATE OF deleted_at ON package_files
BEGIN
 UPDATE ci_runs SET status='canceled',error='Private package authority changed',finished_at=datetime('now'),lease_hash=NULL,lease_until=NULL
 WHERE status IN('queued','running') AND EXISTS(SELECT 1 FROM ci_invalid_package_runs b WHERE b.id=ci_runs.id);
END;
CREATE TRIGGER ci_private_stop_file_delete AFTER DELETE ON package_files
BEGIN
 UPDATE ci_runs SET status='canceled',error='Private package authority changed',finished_at=datetime('now'),lease_hash=NULL,lease_until=NULL
 WHERE status IN('queued','running') AND EXISTS(SELECT 1 FROM ci_invalid_package_runs b WHERE b.id=ci_runs.id);
END;
CREATE TRIGGER ci_private_stop_version_update AFTER UPDATE OF deleted_at ON package_versions
BEGIN
 UPDATE ci_runs SET status='canceled',error='Private package authority changed',finished_at=datetime('now'),lease_hash=NULL,lease_until=NULL
 WHERE status IN('queued','running') AND EXISTS(SELECT 1 FROM ci_invalid_package_runs b WHERE b.id=ci_runs.id);
END;
CREATE TRIGGER ci_private_stop_version_delete AFTER DELETE ON package_versions
BEGIN
 UPDATE ci_runs SET status='canceled',error='Private package authority changed',finished_at=datetime('now'),lease_hash=NULL,lease_until=NULL
 WHERE status IN('queued','running') AND EXISTS(SELECT 1 FROM ci_invalid_package_runs b WHERE b.id=ci_runs.id);
END;
CREATE TRIGGER ci_private_stop_project_update AFTER UPDATE OF deleted_at,lifecycle_revision,workspace_id ON repositories
BEGIN
 UPDATE ci_runs SET status='canceled',error='Private package authority changed',finished_at=datetime('now'),lease_hash=NULL,lease_until=NULL
 WHERE status IN('queued','running') AND EXISTS(SELECT 1 FROM ci_invalid_package_runs b WHERE b.id=ci_runs.id);
END;
CREATE TRIGGER ci_private_stop_project_delete AFTER DELETE ON repositories
BEGIN
 UPDATE ci_runs SET status='canceled',error='Private package authority changed',finished_at=datetime('now'),lease_hash=NULL,lease_until=NULL
 WHERE status IN('queued','running') AND EXISTS(SELECT 1 FROM ci_invalid_package_runs b WHERE b.id=ci_runs.id);
END;
