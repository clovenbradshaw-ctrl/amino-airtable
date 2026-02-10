-- Migration: Create amino.table_registry
-- The table_registry is the authority on which Airtable table maps to which
-- Matrix room. One row per table. matrix_room_id and table_name should always
-- be read from here, never from current_state (which is a cache).
--
-- Run this migration once against the Amino State DB.

BEGIN;

-- Ensure schema exists
CREATE SCHEMA IF NOT EXISTS amino;

-- Create the registry table
CREATE TABLE IF NOT EXISTS amino.table_registry (
    table_id     TEXT PRIMARY KEY,          -- e.g. 'tbl0uHmtLkGyDnSP9'
    table_name   TEXT NOT NULL DEFAULT '',
    matrix_room_id TEXT,                    -- e.g. '!OzrYatbNrrQYxrlVJA:app.aminoimmigration.com'
    primary_field TEXT,                     -- name of the primary field in Airtable
    field_count  INTEGER DEFAULT 0
);

-- Seed from current_state: pull every distinct table that has a non-empty
-- table_name and matrix_room_id. This captures all tables that were part of
-- the original room_map.json migration.
INSERT INTO amino.table_registry (table_id, table_name, matrix_room_id)
SELECT DISTINCT ON (table_id)
    table_id,
    table_name,
    matrix_room_id
FROM amino.current_state
WHERE table_name != ''
  AND table_id IS NOT NULL
ORDER BY table_id, last_synced_at DESC
ON CONFLICT (table_id) DO NOTHING;

-- Also insert any tables that exist in current_state but have empty names
-- (they'll get table_name filled in later or manually).
INSERT INTO amino.table_registry (table_id)
SELECT DISTINCT table_id
FROM amino.current_state
WHERE table_id IS NOT NULL
  AND table_id NOT IN (SELECT table_id FROM amino.table_registry)
ON CONFLICT (table_id) DO NOTHING;

COMMIT;
