ALTER TABLE branch_protections ADD COLUMN require_codeowners INTEGER NOT NULL DEFAULT 0 CHECK(require_codeowners IN (0,1));
-- One projection per issue/merge ensures recovery never closes a manually reopened issue again.
CREATE TABLE merge_issue_closures (
  mr_id INTEGER NOT NULL REFERENCES merge_requests(id) ON DELETE CASCADE,
  issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  sha TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(mr_id,issue_id)
);
ALTER TABLE merge_issue_closures ADD COLUMN actor_id TEXT REFERENCES users(id);
CREATE TRIGGER merge_issue_close AFTER INSERT ON merge_issue_closures
WHEN (SELECT state FROM issues WHERE id=new.issue_id)='open'
BEGIN
  INSERT INTO comments(issue_id,author_id,body) VALUES(new.issue_id,new.actor_id,'Closed by merge request !'||new.mr_id||' ('||new.sha||').');
  INSERT INTO audit(repo_id,actor_id,action,detail) SELECT repo_id,new.actor_id,'issue.merge_close','#'||new.issue_id||' via !'||new.mr_id FROM issues WHERE id=new.issue_id;
  UPDATE issues SET state='closed' WHERE id=new.issue_id;
END;
