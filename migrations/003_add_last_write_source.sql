-- Migration: Add last_write_source to amino.current_state
-- Tracks whether the most recent write came from the amino client ('client')
-- or from the periodic Airtable sync ('airtable_sync'). Used by the
-- "Diff Against State" n8n node to skip echoes of client writes that
-- round-trip through Airtable back into the sync pipeline.

BEGIN;

ALTER TABLE amino.current_state
    ADD COLUMN IF NOT EXISTS last_write_source TEXT DEFAULT NULL;

COMMENT ON COLUMN amino.current_state.last_write_source IS
    'Source of last write: client = PATCH /write path, airtable_sync = periodic import. '
    'Used to suppress duplicate room events when a client write echoes through Airtable.';

COMMIT;
