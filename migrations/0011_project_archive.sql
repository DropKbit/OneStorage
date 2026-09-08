-- Archived projects remain readable. Database guards close authorization/write races.

ALTER TABLE repositories ADD COLUMN archived_at TEXT;

ALTER TABLE repositories ADD COLUMN lifecycle_revision INTEGER NOT NULL DEFAULT 0;

CREATE TRIGGER archived_issues_insert BEFORE INSERT ON issues
WHEN EXISTS(SELECT 1 FROM repositories WHERE id=NEW.repo_id AND archived_at IS NOT NULL AND deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT,'Repository archived'); END;

CREATE TRIGGER archived_issues_update BEFORE UPDATE ON issues
WHEN EXISTS(SELECT 1 FROM repositories WHERE id=OLD.repo_id AND archived_at IS NOT NULL AND deleted_at IS NULL) OR EXISTS(SELECT 1 FROM repositories WHERE id=NEW.repo_id AND archived_at IS NOT NULL AND deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT,'Repository archived'); END;

CREATE TRIGGER archived_issues_delete BEFORE DELETE ON issues
WHEN EXISTS(SELECT 1 FROM repositories WHERE id=OLD.repo_id AND archived_at IS NOT NULL AND deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT,'Repository archived'); END;

CREATE TRIGGER archived_labels_insert BEFORE INSERT ON labels
WHEN EXISTS(SELECT 1 FROM repositories WHERE id=NEW.repo_id AND archived_at IS NOT NULL AND deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT,'Repository archived'); END;

CREATE TRIGGER archived_labels_update BEFORE UPDATE ON labels
WHEN EXISTS(SELECT 1 FROM repositories WHERE id=OLD.repo_id AND archived_at IS NOT NULL AND deleted_at IS NULL) OR EXISTS(SELECT 1 FROM repositories WHERE id=NEW.repo_id AND archived_at IS NOT NULL AND deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT,'Repository archived'); END;

CREATE TRIGGER archived_labels_delete BEFORE DELETE ON labels
WHEN EXISTS(SELECT 1 FROM repositories WHERE id=OLD.repo_id AND archived_at IS NOT NULL AND deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT,'Repository archived'); END;

CREATE TRIGGER archived_milestones_insert BEFORE INSERT ON milestones
WHEN EXISTS(SELECT 1 FROM repositories WHERE id=NEW.repo_id AND archived_at IS NOT NULL AND deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT,'Repository archived'); END;

CREATE TRIGGER archived_milestones_update BEFORE UPDATE ON milestones
WHEN EXISTS(SELECT 1 FROM repositories WHERE id=OLD.repo_id AND archived_at IS NOT NULL AND deleted_at IS NULL) OR EXISTS(SELECT 1 FROM repositories WHERE id=NEW.repo_id AND archived_at IS NOT NULL AND deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT,'Repository archived'); END;

CREATE TRIGGER archived_milestones_delete BEFORE DELETE ON milestones
WHEN EXISTS(SELECT 1 FROM repositories WHERE id=OLD.repo_id AND archived_at IS NOT NULL AND deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT,'Repository archived'); END;

CREATE TRIGGER archived_releases_insert BEFORE INSERT ON releases
WHEN EXISTS(SELECT 1 FROM repositories WHERE id=NEW.repo_id AND archived_at IS NOT NULL AND deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT,'Repository archived'); END;

CREATE TRIGGER archived_releases_update BEFORE UPDATE ON releases
WHEN EXISTS(SELECT 1 FROM repositories WHERE id=OLD.repo_id AND archived_at IS NOT NULL AND deleted_at IS NULL) OR EXISTS(SELECT 1 FROM repositories WHERE id=NEW.repo_id AND archived_at IS NOT NULL AND deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT,'Repository archived'); END;

CREATE TRIGGER archived_releases_delete BEFORE DELETE ON releases
WHEN EXISTS(SELECT 1 FROM repositories WHERE id=OLD.repo_id AND archived_at IS NOT NULL AND deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT,'Repository archived'); END;

CREATE TRIGGER archived_wiki_pages_insert BEFORE INSERT ON wiki_pages
WHEN EXISTS(SELECT 1 FROM repositories WHERE id=NEW.repo_id AND archived_at IS NOT NULL AND deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT,'Repository archived'); END;

CREATE TRIGGER archived_wiki_pages_update BEFORE UPDATE ON wiki_pages
WHEN EXISTS(SELECT 1 FROM repositories WHERE id=OLD.repo_id AND archived_at IS NOT NULL AND deleted_at IS NULL) OR EXISTS(SELECT 1 FROM repositories WHERE id=NEW.repo_id AND archived_at IS NOT NULL AND deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT,'Repository archived'); END;

CREATE TRIGGER archived_wiki_pages_delete BEFORE DELETE ON wiki_pages
WHEN EXISTS(SELECT 1 FROM repositories WHERE id=OLD.repo_id AND archived_at IS NOT NULL AND deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT,'Repository archived'); END;

CREATE TRIGGER archived_wiki_history_insert BEFORE INSERT ON wiki_history
WHEN EXISTS(SELECT 1 FROM repositories WHERE id=NEW.repo_id AND archived_at IS NOT NULL AND deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT,'Repository archived'); END;

CREATE TRIGGER archived_wiki_history_update BEFORE UPDATE ON wiki_history
WHEN EXISTS(SELECT 1 FROM repositories WHERE id=OLD.repo_id AND archived_at IS NOT NULL AND deleted_at IS NULL) OR EXISTS(SELECT 1 FROM repositories WHERE id=NEW.repo_id AND archived_at IS NOT NULL AND deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT,'Repository archived'); END;

CREATE TRIGGER archived_wiki_history_delete BEFORE DELETE ON wiki_history
WHEN EXISTS(SELECT 1 FROM repositories WHERE id=OLD.repo_id AND archived_at IS NOT NULL AND deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT,'Repository archived'); END;

CREATE TRIGGER archived_issue_boards_insert BEFORE INSERT ON issue_boards
WHEN EXISTS(SELECT 1 FROM repositories WHERE id=NEW.repo_id AND archived_at IS NOT NULL AND deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT,'Repository archived'); END;

CREATE TRIGGER archived_issue_boards_update BEFORE UPDATE ON issue_boards
WHEN EXISTS(SELECT 1 FROM repositories WHERE id=OLD.repo_id AND archived_at IS NOT NULL AND deleted_at IS NULL) OR EXISTS(SELECT 1 FROM repositories WHERE id=NEW.repo_id AND archived_at IS NOT NULL AND deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT,'Repository archived'); END;

CREATE TRIGGER archived_issue_boards_delete BEFORE DELETE ON issue_boards
WHEN EXISTS(SELECT 1 FROM repositories WHERE id=OLD.repo_id AND archived_at IS NOT NULL AND deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT,'Repository archived'); END;

CREATE TRIGGER archived_merge_requests_insert BEFORE INSERT ON merge_requests
WHEN EXISTS(SELECT 1 FROM repositories WHERE id=NEW.repo_id AND archived_at IS NOT NULL AND deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT,'Repository archived'); END;

CREATE TRIGGER archived_merge_requests_update BEFORE UPDATE ON merge_requests
WHEN EXISTS(SELECT 1 FROM repositories WHERE id=OLD.repo_id AND archived_at IS NOT NULL AND deleted_at IS NULL) OR EXISTS(SELECT 1 FROM repositories WHERE id=NEW.repo_id AND archived_at IS NOT NULL AND deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT,'Repository archived'); END;

CREATE TRIGGER archived_merge_requests_delete BEFORE DELETE ON merge_requests
WHEN EXISTS(SELECT 1 FROM repositories WHERE id=OLD.repo_id AND archived_at IS NOT NULL AND deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT,'Repository archived'); END;

CREATE TRIGGER archived_branch_protections_insert BEFORE INSERT ON branch_protections
WHEN EXISTS(SELECT 1 FROM repositories WHERE id=NEW.repo_id AND archived_at IS NOT NULL AND deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT,'Repository archived'); END;

CREATE TRIGGER archived_branch_protections_update BEFORE UPDATE ON branch_protections
WHEN EXISTS(SELECT 1 FROM repositories WHERE id=OLD.repo_id AND archived_at IS NOT NULL AND deleted_at IS NULL) OR EXISTS(SELECT 1 FROM repositories WHERE id=NEW.repo_id AND archived_at IS NOT NULL AND deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT,'Repository archived'); END;

CREATE TRIGGER archived_branch_protections_delete BEFORE DELETE ON branch_protections
WHEN EXISTS(SELECT 1 FROM repositories WHERE id=OLD.repo_id AND archived_at IS NOT NULL AND deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT,'Repository archived'); END;

CREATE TRIGGER archived_ci_pipelines_insert BEFORE INSERT ON ci_pipelines
WHEN EXISTS(SELECT 1 FROM repositories WHERE id=NEW.repo_id AND archived_at IS NOT NULL AND deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT,'Repository archived'); END;

CREATE TRIGGER archived_ci_pipelines_update BEFORE UPDATE ON ci_pipelines
WHEN EXISTS(SELECT 1 FROM repositories WHERE id=OLD.repo_id AND archived_at IS NOT NULL AND deleted_at IS NULL) OR EXISTS(SELECT 1 FROM repositories WHERE id=NEW.repo_id AND archived_at IS NOT NULL AND deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT,'Repository archived'); END;

CREATE TRIGGER archived_ci_pipelines_delete BEFORE DELETE ON ci_pipelines
WHEN EXISTS(SELECT 1 FROM repositories WHERE id=OLD.repo_id AND archived_at IS NOT NULL AND deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT,'Repository archived'); END;

CREATE TRIGGER archived_environments_insert BEFORE INSERT ON environments
WHEN EXISTS(SELECT 1 FROM repositories WHERE id=NEW.repo_id AND archived_at IS NOT NULL AND deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT,'Repository archived'); END;

CREATE TRIGGER archived_environments_update BEFORE UPDATE ON environments
WHEN EXISTS(SELECT 1 FROM repositories WHERE id=OLD.repo_id AND archived_at IS NOT NULL AND deleted_at IS NULL) OR EXISTS(SELECT 1 FROM repositories WHERE id=NEW.repo_id AND archived_at IS NOT NULL AND deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT,'Repository archived'); END;

CREATE TRIGGER archived_environments_delete BEFORE DELETE ON environments
WHEN EXISTS(SELECT 1 FROM repositories WHERE id=OLD.repo_id AND archived_at IS NOT NULL AND deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT,'Repository archived'); END;

CREATE TRIGGER archived_deployments_insert BEFORE INSERT ON deployments
WHEN EXISTS(SELECT 1 FROM repositories WHERE id=NEW.repo_id AND archived_at IS NOT NULL AND deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT,'Repository archived'); END;

CREATE TRIGGER archived_deployments_update BEFORE UPDATE ON deployments
WHEN EXISTS(SELECT 1 FROM repositories WHERE id=OLD.repo_id AND archived_at IS NOT NULL AND deleted_at IS NULL) OR EXISTS(SELECT 1 FROM repositories WHERE id=NEW.repo_id AND archived_at IS NOT NULL AND deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT,'Repository archived'); END;

CREATE TRIGGER archived_deployments_delete BEFORE DELETE ON deployments
WHEN EXISTS(SELECT 1 FROM repositories WHERE id=OLD.repo_id AND archived_at IS NOT NULL AND deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT,'Repository archived'); END;

CREATE TRIGGER archived_webhooks_insert BEFORE INSERT ON webhooks
WHEN EXISTS(SELECT 1 FROM repositories WHERE id=NEW.repo_id AND archived_at IS NOT NULL AND deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT,'Repository archived'); END;

CREATE TRIGGER archived_webhooks_update BEFORE UPDATE ON webhooks
WHEN EXISTS(SELECT 1 FROM repositories WHERE id=OLD.repo_id AND archived_at IS NOT NULL AND deleted_at IS NULL) OR EXISTS(SELECT 1 FROM repositories WHERE id=NEW.repo_id AND archived_at IS NOT NULL AND deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT,'Repository archived'); END;

CREATE TRIGGER archived_webhooks_delete BEFORE DELETE ON webhooks
WHEN EXISTS(SELECT 1 FROM repositories WHERE id=OLD.repo_id AND archived_at IS NOT NULL AND deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT,'Repository archived'); END;

CREATE TRIGGER archived_git_credentials_insert BEFORE INSERT ON git_credentials
WHEN EXISTS(SELECT 1 FROM repositories WHERE id=NEW.repo_id AND archived_at IS NOT NULL AND deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT,'Repository archived'); END;

CREATE TRIGGER archived_git_credentials_update BEFORE UPDATE ON git_credentials
WHEN EXISTS(SELECT 1 FROM repositories WHERE id=OLD.repo_id AND archived_at IS NOT NULL AND deleted_at IS NULL) OR EXISTS(SELECT 1 FROM repositories WHERE id=NEW.repo_id AND archived_at IS NOT NULL AND deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT,'Repository archived'); END;

CREATE TRIGGER archived_git_credentials_delete BEFORE DELETE ON git_credentials
WHEN EXISTS(SELECT 1 FROM repositories WHERE id=OLD.repo_id AND archived_at IS NOT NULL AND deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT,'Repository archived'); END;

CREATE TRIGGER archived_comments_insert BEFORE INSERT ON comments
WHEN EXISTS(SELECT 1 FROM repositories WHERE id=(SELECT repo_id FROM issues WHERE id=NEW.issue_id) AND archived_at IS NOT NULL AND deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT,'Repository archived'); END;

CREATE TRIGGER archived_comments_update BEFORE UPDATE ON comments
WHEN EXISTS(SELECT 1 FROM repositories WHERE id=(SELECT repo_id FROM issues WHERE id=OLD.issue_id) AND archived_at IS NOT NULL AND deleted_at IS NULL) OR EXISTS(SELECT 1 FROM repositories WHERE id=(SELECT repo_id FROM issues WHERE id=NEW.issue_id) AND archived_at IS NOT NULL AND deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT,'Repository archived'); END;

CREATE TRIGGER archived_comments_delete BEFORE DELETE ON comments
WHEN EXISTS(SELECT 1 FROM repositories WHERE id=(SELECT repo_id FROM issues WHERE id=OLD.issue_id) AND archived_at IS NOT NULL AND deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT,'Repository archived'); END;

CREATE TRIGGER archived_issue_labels_insert BEFORE INSERT ON issue_labels
WHEN EXISTS(SELECT 1 FROM repositories WHERE id=(SELECT repo_id FROM issues WHERE id=NEW.issue_id) AND archived_at IS NOT NULL AND deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT,'Repository archived'); END;

CREATE TRIGGER archived_issue_labels_update BEFORE UPDATE ON issue_labels
WHEN EXISTS(SELECT 1 FROM repositories WHERE id=(SELECT repo_id FROM issues WHERE id=OLD.issue_id) AND archived_at IS NOT NULL AND deleted_at IS NULL) OR EXISTS(SELECT 1 FROM repositories WHERE id=(SELECT repo_id FROM issues WHERE id=NEW.issue_id) AND archived_at IS NOT NULL AND deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT,'Repository archived'); END;

CREATE TRIGGER archived_issue_labels_delete BEFORE DELETE ON issue_labels
WHEN EXISTS(SELECT 1 FROM repositories WHERE id=(SELECT repo_id FROM issues WHERE id=OLD.issue_id) AND archived_at IS NOT NULL AND deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT,'Repository archived'); END;

CREATE TRIGGER archived_merge_reviews_insert BEFORE INSERT ON merge_reviews
WHEN EXISTS(SELECT 1 FROM repositories WHERE id=(SELECT repo_id FROM merge_requests WHERE id=NEW.mr_id) AND archived_at IS NOT NULL AND deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT,'Repository archived'); END;

CREATE TRIGGER archived_merge_reviews_update BEFORE UPDATE ON merge_reviews
WHEN EXISTS(SELECT 1 FROM repositories WHERE id=(SELECT repo_id FROM merge_requests WHERE id=OLD.mr_id) AND archived_at IS NOT NULL AND deleted_at IS NULL) OR EXISTS(SELECT 1 FROM repositories WHERE id=(SELECT repo_id FROM merge_requests WHERE id=NEW.mr_id) AND archived_at IS NOT NULL AND deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT,'Repository archived'); END;

CREATE TRIGGER archived_merge_reviews_delete BEFORE DELETE ON merge_reviews
WHEN EXISTS(SELECT 1 FROM repositories WHERE id=(SELECT repo_id FROM merge_requests WHERE id=OLD.mr_id) AND archived_at IS NOT NULL AND deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT,'Repository archived'); END;

CREATE TRIGGER archived_merge_discussions_insert BEFORE INSERT ON merge_discussions
WHEN EXISTS(SELECT 1 FROM repositories WHERE id=(SELECT repo_id FROM merge_requests WHERE id=NEW.mr_id) AND archived_at IS NOT NULL AND deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT,'Repository archived'); END;

CREATE TRIGGER archived_merge_discussions_update BEFORE UPDATE ON merge_discussions
WHEN EXISTS(SELECT 1 FROM repositories WHERE id=(SELECT repo_id FROM merge_requests WHERE id=OLD.mr_id) AND archived_at IS NOT NULL AND deleted_at IS NULL) OR EXISTS(SELECT 1 FROM repositories WHERE id=(SELECT repo_id FROM merge_requests WHERE id=NEW.mr_id) AND archived_at IS NOT NULL AND deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT,'Repository archived'); END;

CREATE TRIGGER archived_merge_discussions_delete BEFORE DELETE ON merge_discussions
WHEN EXISTS(SELECT 1 FROM repositories WHERE id=(SELECT repo_id FROM merge_requests WHERE id=OLD.mr_id) AND archived_at IS NOT NULL AND deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT,'Repository archived'); END;

CREATE TRIGGER archived_merge_discussion_comments_insert BEFORE INSERT ON merge_discussion_comments
WHEN EXISTS(SELECT 1 FROM repositories WHERE id=(SELECT m.repo_id FROM merge_requests m JOIN merge_discussions d ON d.mr_id=m.id WHERE d.id=NEW.discussion_id) AND archived_at IS NOT NULL AND deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT,'Repository archived'); END;

CREATE TRIGGER archived_merge_discussion_comments_update BEFORE UPDATE ON merge_discussion_comments
WHEN EXISTS(SELECT 1 FROM repositories WHERE id=(SELECT m.repo_id FROM merge_requests m JOIN merge_discussions d ON d.mr_id=m.id WHERE d.id=OLD.discussion_id) AND archived_at IS NOT NULL AND deleted_at IS NULL) OR EXISTS(SELECT 1 FROM repositories WHERE id=(SELECT m.repo_id FROM merge_requests m JOIN merge_discussions d ON d.mr_id=m.id WHERE d.id=NEW.discussion_id) AND archived_at IS NOT NULL AND deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT,'Repository archived'); END;

CREATE TRIGGER archived_merge_discussion_comments_delete BEFORE DELETE ON merge_discussion_comments
WHEN EXISTS(SELECT 1 FROM repositories WHERE id=(SELECT m.repo_id FROM merge_requests m JOIN merge_discussions d ON d.mr_id=m.id WHERE d.id=OLD.discussion_id) AND archived_at IS NOT NULL AND deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT,'Repository archived'); END;

CREATE TRIGGER archived_ci_artifacts_insert BEFORE INSERT ON ci_artifacts
WHEN EXISTS(SELECT 1 FROM repositories WHERE id=(SELECT repo_id FROM ci_runs WHERE id=NEW.run_id) AND archived_at IS NOT NULL AND deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT,'Repository archived'); END;

CREATE TRIGGER archived_ci_artifacts_update BEFORE UPDATE ON ci_artifacts
WHEN EXISTS(SELECT 1 FROM repositories WHERE id=(SELECT repo_id FROM ci_runs WHERE id=OLD.run_id) AND archived_at IS NOT NULL AND deleted_at IS NULL) OR EXISTS(SELECT 1 FROM repositories WHERE id=(SELECT repo_id FROM ci_runs WHERE id=NEW.run_id) AND archived_at IS NOT NULL AND deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT,'Repository archived'); END;

CREATE TRIGGER archived_ci_artifacts_delete BEFORE DELETE ON ci_artifacts
WHEN EXISTS(SELECT 1 FROM repositories WHERE id=(SELECT repo_id FROM ci_runs WHERE id=OLD.run_id) AND archived_at IS NOT NULL AND deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT,'Repository archived'); END;

CREATE TRIGGER archived_ci_logs_insert BEFORE INSERT ON ci_logs
WHEN EXISTS(SELECT 1 FROM repositories WHERE id=(SELECT repo_id FROM ci_runs WHERE id=NEW.run_id) AND archived_at IS NOT NULL AND deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT,'Repository archived'); END;

CREATE TRIGGER archived_ci_logs_update BEFORE UPDATE ON ci_logs
WHEN EXISTS(SELECT 1 FROM repositories WHERE id=(SELECT repo_id FROM ci_runs WHERE id=OLD.run_id) AND archived_at IS NOT NULL AND deleted_at IS NULL) OR EXISTS(SELECT 1 FROM repositories WHERE id=(SELECT repo_id FROM ci_runs WHERE id=NEW.run_id) AND archived_at IS NOT NULL AND deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT,'Repository archived'); END;

CREATE TRIGGER archived_ci_logs_delete BEFORE DELETE ON ci_logs
WHEN EXISTS(SELECT 1 FROM repositories WHERE id=(SELECT repo_id FROM ci_runs WHERE id=OLD.run_id) AND archived_at IS NOT NULL AND deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT,'Repository archived'); END;

CREATE TRIGGER archived_repository_settings BEFORE UPDATE OF description,visibility,default_branch,base_repo ON repositories WHEN OLD.archived_at IS NOT NULL AND NEW.deleted_at IS NULL BEGIN SELECT RAISE(ABORT,'Repository archived'); END;

CREATE TRIGGER archived_ci_enqueue BEFORE INSERT ON ci_runs WHEN EXISTS(SELECT 1 FROM repositories WHERE id=NEW.repo_id AND archived_at IS NOT NULL AND deleted_at IS NULL) BEGIN SELECT RAISE(ABORT,'Repository archived'); END;

CREATE TRIGGER archived_ci_update BEFORE UPDATE ON ci_runs WHEN NEW.status!='canceled' AND EXISTS(SELECT 1 FROM repositories WHERE id=NEW.repo_id AND archived_at IS NOT NULL AND deleted_at IS NULL) BEGIN SELECT RAISE(ABORT,'Repository archived'); END;

CREATE TRIGGER archived_sync_enqueue BEFORE INSERT ON sync_jobs WHEN EXISTS(SELECT 1 FROM repositories WHERE id=NEW.repo_id AND archived_at IS NOT NULL AND deleted_at IS NULL) BEGIN SELECT RAISE(ABORT,'Repository archived'); END;

CREATE TRIGGER archived_sync_update BEFORE UPDATE ON sync_jobs WHEN NEW.status!='cancelled' AND EXISTS(SELECT 1 FROM repositories WHERE id=NEW.repo_id AND archived_at IS NOT NULL AND deleted_at IS NULL) BEGIN SELECT RAISE(ABORT,'Repository archived'); END;
