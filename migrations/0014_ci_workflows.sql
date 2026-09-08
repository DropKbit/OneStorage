ALTER TABLE ci_pipelines ADD COLUMN source_path TEXT;
ALTER TABLE ci_runs ADD COLUMN parent_id TEXT REFERENCES ci_runs(id) ON DELETE CASCADE;
ALTER TABLE ci_runs ADD COLUMN job_key TEXT;
ALTER TABLE ci_runs ADD COLUMN config_path TEXT;
ALTER TABLE ci_runs ADD COLUMN config_sha TEXT;
ALTER TABLE ci_runs ADD COLUMN config_error TEXT;
CREATE UNIQUE INDEX ci_workflow_job ON ci_runs(parent_id,job_key);
CREATE INDEX ci_workflow_parent ON ci_runs(parent_id,status);
CREATE TABLE ci_events(id TEXT PRIMARY KEY,repo_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,payload TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TRIGGER ci_workflow_stop AFTER UPDATE OF status ON ci_runs
WHEN NEW.status IN ('failed','canceled','succeeded') AND OLD.status IN ('queued','running')
BEGIN
  UPDATE ci_runs SET status='canceled',error='Parent workflow stopped',finished_at=datetime('now'),lease_hash=NULL,lease_until=NULL
  WHERE parent_id=NEW.id AND status IN ('queued','running');
END;
CREATE TRIGGER ci_workflow_scope BEFORE INSERT ON ci_runs
WHEN NEW.parent_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM ci_runs p WHERE p.id=NEW.parent_id AND p.parent_id IS NULL AND p.repo_id=NEW.repo_id AND p.sha=NEW.sha
    AND p.ref=NEW.ref AND p.status='running' AND json_extract(p.config,'$.runner')='workflow'
)
BEGIN SELECT RAISE(ABORT,'Invalid workflow parent'); END;
