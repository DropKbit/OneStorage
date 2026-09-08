CREATE TABLE package_versions (
 id TEXT PRIMARY KEY, repo_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('generic','npm')), name TEXT NOT NULL, version TEXT NOT NULL,
 metadata TEXT NOT NULL DEFAULT '{}', publisher_id TEXT NOT NULL REFERENCES users(id),
 created_at INTEGER NOT NULL, deleted_at INTEGER,
 UNIQUE(repo_id,kind,name,version)
);
CREATE INDEX package_versions_page ON package_versions(repo_id,created_at,id);
CREATE TABLE package_catalog (
 repo_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
 name TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(repo_id,name)
);
CREATE TABLE package_files (
 id TEXT PRIMARY KEY, version_id TEXT NOT NULL REFERENCES package_versions(id) ON DELETE CASCADE,
 filename TEXT NOT NULL, object_key TEXT NOT NULL UNIQUE, size INTEGER NOT NULL,
 sha256 TEXT NOT NULL, sha512 TEXT, sha1 TEXT, created_at INTEGER NOT NULL,
 deleted_at INTEGER, UNIQUE(version_id,filename)
);
CREATE TABLE package_tags (
 repo_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
 name TEXT NOT NULL, tag TEXT NOT NULL, version_id TEXT NOT NULL REFERENCES package_versions(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(repo_id,name,tag)
);
-- This independent upload/GC inventory survives repository deletion. Its immutable
-- object keys cannot be shared with another upload or published version.
CREATE TABLE package_uploads (
 id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL,
 version TEXT NOT NULL, filename TEXT NOT NULL, object_key TEXT NOT NULL UNIQUE,
 size INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('uploading','published','retired')),
 created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, retire_after INTEGER, last_gc INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX package_upload_slot ON package_uploads(repo_id,kind,name,version,filename) WHERE state='uploading';
CREATE INDEX package_upload_gc ON package_uploads(state,expires_at,retire_after);
CREATE TRIGGER package_catalog_publish AFTER INSERT ON package_versions WHEN NEW.kind='npm'
BEGIN
 INSERT INTO package_catalog(repo_id,name) VALUES(NEW.repo_id,NEW.name)
 ON CONFLICT(repo_id,name) DO UPDATE SET revision=package_catalog.revision+1;
END;
CREATE TRIGGER package_catalog_retire AFTER UPDATE OF deleted_at ON package_versions WHEN NEW.kind='npm'
BEGIN
 UPDATE package_catalog SET revision=revision+1 WHERE repo_id=NEW.repo_id AND name=NEW.name;
END;
CREATE TRIGGER package_catalog_tag_insert AFTER INSERT ON package_tags
BEGIN
 UPDATE package_catalog SET revision=revision+1 WHERE repo_id=NEW.repo_id AND name=NEW.name;
END;
CREATE TRIGGER package_catalog_tag_update AFTER UPDATE ON package_tags
BEGIN
 UPDATE package_catalog SET revision=revision+1 WHERE repo_id=NEW.repo_id AND name=NEW.name;
END;
CREATE TRIGGER package_catalog_tag_delete AFTER DELETE ON package_tags
BEGIN
 UPDATE package_catalog SET revision=revision+1 WHERE repo_id=OLD.repo_id AND name=OLD.name;
END;
CREATE TRIGGER package_version_delete_tags AFTER UPDATE OF deleted_at ON package_versions
WHEN NEW.deleted_at IS NOT NULL
BEGIN
 DELETE FROM package_tags WHERE version_id=NEW.id;
 UPDATE package_files SET deleted_at=COALESCE(deleted_at,NEW.deleted_at) WHERE version_id=NEW.id;
END;
CREATE TRIGGER package_file_retire AFTER UPDATE OF deleted_at ON package_files
WHEN NEW.deleted_at IS NOT NULL
BEGIN
 UPDATE package_uploads SET state='retired',retire_after=NEW.deleted_at WHERE id=NEW.id;
END;
CREATE TRIGGER package_file_remove BEFORE DELETE ON package_files
BEGIN
 UPDATE package_uploads SET state='retired',retire_after=CAST(unixepoch('now') AS INTEGER)*1000 WHERE id=OLD.id;
END;
