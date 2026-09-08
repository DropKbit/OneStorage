CREATE TABLE ci_cache_state (
 repo_id TEXT PRIMARY KEY REFERENCES repositories(id) ON DELETE CASCADE,
 generation INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE ci_run_caches (
 run_id TEXT NOT NULL REFERENCES ci_runs(id) ON DELETE CASCADE,
 slot TEXT NOT NULL, generation INTEGER NOT NULL, scope TEXT NOT NULL,
 keys TEXT NOT NULL, spec TEXT NOT NULL, format TEXT NOT NULL,
 PRIMARY KEY(run_id,slot)
);
-- Upload ownership deliberately outlives run/repository deletion so interrupted uploads remain collectable.
CREATE TABLE ci_cache_entries (
 id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, run_id TEXT NOT NULL, slot TEXT NOT NULL,
 generation INTEGER NOT NULL, scope TEXT NOT NULL, cache_key TEXT NOT NULL, format TEXT NOT NULL,
 label TEXT NOT NULL, paths TEXT NOT NULL, ref TEXT NOT NULL,
 object_key TEXT NOT NULL UNIQUE, size INTEGER NOT NULL, checksum TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'uploading' CHECK(state IN('uploading','ready','retired')),
 created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
 UNIQUE(run_id,slot),CHECK(size>0 AND size<=67108864)
);
CREATE INDEX ci_cache_lookup ON ci_cache_entries(repo_id,generation,scope,cache_key,format,state,created_at);
CREATE INDEX ci_cache_gc ON ci_cache_entries(state,expires_at,created_at);
CREATE VIEW ci_visible_caches AS
SELECT e.* FROM ci_cache_entries e JOIN ci_cache_state s ON s.repo_id=e.repo_id AND s.generation=e.generation
JOIN repositories r ON r.id=e.repo_id AND r.deleted_at IS NULL AND r.archived_at IS NULL
JOIN ci_runs c ON c.id=e.run_id AND c.status='succeeded'
WHERE e.state='ready' AND (c.parent_id IS NULL OR EXISTS(SELECT 1 FROM ci_runs p WHERE p.id=c.parent_id AND p.status='succeeded'));
CREATE TRIGGER ci_cache_lifecycle AFTER UPDATE OF archived_at,deleted_at,workspace_id,owner_id,namespace ON repositories
WHEN NEW.archived_at IS NOT OLD.archived_at OR NEW.deleted_at IS NOT OLD.deleted_at OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.owner_id IS NOT OLD.owner_id OR NEW.namespace!=OLD.namespace
BEGIN
 UPDATE ci_cache_state SET generation=generation+1 WHERE repo_id=NEW.id;
END;
CREATE TRIGGER ci_cache_protection_insert AFTER INSERT ON branch_protections BEGIN
 UPDATE ci_cache_state SET generation=generation+1 WHERE repo_id=NEW.repo_id;
END;
CREATE TRIGGER ci_cache_protection_update AFTER UPDATE ON branch_protections BEGIN
 UPDATE ci_cache_state SET generation=generation+1 WHERE repo_id=NEW.repo_id;
END;
CREATE TRIGGER ci_cache_protection_delete AFTER DELETE ON branch_protections BEGIN
 UPDATE ci_cache_state SET generation=generation+1 WHERE repo_id=OLD.repo_id;
END;
