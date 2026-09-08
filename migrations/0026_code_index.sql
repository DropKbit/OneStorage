-- Ordinary tables keep the primary database compatible with D1 SQL export.
CREATE TABLE code_index_state (
 repo_id TEXT PRIMARY KEY REFERENCES repositories(id) ON DELETE CASCADE,
 requested INTEGER NOT NULL DEFAULT 1,
 completed INTEGER NOT NULL DEFAULT 0,
 force_rebuild INTEGER NOT NULL DEFAULT 0,
 gc_pending INTEGER NOT NULL DEFAULT 0,
 generation TEXT,
 indexed_sha TEXT,
 indexed_branch TEXT,
 indexed_at INTEGER,
 status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN('queued','indexing','ready','partial','failed')),
 build_generation TEXT,
 build_sha TEXT,
 build_branch TEXT,
 build_request INTEGER,
 cursor TEXT,
 files INTEGER NOT NULL DEFAULT 0,
 indexed_files INTEGER NOT NULL DEFAULT 0,
 skipped_files INTEGER NOT NULL DEFAULT 0,
 bytes INTEGER NOT NULL DEFAULT 0,
 postings INTEGER NOT NULL DEFAULT 0,
 coverage TEXT NOT NULL DEFAULT '{}',
 error TEXT,
 checked_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE code_documents (
 id TEXT PRIMARY KEY,
 repo_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
 generation TEXT NOT NULL,
 path TEXT NOT NULL,
 blob_sha TEXT NOT NULL,
 body TEXT NOT NULL,
 extension TEXT NOT NULL,
 UNIQUE(repo_id,generation,path)
);
CREATE INDEX code_documents_generation ON code_documents(repo_id,generation,id);
CREATE TABLE code_postings (
 gram TEXT NOT NULL,
 document_id TEXT NOT NULL REFERENCES code_documents(id) ON DELETE CASCADE,
 PRIMARY KEY(gram,document_id)
) WITHOUT ROWID;
CREATE INDEX code_postings_document ON code_postings(document_id);
CREATE TRIGGER code_index_new_project AFTER INSERT ON repositories WHEN NEW.deleted_at IS NULL BEGIN
 INSERT INTO code_index_state(repo_id) VALUES(NEW.id);
END;
CREATE TRIGGER code_index_default_branch AFTER UPDATE OF default_branch ON repositories WHEN OLD.default_branch!=NEW.default_branch BEGIN
 INSERT INTO code_index_state(repo_id) VALUES(NEW.id) ON CONFLICT(repo_id) DO UPDATE SET
 requested=requested+1,generation=NULL,indexed_sha=NULL,indexed_branch=NULL,indexed_at=NULL,status='queued';
END;
