-- Runner revocation remains possible while archived; new credentials cannot be registered.
CREATE TRIGGER archived_runner_registration BEFORE INSERT ON ci_runners
WHEN EXISTS(SELECT 1 FROM repositories WHERE id=NEW.repo_id AND archived_at IS NOT NULL AND deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT,'Repository archived'); END;
