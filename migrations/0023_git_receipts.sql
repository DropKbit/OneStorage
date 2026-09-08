-- Preserve the identity of a durable Git ref-publication event during retries.
-- Nullable for pre-existing audit records and other audit actions.
ALTER TABLE audit ADD COLUMN event_id TEXT;
CREATE UNIQUE INDEX audit_event_id ON audit(event_id);
