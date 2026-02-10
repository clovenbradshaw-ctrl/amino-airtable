-- amino.table_registry
-- Authority table mapping Airtable tables to Matrix rooms.
-- One row per table. Populated during initial migration from room_map.json.
-- All queries should source table_name and matrix_room_id from this table,
-- never from the cached copies in amino.current_state.

CREATE TABLE IF NOT EXISTS amino.table_registry (
    table_id       TEXT PRIMARY KEY,          -- e.g. 'tbl0uHmtLkGyDnSP9'
    table_name     TEXT NOT NULL,
    matrix_room_id TEXT,                      -- e.g. '!OzrYatbNrrQYxrlVJA:app.aminoimmigration.com'
    primary_field  TEXT,
    field_count    INTEGER DEFAULT 0
);

-- Index for room-based lookups (Matrix sync → table resolution)
CREATE INDEX IF NOT EXISTS idx_table_registry_room
    ON amino.table_registry (matrix_room_id)
    WHERE matrix_room_id IS NOT NULL;

-- Tables created after migration that still need Matrix rooms:
--   tblvLcsDkANUc6eh1
--   tbltGtdKz7axVsm9p
--   tblCLhRbnU57CkRjv
-- Rooms must be created via the Synapse admin API and then
-- UPDATE amino.table_registry SET matrix_room_id = '!newRoom:...'
-- WHERE table_id = 'tblXXX';
