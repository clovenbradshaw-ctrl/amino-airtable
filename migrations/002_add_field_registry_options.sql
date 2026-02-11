-- Migration: Add field_registry table and options column for formula support
--
-- Creates amino.field_registry if it doesn't exist, and ensures the
-- options JSONB column is present for storing formula definitions,
-- rollup aggregation formulas, and lookup field references.
--
-- The n8n schema sync workflow populates this from the Airtable metadata API:
--   formula fields:  options = { "formula": "DATETIME_DIFF(...)", "result": { "type": "number", ... } }
--   rollup fields:   options = { "fieldIdInLinkedTable": "fldXYZ", "recordLinkFieldId": "fldABC",
--                                "formula": "SUM(values)", "result": { "type": "number" } }
--   lookup fields:   options = { "fieldIdInLinkedTable": "fldXYZ", "recordLinkFieldId": "fldABC",
--                                "result": { "type": "singleLineText" } }
--
-- Run this migration once against the Amino State DB, after 001_create_table_registry.sql.

BEGIN;

-- Ensure schema exists
CREATE SCHEMA IF NOT EXISTS amino;

-- Create field_registry table if it doesn't exist
CREATE TABLE IF NOT EXISTS amino.field_registry (
    field_id      TEXT NOT NULL,              -- e.g. 'fldQISjoK6v8pkoB3'
    table_id      TEXT NOT NULL,              -- e.g. 'tbl0uHmtLkGyDnSP9'
    field_name    TEXT NOT NULL DEFAULT '',
    field_type    TEXT NOT NULL DEFAULT '',    -- e.g. 'formula', 'rollup', 'lookup', 'singleLineText'
    is_computed   BOOLEAN NOT NULL DEFAULT FALSE,
    is_excluded   BOOLEAN NOT NULL DEFAULT FALSE,
    options       JSONB NOT NULL DEFAULT '{}',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (field_id, table_id)
);

-- Add options column if it doesn't already exist (idempotent for existing tables)
ALTER TABLE amino.field_registry
    ADD COLUMN IF NOT EXISTS options JSONB NOT NULL DEFAULT '{}';

-- Add is_computed column if it doesn't already exist
ALTER TABLE amino.field_registry
    ADD COLUMN IF NOT EXISTS is_computed BOOLEAN NOT NULL DEFAULT FALSE;

-- Index for quick lookup of computed fields per table
CREATE INDEX IF NOT EXISTS idx_field_registry_computed
    ON amino.field_registry (table_id, is_computed)
    WHERE is_computed = true;

-- Index for quick lookup by table_id
CREATE INDEX IF NOT EXISTS idx_field_registry_table_id
    ON amino.field_registry (table_id);

-- Update is_computed for existing rows based on field_type
UPDATE amino.field_registry
SET is_computed = TRUE
WHERE field_type IN ('formula', 'rollup', 'lookup', 'count',
                     'autoNumber', 'createdTime', 'lastModifiedTime',
                     'createdBy', 'lastModifiedBy')
  AND is_computed = FALSE;

COMMIT;
