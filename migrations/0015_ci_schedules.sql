CREATE TABLE ci_schedules (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  ref TEXT NOT NULL,
  cron TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  revision INTEGER NOT NULL DEFAULT 0,
  next_run_at INTEGER NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX ci_schedules_due ON ci_schedules(enabled,next_run_at);
CREATE INDEX ci_schedules_repo ON ci_schedules(repo_id);
CREATE TABLE ci_schedule_ticks (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL REFERENCES ci_schedules(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  scheduled_for INTEGER NOT NULL,
  manual INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','done','failed','canceled')),
  sha TEXT,
  config TEXT,
  config_path TEXT,
  config_sha TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX ci_schedule_slot ON ci_schedule_ticks(schedule_id,revision,scheduled_for) WHERE manual=0;
CREATE INDEX ci_schedule_outbox ON ci_schedule_ticks(state,created_at);
ALTER TABLE ci_runs ADD COLUMN schedule_tick_id TEXT REFERENCES ci_schedule_ticks(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX ci_run_schedule_tick ON ci_runs(schedule_tick_id);

-- Matches repositoryRole: instance admin does not grant project membership.
CREATE VIEW ci_authorized_schedules AS
SELECT s.* FROM ci_schedules s JOIN repositories r ON r.id=s.repo_id JOIN users u ON u.id=s.owner_id
WHERE r.deleted_at IS NULL AND r.archived_at IS NULL AND u.disabled=0 AND (
 (r.workspace_id IS NULL AND r.owner_id=u.id) OR
 EXISTS(SELECT 1 FROM members m WHERE m.repo_id=r.id AND m.user_id=u.id AND m.role IN ('maintainer','owner')) OR
 EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=r.workspace_id AND m.user_id=u.id AND m.role IN ('maintainer','owner'))
);

CREATE TRIGGER ci_schedule_stop AFTER UPDATE OF revision,enabled ON ci_schedules
WHEN NEW.revision!=OLD.revision OR NEW.enabled=0
BEGIN
 UPDATE ci_schedule_ticks SET state='canceled',error='Schedule changed or stopped' WHERE schedule_id=NEW.id AND state='pending';
 UPDATE ci_runs SET status='canceled',error='Schedule changed or stopped',finished_at=datetime('now'),lease_hash=NULL,lease_until=NULL
 WHERE schedule_tick_id IN (SELECT id FROM ci_schedule_ticks WHERE schedule_id=NEW.id) AND status IN ('queued','running');
END;
CREATE TRIGGER ci_schedule_delete BEFORE DELETE ON ci_schedules
BEGIN
 UPDATE ci_runs SET status='canceled',error='Schedule deleted',finished_at=datetime('now'),lease_hash=NULL,lease_until=NULL
 WHERE schedule_tick_id IN (SELECT id FROM ci_schedule_ticks WHERE schedule_id=OLD.id) AND status IN ('queued','running');
END;

CREATE TRIGGER ci_schedule_revoke_members_update AFTER UPDATE ON members
BEGIN
 UPDATE ci_schedules SET enabled=0,revision=revision+1,last_error='Schedule authority or project lifecycle changed',updated_at=datetime('now') WHERE enabled=1 AND id NOT IN (SELECT id FROM ci_authorized_schedules);
END;

CREATE TRIGGER ci_schedule_revoke_members_delete AFTER DELETE ON members
BEGIN
 UPDATE ci_schedules SET enabled=0,revision=revision+1,last_error='Schedule authority or project lifecycle changed',updated_at=datetime('now') WHERE enabled=1 AND id NOT IN (SELECT id FROM ci_authorized_schedules);
END;

CREATE TRIGGER ci_schedule_revoke_workspace_members_update AFTER UPDATE ON workspace_members
BEGIN
 UPDATE ci_schedules SET enabled=0,revision=revision+1,last_error='Schedule authority or project lifecycle changed',updated_at=datetime('now') WHERE enabled=1 AND id NOT IN (SELECT id FROM ci_authorized_schedules);
END;

CREATE TRIGGER ci_schedule_revoke_workspace_members_delete AFTER DELETE ON workspace_members
BEGIN
 UPDATE ci_schedules SET enabled=0,revision=revision+1,last_error='Schedule authority or project lifecycle changed',updated_at=datetime('now') WHERE enabled=1 AND id NOT IN (SELECT id FROM ci_authorized_schedules);
END;

CREATE TRIGGER ci_schedule_revoke_users_update AFTER UPDATE OF disabled ON users
BEGIN
 UPDATE ci_schedules SET enabled=0,revision=revision+1,last_error='Schedule authority or project lifecycle changed',updated_at=datetime('now') WHERE enabled=1 AND id NOT IN (SELECT id FROM ci_authorized_schedules);
END;

CREATE TRIGGER ci_schedule_revoke_repositories_update AFTER UPDATE OF archived_at,deleted_at,workspace_id,owner_id,namespace ON repositories
BEGIN
 UPDATE ci_schedules SET enabled=0,revision=revision+1,last_error='Schedule authority or project lifecycle changed',updated_at=datetime('now') WHERE repo_id=NEW.id AND enabled=1 AND (NEW.archived_at IS NOT NULL OR NEW.deleted_at IS NOT NULL OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.owner_id IS NOT OLD.owner_id OR NEW.namespace!=OLD.namespace);
END;
