CREATE TABLE password_recovery (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 version TEXT NOT NULL UNIQUE,
 hash TEXT NOT NULL,
 auth_epoch INTEGER NOT NULL,
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL
);
CREATE TRIGGER password_recovery_revoke AFTER UPDATE OF auth_epoch,has_password ON users
 WHEN NEW.auth_epoch != OLD.auth_epoch OR NEW.has_password=0 BEGIN
 DELETE FROM password_recovery WHERE user_id=NEW.id;
END;
