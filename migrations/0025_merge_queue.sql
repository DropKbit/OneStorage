ALTER TABLE branch_protections ADD COLUMN require_queue INTEGER NOT NULL DEFAULT 0 CHECK(require_queue IN(0,1));
CREATE TABLE merge_queue (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 repo_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
 mr_id INTEGER NOT NULL REFERENCES merge_requests(id) ON DELETE CASCADE,
 actor_id TEXT NOT NULL REFERENCES users(id), actor_epoch INTEGER NOT NULL,
 last_actor_id TEXT NOT NULL REFERENCES users(id), lifecycle_revision INTEGER NOT NULL,
 target TEXT NOT NULL, source_sha TEXT NOT NULL, target_sha TEXT NOT NULL, mr_revision INTEGER NOT NULL,
 strategy TEXT NOT NULL CHECK(strategy IN('ff_prefer','ff_only','merge')), squash INTEGER NOT NULL CHECK(squash IN(0,1)),
 state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN('queued','checking','blocked','merged','canceled','failed')),
 reason TEXT NOT NULL DEFAULT '', generation INTEGER NOT NULL DEFAULT 0,
 candidate_sha TEXT, run_id TEXT REFERENCES ci_runs(id) ON DELETE SET NULL, config_fingerprint TEXT,
 created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, checked_at INTEGER NOT NULL DEFAULT 0,
 finished_at INTEGER, merged_sha TEXT
);
CREATE UNIQUE INDEX merge_queue_active_mr ON merge_queue(mr_id) WHERE state IN('queued','checking','blocked');
CREATE INDEX merge_queue_heads ON merge_queue(repo_id,state,target,id);
CREATE VIEW merge_queue_authority AS
 SELECT q.id FROM merge_queue q JOIN repositories r ON r.id=q.repo_id JOIN users u ON u.id=q.actor_id
 JOIN merge_requests m ON m.id=q.mr_id AND m.repo_id=q.repo_id
 WHERE q.state IN('queued','checking','blocked') AND u.disabled=0 AND u.auth_epoch=q.actor_epoch
 AND r.deleted_at IS NULL AND r.archived_at IS NULL AND r.lifecycle_revision=q.lifecycle_revision
 AND m.state='open' AND m.revision=q.mr_revision AND m.source_sha=q.source_sha AND m.target_sha=q.target_sha
 AND ((r.workspace_id IS NULL AND r.owner_id=u.id)
 OR EXISTS(SELECT 1 FROM members x WHERE x.repo_id=r.id AND x.user_id=u.id AND x.role IN('maintainer','owner'))
 OR EXISTS(SELECT 1 FROM workspace_members x WHERE x.workspace_id=r.workspace_id AND x.user_id=u.id AND x.role IN('maintainer','owner')));
CREATE TRIGGER merge_queue_ci_guard BEFORE INSERT ON ci_runs
 WHEN NEW.event_id LIKE 'merge-queue:%' AND NOT EXISTS(
 SELECT 1 FROM merge_queue q JOIN merge_queue_authority a ON a.id=q.id
 WHERE NEW.event_id='merge-queue:'||q.id||':'||q.generation AND q.repo_id=NEW.repo_id AND q.candidate_sha=NEW.sha
 AND NEW.actor_id=q.actor_id AND NEW.trigger='merge_request' AND NEW.source_trigger='merge_request'
 AND q.expires_at>CAST(strftime('%s','now') AS INTEGER)*1000
 ) BEGIN SELECT RAISE(ABORT,'Merge queue authority changed'); END;
CREATE TRIGGER merge_queue_added AFTER INSERT ON merge_queue BEGIN
 INSERT INTO audit(repo_id,actor_id,action,detail) VALUES(NEW.repo_id,NEW.actor_id,'merge_queue.enqueue',json_object('queue_id',NEW.id,'mr_id',NEW.mr_id));
END;
CREATE TRIGGER merge_queue_changed AFTER UPDATE OF state ON merge_queue WHEN OLD.state!=NEW.state BEGIN
 INSERT INTO audit(repo_id,actor_id,action,detail) VALUES(NEW.repo_id,NEW.last_actor_id,'merge_queue.'||NEW.state,json_object('queue_id',NEW.id,'mr_id',NEW.mr_id,'reason',NEW.reason));
END;
CREATE TRIGGER merge_queue_cancel_run AFTER UPDATE OF state,generation ON merge_queue
 WHEN NEW.state IN('canceled','failed') OR NEW.generation!=OLD.generation BEGIN
 UPDATE ci_runs SET status='canceled',finished_at=datetime('now'),lease_hash=NULL,lease_until=NULL
 WHERE (event_id LIKE 'merge-queue:'||OLD.id||':%' OR parent_id IN(SELECT id FROM ci_runs WHERE event_id LIKE 'merge-queue:'||OLD.id||':%')) AND status IN('queued','running');
END;
CREATE TRIGGER merge_queue_account_stop AFTER UPDATE OF auth_epoch,disabled ON users
 WHEN NEW.disabled=1 OR NEW.auth_epoch!=OLD.auth_epoch BEGIN
 UPDATE merge_queue SET state='canceled',reason='Queue owner account security changed',finished_at=CAST(strftime('%s','now') AS INTEGER)*1000
 WHERE actor_id=NEW.id AND state IN('queued','checking','blocked');
END;
CREATE TRIGGER merge_queue_lifecycle AFTER UPDATE OF lifecycle_revision,archived_at,deleted_at ON repositories
 WHEN NEW.lifecycle_revision!=OLD.lifecycle_revision OR NEW.archived_at IS NOT NULL OR NEW.deleted_at IS NOT NULL BEGIN
 UPDATE merge_queue SET state='canceled',reason='Project lifecycle changed',finished_at=CAST(strftime('%s','now') AS INTEGER)*1000
 WHERE repo_id=NEW.id AND state IN('queued','checking','blocked');
END;
