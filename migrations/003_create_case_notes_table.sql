-- Migration: Create amino.case_notes table
--
-- Adds a first-class relational table for Case Notes data so the notes
-- exist as a dedicated database table in addition to the generic
-- amino.current_state cache.
--
-- Run this migration once after 001_create_table_registry.sql.

BEGIN;

CREATE SCHEMA IF NOT EXISTS amino;

CREATE TABLE IF NOT EXISTS amino.case_notes (
    id                  BIGSERIAL PRIMARY KEY,
    airtable_record_id  TEXT NOT NULL UNIQUE,
    client_airtable_id  TEXT,
    activity            TEXT,
    type                TEXT,
    note_date           DATE,
    description         TEXT,
    contact             TEXT,
    matter_id           TEXT,
    due_date            DATE,
    source              TEXT,
    tags                JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_by          TEXT,
    last_update_by      TEXT,
    fields              JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_case_notes_client_airtable_id
    ON amino.case_notes (client_airtable_id);

CREATE INDEX IF NOT EXISTS idx_case_notes_note_date
    ON amino.case_notes (note_date DESC);

-- Backfill from the generic current_state cache for whichever table in
-- table_registry is named like "Case Note(s)".
INSERT INTO amino.case_notes (
    airtable_record_id,
    client_airtable_id,
    activity,
    type,
    note_date,
    description,
    contact,
    matter_id,
    due_date,
    source,
    tags,
    created_by,
    last_update_by,
    fields,
    updated_at
)
SELECT
    cs.record_id,
    cs.fields->>'client_airtable_id',
    cs.fields->>'Activity',
    cs.fields->>'Type',
    NULLIF(cs.fields->>'Date', '')::date,
    cs.fields->>'Description',
    cs.fields->>'Contact',
    cs.fields->>'matter_id',
    NULLIF(cs.fields->>'Due_Date', '')::date,
    cs.fields->>'source',
    COALESCE(cs.fields->'tags', '[]'::jsonb),
    cs.fields->>'Created_By',
    cs.fields->>'Last_Update_By',
    cs.fields,
    cs.last_synced_at
FROM amino.current_state cs
JOIN amino.table_registry tr
    ON tr.table_id = cs.table_id
WHERE lower(tr.table_name) LIKE '%case note%'
ON CONFLICT (airtable_record_id) DO UPDATE
SET
    client_airtable_id = EXCLUDED.client_airtable_id,
    activity = EXCLUDED.activity,
    type = EXCLUDED.type,
    note_date = EXCLUDED.note_date,
    description = EXCLUDED.description,
    contact = EXCLUDED.contact,
    matter_id = EXCLUDED.matter_id,
    due_date = EXCLUDED.due_date,
    source = EXCLUDED.source,
    tags = EXCLUDED.tags,
    created_by = EXCLUDED.created_by,
    last_update_by = EXCLUDED.last_update_by,
    fields = EXCLUDED.fields,
    updated_at = EXCLUDED.updated_at;

COMMIT;
