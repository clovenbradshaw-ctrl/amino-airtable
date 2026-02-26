-- Migration 004: Create user_preferences table for CRM interface preferences
-- EO Classification: GIVEN — user-entered configuration data
-- Storage: Per-user preferences persisted server-side for cross-device sync.
-- Complements client-side IndexedDB + Matrix account data storage.
-- Provenance: All preference mutations are user-initiated (EO GIVEN operator).

CREATE TABLE IF NOT EXISTS amino.user_preferences (
    user_id         TEXT NOT NULL,           -- Matrix userId (@user:homeserver)
    preference_key  TEXT NOT NULL,           -- Namespaced key (e.g., 'crm.defaultPage', 'crm.favoriteClients')
    preference_value JSONB NOT NULL DEFAULT '{}'::jsonb,  -- Preference value (any JSON-serializable type)
    eo_operator     TEXT NOT NULL DEFAULT 'GIVEN',        -- EO operator: GIVEN for user-entered, DERIVED for computed
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, preference_key)
);

-- Index for fast lookups by user
CREATE INDEX IF NOT EXISTS idx_user_preferences_user_id
    ON amino.user_preferences(user_id);

-- Index for finding all users with a specific preference
CREATE INDEX IF NOT EXISTS idx_user_preferences_key
    ON amino.user_preferences(preference_key);

-- Trigger to auto-update updated_at on modification
CREATE OR REPLACE FUNCTION amino.update_user_preferences_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_user_preferences_updated ON amino.user_preferences;
CREATE TRIGGER trg_user_preferences_updated
    BEFORE UPDATE ON amino.user_preferences
    FOR EACH ROW
    EXECUTE FUNCTION amino.update_user_preferences_timestamp();

COMMENT ON TABLE amino.user_preferences IS 'Per-user CRM interface preferences. EO: GIVEN (user-entered configuration). Synced to client via Matrix account data and IndexedDB.';
COMMENT ON COLUMN amino.user_preferences.eo_operator IS 'Epistemic-Ontological operator: GIVEN = user-entered data, DERIVED = system-computed defaults';
