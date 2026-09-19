-- Vectors never authorize access. Search always joins current D1 visibility and snapshots.
CREATE TABLE semantic_settings (
 id INTEGER PRIMARY KEY CHECK(id=1),
 enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN(0,1)),
 daily_chars INTEGER NOT NULL DEFAULT 5000000 CHECK(daily_chars BETWEEN 1000 AND 50000000)
);
INSERT INTO semantic_settings(id) VALUES(1);
CREATE TABLE semantic_usage (
 day TEXT PRIMARY KEY,
 index_chars INTEGER NOT NULL DEFAULT 0,
 query_chars INTEGER NOT NULL DEFAULT 0,
 index_requests INTEGER NOT NULL DEFAULT 0,
 query_requests INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE semantic_rate (actor TEXT PRIMARY KEY, window INTEGER NOT NULL, count INTEGER NOT NULL);
CREATE TABLE semantic_state (
 repo_id TEXT PRIMARY KEY,
 generation TEXT,
 cursor_blob TEXT NOT NULL DEFAULT '',
 chunk_offset INTEGER NOT NULL DEFAULT 0,
 chunks INTEGER NOT NULL DEFAULT 0,
 skipped INTEGER NOT NULL DEFAULT 0,
 status TEXT NOT NULL DEFAULT 'queued',
 lease TEXT,
 lease_until INTEGER NOT NULL DEFAULT 0,
 checked_at INTEGER NOT NULL DEFAULT 0,
 retry_at INTEGER NOT NULL DEFAULT 0,
 error TEXT
);
-- Deliberately no FK: external vectors must still be collected after repository deletion.
CREATE TABLE semantic_chunks (
 id TEXT PRIMARY KEY,
 repo_id TEXT NOT NULL,
 blob_sha TEXT NOT NULL,
 chunk INTEGER NOT NULL,
 line INTEGER NOT NULL,
 end_line INTEGER NOT NULL,
 body TEXT NOT NULL,
 ready INTEGER NOT NULL DEFAULT 0,
 touched_at INTEGER NOT NULL,
 UNIQUE(repo_id,blob_sha,chunk)
);
CREATE INDEX semantic_chunks_blob ON semantic_chunks(repo_id,blob_sha);
CREATE INDEX semantic_chunks_gc ON semantic_chunks(touched_at,id);
CREATE INDEX code_documents_blob ON code_documents(repo_id,blob_sha,generation);
