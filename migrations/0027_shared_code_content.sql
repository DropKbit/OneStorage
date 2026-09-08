-- Keep legacy documents readable while each DO builds its first shared-content snapshot.
CREATE TABLE code_contents (
 id TEXT PRIMARY KEY,
 repo_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
 epoch TEXT NOT NULL,
 blob_sha TEXT NOT NULL,
 body TEXT NOT NULL,
 bytes INTEGER NOT NULL,
 grams INTEGER NOT NULL,
 UNIQUE(repo_id,epoch,blob_sha)
);
CREATE TABLE code_content_grams (
 gram TEXT NOT NULL,
 content_id TEXT NOT NULL REFERENCES code_contents(id) ON DELETE CASCADE,
 PRIMARY KEY(gram,content_id)
) WITHOUT ROWID;
CREATE INDEX code_content_grams_content ON code_content_grams(content_id);
ALTER TABLE code_documents ADD COLUMN content_id TEXT REFERENCES code_contents(id);
CREATE INDEX code_documents_content ON code_documents(content_id,generation,repo_id,path);
ALTER TABLE code_index_state ADD COLUMN index_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE code_index_state ADD COLUMN build_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE code_index_state ADD COLUMN content_epoch TEXT NOT NULL DEFAULT 'v34';
ALTER TABLE code_index_state ADD COLUMN build_epoch TEXT;
UPDATE code_index_state SET requested=requested+1,status='queued';
