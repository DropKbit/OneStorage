CREATE TABLE repository_aliases (
 namespace TEXT NOT NULL COLLATE NOCASE,
 name TEXT NOT NULL COLLATE NOCASE,
 repo_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
 created_at TEXT NOT NULL DEFAULT (datetime('now')),
 PRIMARY KEY(namespace,name)
);
CREATE INDEX repository_aliases_repo ON repository_aliases(repo_id);
CREATE TRIGGER repository_alias_reserved BEFORE INSERT ON repositories
WHEN EXISTS(SELECT 1 FROM repository_aliases WHERE namespace=NEW.namespace AND name=NEW.name)
BEGIN SELECT RAISE(ABORT,'Repository address reserved'); END;
CREATE TRIGGER repository_alias_update_reserved BEFORE UPDATE OF namespace,name ON repositories
WHEN EXISTS(SELECT 1 FROM repository_aliases WHERE namespace=NEW.namespace AND name=NEW.name AND repo_id!=NEW.id)
BEGIN SELECT RAISE(ABORT,'Repository address reserved'); END;

ALTER TABLE sync_jobs ADD COLUMN lifecycle_revision INTEGER NOT NULL DEFAULT 0;
UPDATE sync_jobs SET lifecycle_revision=COALESCE((SELECT lifecycle_revision FROM repositories WHERE id=sync_jobs.repo_id),0);
