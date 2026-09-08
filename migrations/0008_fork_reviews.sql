ALTER TABLE merge_requests ADD COLUMN source_repo_id TEXT;
ALTER TABLE merge_requests ADD COLUMN source_namespace TEXT;
ALTER TABLE merge_requests ADD COLUMN source_name TEXT;
ALTER TABLE merge_requests ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE branch_protections ADD COLUMN require_resolved INTEGER NOT NULL DEFAULT 0 CHECK(require_resolved IN(0,1));
CREATE TABLE merge_discussions (id TEXT PRIMARY KEY, mr_id INTEGER NOT NULL REFERENCES merge_requests(id) ON DELETE CASCADE, author_id TEXT NOT NULL REFERENCES users(id), source_sha TEXT NOT NULL, target_sha TEXT NOT NULL, path TEXT, side TEXT CHECK(side IN('old','new')), line INTEGER CHECK(line>0), resolved INTEGER NOT NULL DEFAULT 0 CHECK(resolved IN(0,1)), resolved_by TEXT REFERENCES users(id), created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE merge_discussion_comments (id INTEGER PRIMARY KEY AUTOINCREMENT, discussion_id TEXT NOT NULL REFERENCES merge_discussions(id) ON DELETE CASCADE, author_id TEXT NOT NULL REFERENCES users(id), body TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX merge_discussions_request ON merge_discussions(mr_id,created_at);
CREATE INDEX merge_discussion_comments_thread ON merge_discussion_comments(discussion_id,id);
