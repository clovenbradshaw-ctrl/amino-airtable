// ============================================================================
// Amino Client Data Layer
// Treats IndexedDB as the primary read source, and uses n8n webhook APIs
// only to backfill/sync local state so the on-device mirror stays current.
// Stores data in IndexedDB encrypted at rest (AES-GCM), keeps data in sync
// via HTTP polling against Postgres. Matrix is used for auth, views, messaging,
// and org config — not for record data sync.
// ============================================================================

var AminoData = (function() {
    'use strict';

    // ============ Constants ============
    var WEBHOOK_BASE_URL = 'https://n8n.intelechia.com/webhook';
    var DB_NAME = 'amino-data-layer';
    var DB_VERSION = 2;
    var DEFAULT_POLL_INTERVAL = 15000; // 15 seconds
    var SYNAPSE_SALT_PREFIX = 'amino-local-encrypt:';
    var ENCRYPTION_ALGORITHM = 'aes-gcm-256';
    var AIRTABLE_SYNC_WEBHOOK = 'https://n8n.intelechia.com/webhook/c875f674-9228-45ae-b6ec-10870df8a403';
    var BOX_DOWNLOAD_WEBHOOK = 'https://n8n.intelechia.com/webhook/box-download';
    var AIRTABLE_SYNC_COOLDOWN = 180000; // 180 seconds (3 min) minimum between triggers
    var CONNECTIVITY_CHECK_INTERVAL = 30000; // 30 seconds
    var DEFAULT_OFFLINE_ACCESS_MAX_DAYS = 30; // configurable per org

    // ============ Internal State (memory only) ============
    var _db = null;
    var _cryptoKey = null;
    var _accessToken = null;
    var _userId = null;
    var _pollInterval = null;
    var _tableIds = [];
    var _offlineMode = false;
    var _onlineOnlyMode = false;     // when true, skip IndexedDB reads/writes — always fetch from API
    var _connectivityCheckTimer = null;
    var _tables = [];
    var _initialized = false;
    var _lastAirtableSyncTrigger = 0;
    var _airtableSyncInFlight = false;
    var _orgSpaceId = null;           // org space room ID for view deletion monitoring
    var _viewSyncRunning = false;
    var _viewSyncAbort = null;
    var _recordCacheById = {};       // recordId -> decrypted record
    var _tableRecordIdIndex = {};    // tableId -> { recordId: true }
    var _tableCacheHydrated = {};    // tableId -> true when full table is cached
    var _keyDerivationCache = { fingerprint: null, key: null };
    var _deferEncryption = false;        // when true, IndexedDB stores plaintext JSON (encrypt on logout)

    // ============ Sync Deduplication ============
    // Delegated to AminoHydration module. See hydration.js for implementation.
    // These thin wrappers maintain the internal API surface.

    // ============ Search Index (Pre-built for fast local search) ============
    // Maps recordId -> lowercased concatenated searchable text.
    // Built lazily per-table when first searched, invalidated on record updates.
    var _searchIndex = {};           // recordId -> lowercased searchable string
    var _searchIndexVersion = 0;     // bumped on any index change so UI can detect staleness

    // ============ Encryption ============

    async function deriveKey(password, salt) {
        var encoder = new TextEncoder();
        var keyMaterial = await crypto.subtle.importKey(
            'raw',
            encoder.encode(password),
            'PBKDF2',
            false,
            ['deriveKey']
        );

        return crypto.subtle.deriveKey(
            {
                name: 'PBKDF2',
                salt: salt,
                iterations: 600000, // OWASP 2023 recommendation
                hash: 'SHA-256'
            },
            keyMaterial,
            { name: 'AES-GCM', length: 256 },
            true, // extractable — allows key export for sub-page access
            ['encrypt', 'decrypt']
        );
    }

    async function encrypt(key, plaintext) {
        var encoder = new TextEncoder();
        var iv = crypto.getRandomValues(new Uint8Array(12)); // 96-bit IV for AES-GCM
        var ciphertext = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv: iv },
            key,
            encoder.encode(plaintext)
        );
        // Return IV + ciphertext as a single ArrayBuffer
        var result = new Uint8Array(iv.length + ciphertext.byteLength);
        result.set(iv, 0);
        result.set(new Uint8Array(ciphertext), iv.length);
        return result.buffer;
    }

    async function decrypt(key, encryptedBuffer) {
        var data = new Uint8Array(encryptedBuffer);
        var iv = data.slice(0, 12);
        var ciphertext = data.slice(12);
        var decrypted = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: iv },
            key,
            ciphertext
        );
        return new TextDecoder().decode(decrypted);
    }

    // ============ Synapse-Derived Encryption ============

    // Derive encryption key from Synapse password + userId (deterministic salt).
    // This ties the encryption directly to the authenticated Synapse user —
    // different users get different keys, and re-login regenerates the same key.
    async function deriveSynapseKey(password, userId) {
        var fingerprint = userId + '::' + password;
        if (_keyDerivationCache.fingerprint === fingerprint && _keyDerivationCache.key) {
            return _keyDerivationCache.key;
        }

        var encoder = new TextEncoder();
        var salt = encoder.encode(SYNAPSE_SALT_PREFIX + userId);
        var key = await deriveKey(password, salt);
        _keyDerivationCache = { fingerprint: fingerprint, key: key };
        return key;
    }

    // ============ Key Storage (for sub-page access) ============
    // Sub-pages (layout builder, client profile) cannot derive the key because
    // the Synapse password is intentionally not stored. Instead, the main app
    // derives and exports the key to localStorage so sub-pages can import it.

    var DATA_LAYER_KEY_STORAGE = 'amino_data_layer_key';

    async function exportKeyToStorage(key) {
        try {
            var raw = await crypto.subtle.exportKey('raw', key);
            localStorage.setItem(DATA_LAYER_KEY_STORAGE, arrayBufferToBase64(raw));
        } catch (e) {
            console.warn('[AminoData] Could not export key to storage:', e);
        }
    }

    async function importKeyFromStorage() {
        var stored = localStorage.getItem(DATA_LAYER_KEY_STORAGE);
        if (!stored) return null;
        try {
            var raw = base64ToArrayBuffer(stored);
            return crypto.subtle.importKey(
                'raw', raw, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']
            );
        } catch (e) {
            console.warn('[AminoData] Could not import key from storage:', e);
            localStorage.removeItem(DATA_LAYER_KEY_STORAGE);
            return null;
        }
    }

    function clearKeyFromStorage() {
        localStorage.removeItem(DATA_LAYER_KEY_STORAGE);
    }

    // ============ Base64 <-> ArrayBuffer Helpers ============

    function arrayBufferToBase64(buffer) {
        var bytes = new Uint8Array(buffer);
        var binary = '';
        for (var i = 0; i < bytes.length; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    }

    function base64ToArrayBuffer(base64) {
        var binary = atob(base64);
        var bytes = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes.buffer;
    }

    // ============ Event Payload Encryption (for reading historical room data) ============

    // Decrypt an encrypted event payload back to a fields object.
    async function decryptEventPayload(encryptedContent) {
        if (!_cryptoKey) throw new Error('Encryption key not initialized');
        var buffer = base64ToArrayBuffer(encryptedContent._ciphertext);
        return JSON.parse(await decrypt(_cryptoKey, buffer));
    }

    // Check whether an event content object is encrypted.
    function isEncryptedPayload(content) {
        return content && content._encrypted === true && typeof content._ciphertext === 'string';
    }

    // ============ Encryption Verification Token ============

    // Create a verification token so we can detect if the derived key changes
    // (e.g. user changed their Synapse password). The token is the encryption
    // of a known plaintext with the current key.
    var VERIFICATION_PLAINTEXT = 'amino-encryption-verify';

    async function createVerificationToken(key) {
        var encrypted = await encrypt(key, VERIFICATION_PLAINTEXT);
        return arrayBufferToBase64(encrypted);
    }

    async function verifyEncryptionKey(key, token) {
        try {
            var buffer = base64ToArrayBuffer(token);
            var decrypted = await decrypt(key, buffer);
            return decrypted === VERIFICATION_PLAINTEXT;
        } catch (e) {
            return false;
        }
    }

    // ============ Encryption Migration ============

    // Re-encrypt all IndexedDB records from oldKey to newKey.
    async function migrateEncryptionKey(oldKey, newKey) {
        var tx = _db.transaction('records', 'readonly');
        var store = tx.objectStore('records');
        var allRecords = await idbGetAll(store);

        if (allRecords.length === 0) return 0;

        // Check if records are plaintext (left unencrypted from a previous
        // deferred-encryption session crash). If so, they don't need key
        // migration — they'll be handled by the new session's deferred mode.
        if (typeof allRecords[0].fields === 'string') {
            console.log('[AminoData] Records are plaintext (deferred-encryption crash recovery), no key migration needed');
            return 0;
        }

        // Verify oldKey can decrypt the data
        try {
            await decrypt(oldKey, allRecords[0].fields);
        } catch (e) {
            // Old key doesn't work — check if data is already on the new key
            try {
                await decrypt(newKey, allRecords[0].fields);
                console.log('[AminoData] Data already encrypted with new key, no migration needed');
                return 0;
            } catch (e2) {
                console.warn('[AminoData] Neither key decrypts existing data — re-hydration required');
                return -1;
            }
        }

        console.log('[AminoData] Migrating', allRecords.length, 'records to Synapse-derived encryption');
        var BATCH_SIZE = 200;
        var migrated = 0;
        for (var b = 0; b < allRecords.length; b += BATCH_SIZE) {
            var batch = allRecords.slice(b, b + BATCH_SIZE);
            var writeTx = _db.transaction('records', 'readwrite');
            var writeStore = writeTx.objectStore('records');

            for (var i = 0; i < batch.length; i++) {
                var entry = batch[i];
                var plaintext = await decrypt(oldKey, entry.fields);
                entry.fields = await encrypt(newKey, plaintext);
                await idbPut(writeStore, entry);
                migrated++;
            }
            await idbTxDone(writeTx);
        }
        console.log('[AminoData] Migration complete:', migrated, 'records re-encrypted');
        return migrated;
    }

    // ============ Database ============

    async function openDatabase() {
        return new Promise(function(resolve, reject) {
            var request = indexedDB.open(DB_NAME, DB_VERSION);

            request.onupgradeneeded = function(event) {
                var db = event.target.result;

                // Records store — one entry per Airtable record
                if (!db.objectStoreNames.contains('records')) {
                    var recordStore = db.createObjectStore('records', { keyPath: 'id' });
                    recordStore.createIndex('byTable', 'tableId', { unique: false });
                    recordStore.createIndex('byLastSynced', 'lastSynced', { unique: false });
                }

                // Tables store — metadata about each table
                if (!db.objectStoreNames.contains('tables')) {
                    db.createObjectStore('tables', { keyPath: 'table_id' });
                }

                // Sync metadata — tracks last sync time per table
                if (!db.objectStoreNames.contains('sync')) {
                    db.createObjectStore('sync', { keyPath: 'tableId' });
                }

                // Crypto store — stores the salt (unencrypted)
                if (!db.objectStoreNames.contains('crypto')) {
                    db.createObjectStore('crypto', { keyPath: 'key' });
                }

                // Pending mutations store — queued writes created while offline
                if (!db.objectStoreNames.contains('pending_mutations')) {
                    var mutStore = db.createObjectStore('pending_mutations', { keyPath: 'id' });
                    mutStore.createIndex('byTable', 'tableId', { unique: false });
                    mutStore.createIndex('byStatus', 'status', { unique: false });
                    mutStore.createIndex('byTimestamp', 'timestamp', { unique: false });
                }
            };

            request.onsuccess = function(event) {
                resolve(event.target.result);
            };

            request.onerror = function(event) {
                reject(new Error('Failed to open IndexedDB: ' + event.target.error));
            };
        });
    }

    // IDB transaction helpers (promise-based wrappers)

    function idbPut(store, value) {
        return new Promise(function(resolve, reject) {
            var request = store.put(value);
            request.onsuccess = function() { resolve(request.result); };
            request.onerror = function() { reject(request.error); };
        });
    }

    function idbGet(store, key) {
        return new Promise(function(resolve, reject) {
            var request = store.get(key);
            request.onsuccess = function() { resolve(request.result); };
            request.onerror = function() { reject(request.error); };
        });
    }

    function idbGetAll(index, query) {
        return new Promise(function(resolve, reject) {
            var request = query !== undefined ? index.getAll(query) : index.getAll();
            request.onsuccess = function() { resolve(request.result); };
            request.onerror = function() { reject(request.error); };
        });
    }

    function idbTxDone(tx) {
        return new Promise(function(resolve, reject) {
            tx.oncomplete = function() { resolve(); };
            tx.onerror = function() { reject(tx.error); };
            tx.onabort = function() { reject(tx.error || new Error('Transaction aborted')); };
        });
    }

    // ============ Sync Dedup Helpers ============
    // Delegated to AminoHydration module — thin wrappers for internal use.

    function _trackOptimisticWrite(recordId, changedFields) {
        AminoHydration.trackOptimisticWrite(recordId, changedFields);
    }

    // ============ API Client ============

    async function apiFetch(path, intent) {
        if (!_accessToken) {
            throw new Error('Not authenticated');
        }

        // Guardrail: APIs are for keeping local IndexedDB in sync/mirror mode,
        // not for ad-hoc context lookups at read time.
        var allowedIntents = {
            metadataSync: true,
            fullBackfill: true,
            incrementalBackfill: true,
            onlineRead: true
        };
        if (!allowedIntents[intent]) {
            throw new Error('apiFetch requires a sync intent (metadataSync/fullBackfill/incrementalBackfill/onlineRead)');
        }

        // Prefer the live Matrix access token when available so the n8n
        // webhook can authenticate against the homeserver on behalf of the user.
        var matrixToken = (typeof MatrixClient !== 'undefined' && MatrixClient.getAccessToken && MatrixClient.getAccessToken())
            ? MatrixClient.getAccessToken()
            : _accessToken;

        var MAX_RETRIES = 2;
        var lastErr = null;

        for (var attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            if (attempt > 0) {
                var delay = attempt === 1 ? 1000 : 3000;
                console.log('[AminoData] Retry ' + attempt + '/' + MAX_RETRIES + ' for ' + path + ' (waiting ' + delay + 'ms)');
                await new Promise(function(r) { setTimeout(r, delay); });
            }

            // Auth: GET with access_token in query-param (n8n webhooks default to GET).
            var separator = path.indexOf('?') === -1 ? '?' : '&';
            var url = WEBHOOK_BASE_URL + path + separator + 'access_token=' + encodeURIComponent(matrixToken);

            var response;
            try {
                response = await fetch(url);
            } catch (fetchErr) {
                // Network / CORS failure — try header auth as last resort
                console.warn('[AminoData] GET fetch failed (' + fetchErr.message + '), retrying with header auth for ' + path);
                try {
                    response = await fetch(WEBHOOK_BASE_URL + path, {
                        headers: {
                            'Authorization': 'Bearer ' + matrixToken
                        }
                    });
                } catch (headerErr) {
                    lastErr = new Error('API unreachable (CORS/network): ' + headerErr.message);
                    continue;
                }
            }

            if (response.status === 401) {
                // Token may not have been picked up — retry with header auth
                console.warn('[AminoData] 401, retrying with header auth for ' + path);
                try {
                    response = await fetch(WEBHOOK_BASE_URL + path, {
                        headers: {
                            'Authorization': 'Bearer ' + matrixToken
                        }
                    });
                } catch (headerErr) {
                    var err = new Error('Authentication expired (CORS/network)');
                    err.status = 401;
                    throw err;
                }
                if (response.status === 401) {
                    var err2 = new Error('Authentication expired');
                    err2.status = 401;
                    throw err2;
                }
            }

            // Retry on 5xx server errors (transient failures, n8n overload, etc.)
            if (response.status >= 500) {
                var errBody = '';
                try { errBody = await response.text(); } catch (e) {}
                console.warn('[AminoData] Server error ' + response.status + ' for ' + path + (errBody ? ' — body: ' + errBody.substring(0, 200) : ''));
                lastErr = new Error('API error: ' + response.status + (errBody ? ' (' + errBody.substring(0, 100) + ')' : ''));
                continue;
            }

            if (!response.ok) {
                var errMsg = 'API error: ' + response.status;
                try {
                    var body = await response.json();
                    if (body.error) errMsg = body.error;
                } catch (e) { /* ignore parse errors */ }
                throw new Error(errMsg);
            }

            var text = await response.text();
            if (!text || !text.trim()) {
                console.log('[AminoData] Empty response for ' + path + ' — treating as empty result set');
                return { records: [] };
            }
            return JSON.parse(text);
        }

        // All retries exhausted
        throw lastErr || new Error('API failed after ' + (MAX_RETRIES + 1) + ' attempts');
    }

    // ============ Table Operations ============

    async function fetchAndStoreTables() {
        var data = await apiFetch('/amino-tables', 'metadataSync');
        var tables = data.tables || [];

        var tx = _db.transaction('tables', 'readwrite');
        var store = tx.objectStore('tables');
        for (var i = 0; i < tables.length; i++) {
            await idbPut(store, tables[i]);
        }
        await idbTxDone(tx);

        _tables = tables;
        _tableIds = tables.map(function(t) { return t.table_id; });

        return tables;
    }

    async function loadTablesFromCache() {
        if (!_db) throw new Error('Data layer not initialized');

        var tx = _db.transaction('tables', 'readonly');
        var tables = await idbGetAll(tx.objectStore('tables'));

        _tables = tables;
        _tableIds = tables.map(function(t) { return t.table_id; });

        return tables;
    }

    // ============ Record Encryption Helpers ============

    async function encryptAndStoreRecord(store, record, tableId) {
        var normalizedRecord = {
            id: record.id,
            tableId: tableId,
            tableName: record.tableName || tableId,
            fields: record.fields || {},
            lastSynced: record.lastSynced || new Date().toISOString()
        };
        var storedFields;
        if (_deferEncryption) {
            storedFields = JSON.stringify(normalizedRecord.fields); // plaintext string
        } else {
            storedFields = await encrypt(_cryptoKey, JSON.stringify(normalizedRecord.fields)); // ArrayBuffer
        }
        await idbPut(store, {
            id: normalizedRecord.id,
            tableId: normalizedRecord.tableId,
            tableName: normalizedRecord.tableName,
            fields: storedFields,
            lastSynced: normalizedRecord.lastSynced
        });
        cacheRecord(normalizedRecord);
    }

    async function prepareEncryptedRecords(records, tableId) {
        return Promise.all(records.map(async function(record) {
            var normalizedRecord = {
                id: record.id,
                tableId: tableId,
                tableName: record.tableName || tableId,
                fields: record.fields || {},
                lastSynced: record.lastSynced || new Date().toISOString()
            };
            var storedFields;
            if (_deferEncryption) {
                storedFields = JSON.stringify(normalizedRecord.fields);
            } else {
                storedFields = await encrypt(_cryptoKey, JSON.stringify(normalizedRecord.fields));
            }
            return {
                entry: {
                    id: normalizedRecord.id,
                    tableId: normalizedRecord.tableId,
                    tableName: normalizedRecord.tableName,
                    fields: storedFields,
                    lastSynced: normalizedRecord.lastSynced
                },
                normalizedRecord: normalizedRecord
            };
        }));
    }

    async function decryptRecord(entry) {
        var fields;
        if (typeof entry.fields === 'string') {
            // Plaintext JSON (deferred-encryption mode or leftover from crash)
            fields = JSON.parse(entry.fields);
        } else {
            // Encrypted ArrayBuffer — decrypt with crypto key
            fields = JSON.parse(await decrypt(_cryptoKey, entry.fields));
        }
        return {
            id: entry.id,
            tableId: entry.tableId,
            tableName: entry.tableName,
            fields: fields,
            lastSynced: entry.lastSynced
        };
    }


    function cloneRecord(record) {
        if (typeof structuredClone === 'function') {
            return structuredClone(record);
        }
        return JSON.parse(JSON.stringify(record));
    }

    function clearRecordCache() {
        _recordCacheById = {};
        _tableRecordIdIndex = {};
        _tableCacheHydrated = {};
        _searchIndex = {};
        _searchIndexVersion++;
    }

    function clearTableCache(tableId) {
        var tableIndex = _tableRecordIdIndex[tableId] || {};
        var recordIds = Object.keys(tableIndex);
        for (var i = 0; i < recordIds.length; i++) {
            delete _recordCacheById[recordIds[i]];
            delete _searchIndex[recordIds[i]];
        }
        delete _tableRecordIdIndex[tableId];
        delete _tableCacheHydrated[tableId];
        _searchIndexVersion++;
    }

    // ============ Encrypt-on-Logout: Bulk Encryption ============

    // Encrypt all plaintext records in IndexedDB. Called on logout to ensure
    // data-at-rest is encrypted. Processes in batches to avoid memory pressure.
    // Returns the number of records encrypted.
    async function encryptAllRecords() {
        if (!_db || !_cryptoKey) return 0;

        var tx = _db.transaction('records', 'readonly');
        var allEntries = await idbGetAll(tx.objectStore('records'));
        var BATCH_SIZE = 200;
        var encrypted = 0;

        for (var b = 0; b < allEntries.length; b += BATCH_SIZE) {
            var batch = allEntries.slice(b, b + BATCH_SIZE);
            var writeTx = _db.transaction('records', 'readwrite');
            var store = writeTx.objectStore('records');

            for (var i = 0; i < batch.length; i++) {
                var entry = batch[i];
                // Only encrypt entries that are currently plaintext strings
                if (typeof entry.fields === 'string') {
                    var encryptedFields = await encrypt(_cryptoKey, entry.fields);
                    entry.fields = encryptedFields;
                    await idbPut(store, entry);
                    encrypted++;
                }
            }
            await idbTxDone(writeTx);
        }

        console.log('[AminoData] Encrypted', encrypted, 'plaintext records on logout');
        return encrypted;
    }

    // Check if a record is a tombstone (soft-deleted)
    function _isTombstone(record) {
        return record && record.fields && record.fields._deleted === true;
    }

    function cacheRecord(record) {
        if (!record || !record.id || !record.tableId) return;
        // Skip tombstoned records — they should not appear in queries
        if (_isTombstone(record)) return;
        _recordCacheById[record.id] = cloneRecord(record);
        if (!_tableRecordIdIndex[record.tableId]) {
            _tableRecordIdIndex[record.tableId] = {};
        }
        _tableRecordIdIndex[record.tableId][record.id] = true;
        // Build search index entry for this record
        _searchIndex[record.id] = _buildSearchText(record);
        _searchIndexVersion++;
    }

    function cacheFullTable(tableId, records) {
        clearTableCache(tableId);
        for (var i = 0; i < records.length; i++) {
            cacheRecord(records[i]);
        }
        _tableCacheHydrated[tableId] = true;
    }

    // ============ Search Index Helpers ============

    // Recursively extract all searchable text from a value.
    function _collectText(value) {
        if (value == null) return '';
        if (typeof value === 'string') return value;
        if (typeof value === 'number' || typeof value === 'boolean') return String(value);
        if (Array.isArray(value)) {
            var parts = [];
            for (var i = 0; i < value.length; i++) {
                var p = _collectText(value[i]);
                if (p) parts.push(p);
            }
            return parts.join(' ');
        }
        if (typeof value === 'object') {
            var objParts = [];
            for (var k in value) {
                if (!Object.prototype.hasOwnProperty.call(value, k)) continue;
                objParts.push(k);
                var vp = _collectText(value[k]);
                if (vp) objParts.push(vp);
            }
            return objParts.join(' ');
        }
        return String(value);
    }

    // Build a single lowercased searchable string for a record.
    // Includes the record ID, all field names, and all field values.
    function _buildSearchText(record) {
        var parts = [record.id];
        var fields = record.fields || {};
        for (var key in fields) {
            if (!Object.prototype.hasOwnProperty.call(fields, key)) continue;
            parts.push(key);
            var text = _collectText(fields[key]);
            if (text) parts.push(text);
        }
        return parts.join(' ').toLowerCase();
    }

    // Ensure the search index is built for a table. Uses the in-memory cache.
    // Returns true if the index was ready, false if the table cache isn't hydrated.
    function _ensureSearchIndex(tableId) {
        if (!_tableCacheHydrated[tableId]) return false;
        var tableIndex = _tableRecordIdIndex[tableId] || {};
        var ids = Object.keys(tableIndex);
        var needsRebuild = false;
        for (var i = 0; i < ids.length; i++) {
            if (_searchIndex[ids[i]] === undefined) {
                needsRebuild = true;
                break;
            }
        }
        if (!needsRebuild) return true;

        for (var j = 0; j < ids.length; j++) {
            var rec = _recordCacheById[ids[j]];
            if (rec && _searchIndex[ids[j]] === undefined) {
                _searchIndex[ids[j]] = _buildSearchText(rec);
            }
        }
        _searchIndexVersion++;
        return true;
    }

    function normalizeFieldOps(content) {
        return AminoHydration.normalizeFieldOps(content);
    }

    async function deleteTableRecords(tableId) {
        var tx = _db.transaction('records', 'readwrite');
        var store = tx.objectStore('records');
        var index = store.index('byTable');

        await new Promise(function(resolve, reject) {
            var request = index.openCursor(IDBKeyRange.only(tableId));
            request.onsuccess = function(event) {
                var cursor = event.target.result;
                if (!cursor) {
                    resolve();
                    return;
                }
                cursor.delete();
                cursor.continue();
            };
            request.onerror = function(event) {
                reject(event.target.error);
            };
        });

        await idbTxDone(tx);
        clearTableCache(tableId);
    }

    // ============ Hydration & Sync ============
    // Core hydration logic is delegated to the AminoHydration module.
    // These functions build a HydrationContext and call through.

    function _buildHydrationCtx() {
        return {
            db: _db,
            tableIds: _tableIds,
            tables: _tables,
            onlineOnlyMode: _onlineOnlyMode,
            deferEncryption: _deferEncryption,
            BOX_DOWNLOAD_WEBHOOK: BOX_DOWNLOAD_WEBHOOK,

            getAuthToken: function() {
                return (typeof MatrixClient !== 'undefined' && MatrixClient.getAccessToken && MatrixClient.getAccessToken())
                    ? MatrixClient.getAccessToken() : _accessToken;
            },

            idbPut: idbPut,
            idbGet: idbGet,
            idbGetAll: idbGetAll,
            idbTxDone: idbTxDone,

            prepareEncryptedRecords: prepareEncryptedRecords,
            cacheRecord: cacheRecord,
            cacheFullTable: cacheFullTable,
            deleteTableRecords: deleteTableRecords,

            encrypt: function(plaintext) { return encrypt(_cryptoKey, plaintext); },
            decrypt: function(ciphertext) { return decrypt(_cryptoKey, ciphertext); },

            apiFetch: apiFetch,

            emitEvent: function(name, detail) {
                window.dispatchEvent(new CustomEvent(name, { detail: detail }));
            }
        };
    }

    async function hydrateTable(tableId) {
        var ctx = _buildHydrationCtx();
        var result = await AminoHydration.hydrateTableFromPostgres(ctx, tableId);
        return result.count;
    }

    async function syncTable(tableId) {
        var ctx = _buildHydrationCtx();
        var result = await AminoHydration.syncTableFromPostgres(ctx, tableId);
        return result.count;
    }

    // ============ View Deletion Tracking & Propagation ============

    // Process a law.firm.view.delete event received via sync.
    // Emits amino:view-delete or amino:view-restore custom events
    // so the UI can react (remove view from sidebar, show undo toast, etc.)
    function processViewDeleteEvent(event) {
        var content = event.content;
        if (!content || !content.viewId || !content.tableId) return;

        var op = content.op || 'NUL';

        if (op === 'NUL') {
            // View was deleted — notify UI
            window.dispatchEvent(new CustomEvent('amino:view-delete', {
                detail: {
                    eventId: event.event_id || null,
                    sender: event.sender || null,
                    timestamp: event.origin_server_ts || Date.now(),
                    tableId: content.tableId,
                    viewId: content.viewId,
                    deletedBy: content.deletedBy || event.sender || null,
                    viewSnapshot: content.viewSnapshot || null
                }
            }));
        } else if (op === 'INS') {
            // View was restored — notify UI
            window.dispatchEvent(new CustomEvent('amino:view-restore', {
                detail: {
                    eventId: event.event_id || null,
                    sender: event.sender || null,
                    timestamp: event.origin_server_ts || Date.now(),
                    tableId: content.tableId,
                    viewId: content.viewId,
                    restoredBy: content.restoredBy || event.sender || null,
                    viewSnapshot: content.viewSnapshot || null
                }
            }));
        }
    }

    // Process timeline events from a Matrix /sync response scoped to the org space.
    // Looks for law.firm.view.delete events and dispatches them.
    function processViewSyncResponse(syncData) {
        if (!syncData || !syncData.rooms || !syncData.rooms.join || !_orgSpaceId) return 0;

        var joinedRooms = syncData.rooms.join;
        var orgRoom = joinedRooms[_orgSpaceId];
        if (!orgRoom || !orgRoom.timeline || !orgRoom.timeline.events) return 0;

        var processed = 0;
        var events = orgRoom.timeline.events;
        for (var i = 0; i < events.length; i++) {
            var event = events[i];
            if (event.type === 'law.firm.view.delete') {
                processViewDeleteEvent(event);
                processed++;
            }
        }
        return processed;
    }

    // Start a long-poll sync loop monitoring the org space for view deletion events.
    // This runs alongside the main record sync loop but scoped to different
    // event types in the org space room.
    async function startViewDeletionSync(orgSpaceId) {
        if (!MatrixClient || !MatrixClient.isLoggedIn()) {
            console.warn('[AminoData] MatrixClient not available, cannot monitor view deletions');
            return false;
        }

        if (!orgSpaceId) {
            console.warn('[AminoData] No org space ID provided, cannot monitor view deletions');
            return false;
        }

        _orgSpaceId = orgSpaceId;
        _viewSyncRunning = true;
        console.log('[AminoData] Starting view deletion sync for org space:', orgSpaceId);

        _runViewSyncLoop();
        return true;
    }

    async function _runViewSyncLoop() {
        var syncToken = null;
        var homeserverUrl = MatrixClient.getHomeserverUrl();

        // Build a filter scoped to the org space for view deletion events only
        var filter = JSON.stringify({
            room: {
                rooms: [_orgSpaceId],
                timeline: {
                    types: ['law.firm.view.delete'],
                    limit: 50
                },
                state: { lazy_load_members: true, types: [] },
                ephemeral: { types: [] },
                account_data: { types: [] }
            },
            presence: { types: [] },
            account_data: { types: [] }
        });

        while (_viewSyncRunning) {
            try {
                var params = {
                    filter: filter,
                    timeout: '30000'
                };
                if (syncToken) {
                    params.since = syncToken;
                }

                var url = homeserverUrl + '/_matrix/client/v3/sync?' + new URLSearchParams(params).toString();

                var controller = new AbortController();
                _viewSyncAbort = controller;

                var response = await fetch(url, {
                    headers: { 'Authorization': 'Bearer ' + MatrixClient.getAccessToken() },
                    signal: controller.signal
                });

                if (!response.ok) {
                    if (response.status === 429) {
                        var retryData = await response.json().catch(function() { return {}; });
                        var delay = (retryData.retry_after_ms || 5000);
                        console.warn('[AminoData] View sync rate-limited, waiting', delay, 'ms');
                        await new Promise(function(r) { setTimeout(r, delay); });
                        continue;
                    }
                    throw new Error('View sync failed: ' + response.status);
                }

                var data = await response.json();
                syncToken = data.next_batch;

                var viewUpdates = processViewSyncResponse(data);
                if (viewUpdates > 0) {
                    window.dispatchEvent(new CustomEvent('amino:sync', {
                        detail: { source: 'matrix-view-sync', updatedCount: viewUpdates }
                    }));
                }
            } catch (err) {
                if (err.name === 'AbortError') {
                    break;
                }
                console.error('[AminoData] View deletion sync error:', err);
                await new Promise(function(r) { setTimeout(r, 5000); });
            }
        }
    }

    function stopViewDeletionSync() {
        _viewSyncRunning = false;
        if (_viewSyncAbort) {
            _viewSyncAbort.abort();
            _viewSyncAbort = null;
        }
    }

    // High-level view deletion: records the deletion in Matrix via EO NUL operator,
    // soft-deletes the state event, and emits a local event for immediate UI update.
    //
    // Parameters:
    //   tableId      — table the view belongs to
    //   viewId       — view identifier
    //   viewSnapshot — full view config to preserve for undo
    //
    // Returns the event_id from Matrix.
    async function deleteView(tableId, viewId, viewSnapshot) {
        if (!_orgSpaceId) throw new Error('Org space not configured for view deletion tracking');
        if (!MatrixClient || !MatrixClient.isLoggedIn()) throw new Error('MatrixClient not available');

        var result = await MatrixClient.deleteView(_orgSpaceId, tableId, viewId, viewSnapshot);

        // Emit local event immediately (don't wait for sync round-trip)
        window.dispatchEvent(new CustomEvent('amino:view-delete', {
            detail: {
                eventId: (result && result.event_id) || null,
                sender: MatrixClient.getUserId(),
                timestamp: Date.now(),
                tableId: tableId,
                viewId: viewId,
                deletedBy: MatrixClient.getUserId(),
                viewSnapshot: viewSnapshot,
                source: 'local'
            }
        }));

        return result;
    }

    // High-level view restore: records the restoration in Matrix via EO INS operator,
    // re-publishes the state event, and emits a local event for immediate UI update.
    //
    // Parameters:
    //   tableId      — table the view belongs to
    //   viewId       — view identifier
    //   viewSnapshot — full view config to restore
    //
    // Returns the event_id from Matrix.
    async function restoreView(tableId, viewId, viewSnapshot) {
        if (!_orgSpaceId) throw new Error('Org space not configured for view restoration');
        if (!MatrixClient || !MatrixClient.isLoggedIn()) throw new Error('MatrixClient not available');

        var result = await MatrixClient.restoreView(_orgSpaceId, tableId, viewId, viewSnapshot);

        // Emit local event immediately
        window.dispatchEvent(new CustomEvent('amino:view-restore', {
            detail: {
                eventId: (result && result.event_id) || null,
                sender: MatrixClient.getUserId(),
                timestamp: Date.now(),
                tableId: tableId,
                viewId: viewId,
                restoredBy: MatrixClient.getUserId(),
                viewSnapshot: viewSnapshot,
                source: 'local'
            }
        }));

        return result;
    }

    // Fetch the view deletion/restoration history for the org.
    // Delegates to MatrixClient.getViewDeletionHistory.
    async function getViewDeletionHistory(options) {
        if (!_orgSpaceId) throw new Error('Org space not configured');
        return MatrixClient.getViewDeletionHistory(_orgSpaceId, options);
    }

    // ============ Airtable Manual Sync Trigger ============

    // Trigger n8n to pull latest changes from Airtable.
    // Rate-limited: enforces a minimum cooldown between calls to avoid flooding n8n.
    // Returns { triggered: bool, cooldownRemaining: number (ms), error?: string }
    async function triggerAirtableSync() {
        var now = Date.now();
        var elapsed = now - _lastAirtableSyncTrigger;
        var remaining = Math.max(0, AIRTABLE_SYNC_COOLDOWN - elapsed);

        // Rate limit: reject if still within cooldown
        if (remaining > 0) {
            console.log('[AminoData] Airtable sync throttled — ' + Math.ceil(remaining / 1000) + 's remaining');
            return { triggered: false, cooldownRemaining: remaining };
        }

        // Deduplicate: don't send if a request is already in flight
        if (_airtableSyncInFlight) {
            console.log('[AminoData] Airtable sync already in progress');
            return { triggered: false, cooldownRemaining: 0, inFlight: true };
        }

        _airtableSyncInFlight = true;
        _lastAirtableSyncTrigger = now;

        try {
            console.log('[AminoData] Triggering Airtable sync via n8n webhook');
            var response = await fetch(AIRTABLE_SYNC_WEBHOOK, {
                method: 'GET'
            });

            if (!response.ok) {
                var errMsg = 'Airtable sync webhook returned ' + response.status;
                console.warn('[AminoData] ' + errMsg);
                return { triggered: true, cooldownRemaining: AIRTABLE_SYNC_COOLDOWN, error: errMsg };
            }

            console.log('[AminoData] Airtable sync triggered successfully');
            return { triggered: true, cooldownRemaining: AIRTABLE_SYNC_COOLDOWN };
        } catch (err) {
            console.error('[AminoData] Airtable sync webhook failed:', err);
            // Still count as a trigger attempt for cooldown purposes
            return { triggered: true, cooldownRemaining: AIRTABLE_SYNC_COOLDOWN, error: err.message };
        } finally {
            _airtableSyncInFlight = false;
        }
    }

    // Get current sync trigger status without triggering.
    function getAirtableSyncStatus() {
        var elapsed = Date.now() - _lastAirtableSyncTrigger;
        var remaining = Math.max(0, AIRTABLE_SYNC_COOLDOWN - elapsed);
        return {
            cooldownRemaining: remaining,
            inFlight: _airtableSyncInFlight,
            lastTriggered: _lastAirtableSyncTrigger || null,
            cooldownMs: AIRTABLE_SYNC_COOLDOWN
        };
    }

    // ============ Polling ============

    var _pollIntervalMs = DEFAULT_POLL_INTERVAL;
    var _pollVisibilityHandler = null;
    var _perTableFailures = {};          // B-5 fix: per-table failure tracking
    var MAX_TABLE_POLL_FAILURES = 5;     // Skip table after this many consecutive failures

    function startPolling(intervalMs) {
        _pollIntervalMs = intervalMs || DEFAULT_POLL_INTERVAL;

        if (_pollInterval) {
            clearInterval(_pollInterval);
        }

        var poll = async function() {
            // Skip if tab is hidden — will resume on visibilitychange
            if (typeof document !== 'undefined' && document.hidden) return;

            for (var i = 0; i < _tableIds.length; i++) {
                var tableId = _tableIds[i];

                // B-5 fix: Skip tables that have individually failed too many times
                // (they'll be retried after a successful poll cycle or re-init)
                if (_perTableFailures[tableId] >= MAX_TABLE_POLL_FAILURES) {
                    continue;
                }

                try {
                    var count = await syncTable(tableId);
                    _perTableFailures[tableId] = 0; // Reset on success
                    if (count > 0) {
                        window.dispatchEvent(new CustomEvent('amino:sync', {
                            detail: { tableId: tableId, updatedCount: count }
                        }));
                    }
                } catch (err) {
                    _perTableFailures[tableId] = (_perTableFailures[tableId] || 0) + 1;
                    console.error('[AminoData] Sync failed for ' + tableId + ' (' + _perTableFailures[tableId] + '/' + MAX_TABLE_POLL_FAILURES + '):', err);
                    if (err.status === 401) {
                        stopPolling();
                        window.dispatchEvent(new CustomEvent('amino:auth-expired'));
                        return;
                    }
                    // B-5 fix: Continue to next table instead of aborting
                }
            }
        };

        _pollInterval = setInterval(poll, _pollIntervalMs);
        poll(); // Run immediately on start

        // Pause/resume polling on tab visibility changes
        if (typeof document !== 'undefined' && !_pollVisibilityHandler) {
            _pollVisibilityHandler = function() {
                if (document.hidden) {
                    // Tab hidden — pause polling
                    if (_pollInterval) {
                        clearInterval(_pollInterval);
                        _pollInterval = null;
                    }
                } else if (!_pollInterval && _tableIds.length > 0) {
                    // Tab visible again — resume polling
                    _pollInterval = setInterval(poll, _pollIntervalMs);
                    poll();
                }
            };
            document.addEventListener('visibilitychange', _pollVisibilityHandler);
        }
    }

    function stopPolling() {
        if (_pollInterval) {
            clearInterval(_pollInterval);
            _pollInterval = null;
        }
        if (_pollVisibilityHandler) {
            document.removeEventListener('visibilitychange', _pollVisibilityHandler);
            _pollVisibilityHandler = null;
        }
    }

    // ============ Data Accessors (Decrypted) ============

    async function getTableRecords(tableId) {
        // Online-only mode: serve from in-memory cache if available,
        // otherwise fetch directly from the API (skip IndexedDB entirely).
        if (_onlineOnlyMode) {
            if (_tableCacheHydrated[tableId]) {
                var cachedIds = Object.keys(_tableRecordIdIndex[tableId] || {});
                return cachedIds.map(function(recordId) {
                    return cloneRecord(_recordCacheById[recordId]);
                });
            }
            // Fetch fresh from API
            var data = await apiFetch('/amino-records?tableId=' + encodeURIComponent(tableId), 'onlineRead');
            var apiRecords = (data.records || []).map(function(rec) {
                var recFields = rec.fields;
                if (typeof recFields === 'string') {
                    try { recFields = JSON.parse(recFields); } catch (e) { recFields = {}; }
                }
                return {
                    id: rec.id,
                    tableId: tableId,
                    tableName: rec.tableName || tableId,
                    fields: recFields || {},
                    lastSynced: rec.lastSynced || new Date().toISOString()
                };
            }).filter(function(r) { return !_isTombstone(r); });
            cacheFullTable(tableId, apiRecords);
            return apiRecords.map(function(record) { return cloneRecord(record); });
        }

        if (!_db || !_cryptoKey) throw new Error('Data layer not initialized');

        if (_tableCacheHydrated[tableId]) {
            var cachedIds = Object.keys(_tableRecordIdIndex[tableId] || {});
            return cachedIds.map(function(recordId) {
                return cloneRecord(_recordCacheById[recordId]);
            });
        }

        var tx = _db.transaction('records', 'readonly');
        var index = tx.objectStore('records').index('byTable');
        var entries = await idbGetAll(index, tableId);

        var results = await Promise.all(entries.map(function(entry) {
            return decryptRecord(entry);
        }));
        // Filter out tombstoned records before caching and returning
        results = results.filter(function(r) { return !_isTombstone(r); });
        cacheFullTable(tableId, results);
        return results.map(function(record) { return cloneRecord(record); });
    }

    async function getRecord(recordId) {
        // Online-only mode: serve from in-memory cache, fall back to API.
        if (_onlineOnlyMode) {
            if (_recordCacheById[recordId]) {
                return cloneRecord(_recordCacheById[recordId]);
            }
            // Fetch single record from API when not in cache
            try {
                var data = await apiFetch('/amino-record?recordId=' + encodeURIComponent(recordId), 'onlineRead');
                if (data && data.record) {
                    var rec = data.record;
                    var record = {
                        id: rec.id,
                        tableId: rec.tableId || rec.table_id,
                        tableName: rec.tableName || rec.table_name || '',
                        fields: rec.fields || {},
                        lastSynced: rec.lastSynced || rec.last_synced_at || new Date().toISOString()
                    };
                    if (_isTombstone(record)) return null;
                    cacheRecord(record);
                    return cloneRecord(record);
                }
            } catch (e) {
                console.warn('[AminoData] getRecord API fallback failed for', recordId, ':', e.message);
            }
            return null;
        }

        if (!_db || !_cryptoKey) throw new Error('Data layer not initialized');

        if (_recordCacheById[recordId]) {
            return cloneRecord(_recordCacheById[recordId]);
        }

        var tx = _db.transaction('records', 'readonly');
        var entry = await idbGet(tx.objectStore('records'), recordId);
        if (!entry) return null;
        var record = await decryptRecord(entry);
        // Tombstoned records appear as null to callers
        if (_isTombstone(record)) return null;
        cacheRecord(record);
        return cloneRecord(record);
    }


    async function searchRecords(tableId, fieldName, searchValue) {
        var records = await getTableRecords(tableId);
        var lowerSearch = typeof searchValue === 'string' ? searchValue.toLowerCase() : null;
        return records.filter(function(r) {
            var val = r.fields[fieldName];
            if (typeof val === 'string' && lowerSearch !== null) {
                return val.toLowerCase().indexOf(lowerSearch) !== -1;
            }
            return val === searchValue;
        });
    }

    // Fast full-text search across all fields of a table using the pre-built index.
    // Returns matching records (cloned). Supports multi-word AND queries.
    // Much faster than searchRecords() for general-purpose searching.
    async function searchRecordsFast(tableId, query) {
        if (!query || !query.trim()) return await getTableRecords(tableId);

        // Ensure records are cached
        if (!_tableCacheHydrated[tableId]) {
            await getTableRecords(tableId); // populates cache
        }
        _ensureSearchIndex(tableId);

        var tokens = query.toLowerCase().trim().split(/\s+/).filter(function(t) { return t.length > 0; });
        if (!tokens.length) return await getTableRecords(tableId);

        var tableIndex = _tableRecordIdIndex[tableId] || {};
        var ids = Object.keys(tableIndex);
        var results = [];

        for (var i = 0; i < ids.length; i++) {
            var haystack = _searchIndex[ids[i]];
            if (!haystack) continue;
            var match = true;
            for (var t = 0; t < tokens.length; t++) {
                if (haystack.indexOf(tokens[t]) === -1) { match = false; break; }
            }
            if (match) {
                results.push(cloneRecord(_recordCacheById[ids[i]]));
            }
        }
        return results;
    }

    // Get the pre-built search index for use by the UI layer.
    // Returns { index: { recordId: searchText }, version: number }
    // The UI can cache this and re-fetch only when version changes.
    function getSearchIndex(tableId) {
        if (tableId) {
            _ensureSearchIndex(tableId);
        }
        return { index: _searchIndex, version: _searchIndexVersion };
    }

    // Get cached records without cloning (read-only, do not mutate!).
    // For internal/UI use where performance matters and caller won't modify records.
    function getTableRecordsCached(tableId) {
        if (!_tableCacheHydrated[tableId]) return null;
        var tableIndex = _tableRecordIdIndex[tableId] || {};
        var ids = Object.keys(tableIndex);
        var results = new Array(ids.length);
        for (var i = 0; i < ids.length; i++) {
            results[i] = _recordCacheById[ids[i]];
        }
        return results;
    }

    // Get a single cached record without cloning (read-only).
    function getRecordCached(recordId) {
        return _recordCacheById[recordId] || null;
    }

    async function getTables() {
        if (!_db) throw new Error('Data layer not initialized');

        var tx = _db.transaction('tables', 'readonly');
        return idbGetAll(tx.objectStore('tables'));
    }

    // ============ Initialization ============

    // Core initialization logic shared by init() and initWithKey().
    // Accepts a pre-derived CryptoKey and an optional raw password
    // (needed only for legacy salt migration).
    async function _initCore(accessToken, userId, cryptoKey, password) {
        _accessToken = accessToken;
        _userId = userId;
        clearRecordCache();

        // Open database
        _db = await openDatabase();
        _cryptoKey = cryptoKey;

        // Check for existing encryption state and migrate if necessary
        var cryptoTx = _db.transaction('crypto', 'readonly');
        var saltEntry = await idbGet(cryptoTx.objectStore('crypto'), 'salt');
        var verifyEntry = await idbGet(cryptoTx.objectStore('crypto'), 'verify');

        if (saltEntry && saltEntry.value !== 'synapse-derived') {
            if (password) {
                // Legacy random salt exists — migrate to Synapse-derived key
                console.log('[AminoData] Detected legacy random salt, migrating to Synapse-derived encryption');
                var oldSalt = new Uint8Array(saltEntry.value);
                var oldKey = await deriveKey(password, oldSalt);
                var migrated = await migrateEncryptionKey(oldKey, _cryptoKey);

                if (migrated === -1) {
                    // Neither key works — clear stale data and re-hydrate
                    console.warn('[AminoData] Clearing stale encrypted data for re-hydration');
                    var clearTx = _db.transaction(['records', 'sync'], 'readwrite');
                    clearTx.objectStore('records').clear();
                    clearTx.objectStore('sync').clear();
                    await idbTxDone(clearTx);
                    clearRecordCache();
                }
            } else {
                // No password available for legacy migration — clear and re-hydrate
                console.warn('[AminoData] Legacy salt detected but no password for migration — clearing data');
                var clearTx = _db.transaction(['records', 'sync'], 'readwrite');
                clearTx.objectStore('records').clear();
                clearTx.objectStore('sync').clear();
                await idbTxDone(clearTx);
                clearRecordCache();
            }
        } else if (verifyEntry) {
            // Synapse-derived key already in use — verify it still matches
            var keyValid = await verifyEncryptionKey(_cryptoKey, verifyEntry.value);
            if (!keyValid) {
                // Password changed — data needs re-encryption or re-hydration
                console.warn('[AminoData] Synapse password changed — clearing local data for re-hydration');
                var clearTx2 = _db.transaction(['records', 'sync'], 'readwrite');
                clearTx2.objectStore('records').clear();
                clearTx2.objectStore('sync').clear();
                await idbTxDone(clearTx2);
                clearRecordCache();
            }
        }

        // Store Synapse-derived marker and verification token
        var verifyToken = await createVerificationToken(_cryptoKey);
        var metaTx = _db.transaction('crypto', 'readwrite');
        var metaStore = metaTx.objectStore('crypto');
        await idbPut(metaStore, { key: 'salt', value: 'synapse-derived', userId: userId });
        await idbPut(metaStore, { key: 'verify', value: verifyToken });
        await idbPut(metaStore, { key: 'lastOnlineAuth', value: Date.now() });
        await idbTxDone(metaTx);

        // Load cached tables immediately (fast startup + offline support),
        // then refresh from API when network is available.
        var cachedTables = await loadTablesFromCache();
        try {
            await fetchAndStoreTables();
            _offlineMode = false;
        } catch (err) {
            if (!cachedTables.length) {
                throw err;
            }
            _offlineMode = true;
            console.warn('[AminoData] Using cached table metadata (offline):', err.message || err);
        }

        // Store exported key in localStorage for sub-page access
        await exportKeyToStorage(_cryptoKey);

        // Enable deferred encryption: store plaintext in IndexedDB during
        // the active session, encrypt everything on logout. Any records left
        // unencrypted from a previous crash are safe to read (dual-format
        // detection in decryptRecord handles both), and will be encrypted
        // on the next clean logout.
        _deferEncryption = true;

        // G-9 fix: Re-register global event listeners (may have been removed by previous logout)
        _reregisterGlobalListeners();

        _initialized = true;
        console.log('[AminoData] Initialized with', _tables.length, 'tables (Synapse-derived encryption, encrypt-on-logout)');

        return _tables;
    }

    async function init(accessToken, userId, password) {
        if (!accessToken || !userId || !password) {
            throw new Error('accessToken, userId, and password are required');
        }

        var key = await deriveSynapseKey(password, userId);
        return _initCore(accessToken, userId, key, password);
    }

    // Initialize using a pre-derived CryptoKey or a previously exported key from localStorage.
    // Used by sub-pages (layout builder, client profile) that don't have the password.
    // If cryptoKey is provided, uses it directly; otherwise loads from localStorage.
    async function initWithKey(accessToken, userId, cryptoKey) {
        if (!accessToken || !userId) {
            throw new Error('accessToken and userId are required');
        }
        var key = cryptoKey || (await importKeyFromStorage());
        if (!key) {
            throw new Error('No stored encryption key found. Please log in from the main app first.');
        }
        return _initCore(accessToken, userId, key, null);
    }

    // Derive and store the encryption key without full initialization.
    // Called by the main app after Synapse login so sub-pages can use initWithKey().
    async function prepareKey(password, userId) {
        if (!password || !userId) return;
        var key = await deriveSynapseKey(password, userId);
        await exportKeyToStorage(key);
    }

    async function hydrateAll(onProgress) {
        if (!_initialized) throw new Error('Call init() first');

        var ctx = _buildHydrationCtx();
        var result = await AminoHydration.run(ctx, { onProgress: onProgress });
        console.log('[AminoData] Hydration complete via AminoHydration:', result.totalRecords,
            'records (tier:', result.tier || 'none', ')');
        return result.totalRecords || 0;
    }

    // Convenience wrapper — can still be called directly from Settings → Refresh.
    async function hydrateAllFromPostgres(onProgress) {
        if (!_initialized) throw new Error('Call init() first');

        var ctx = _buildHydrationCtx();
        var result = await AminoHydration.tierPostgres(ctx, { onProgress: onProgress });
        return result.totalRecords || 0;
    }

    async function initAndHydrate(accessToken, userId, password, options) {
        options = options || {};
        var pollInterval = options.pollInterval || DEFAULT_POLL_INTERVAL;
        var onProgress = options.onProgress || null;

        // Apply online-only mode from options or persisted localStorage setting
        if (options.onlineOnly !== undefined) {
            _onlineOnlyMode = !!options.onlineOnly;
        } else {
            _onlineOnlyMode = localStorage.getItem('amino_online_only_mode') === 'true';
        }

        var tables = await init(accessToken, userId, password);
        var totalRecords = await hydrateAll(onProgress);

        // Use HTTP polling for record updates
        console.log('[AminoData] Using HTTP polling for updates');
        startPolling(pollInterval);

        return {
            tables: tables,
            totalRecords: totalRecords,
            tableRoomMap: getTableRoomMap(),
            onlineOnlyMode: _onlineOnlyMode,
            stopPolling: stopPolling
        };
    }

    // ============ Online-Only Mode ============

    // Toggle online-only mode. When enabled, the data layer fetches all data
    // directly from the API and keeps it only in memory — nothing is written
    // to or read from IndexedDB. This is useful on shared/public machines
    // where no data should persist after the session ends.
    function setOnlineOnlyMode(enabled) {
        var wasEnabled = _onlineOnlyMode;
        _onlineOnlyMode = !!enabled;
        localStorage.setItem('amino_online_only_mode', _onlineOnlyMode ? 'true' : 'false');
        console.log('[AminoData] Online-only mode:', _onlineOnlyMode ? 'ENABLED' : 'DISABLED');

        if (_onlineOnlyMode && !wasEnabled) {
            // Entering online-only mode: clear local IndexedDB data
            // so no data lingers from previous sessions.
            if (_db) {
                try {
                    var storeNames = ['records', 'sync'];
                    var tx = _db.transaction(storeNames, 'readwrite');
                    storeNames.forEach(function(name) { tx.objectStore(name).clear(); });
                    console.log('[AminoData] Cleared IndexedDB records/sync stores (online-only mode)');
                } catch (e) {
                    console.warn('[AminoData] Could not clear IndexedDB on online-only switch:', e);
                }
            }
            // (no local data in online-only mode)
        }

        window.dispatchEvent(new CustomEvent('amino:online-only-mode-changed', {
            detail: { enabled: _onlineOnlyMode }
        }));
    }

    function isOnlineOnly() {
        return _onlineOnlyMode;
    }

    // ============ Session Lifecycle ============

    function setAccessToken(token) {
        _accessToken = token;
    }

    async function restoreSession(accessToken, userId, password) {
        // For page reloads: re-derive key, incremental sync
        return init(accessToken, userId, password);
    }

    async function logout(clearData) {
        stopPolling();
        stopViewDeletionSync();
        _removeGlobalListeners(); // G-9 fix: clean up all event listeners
        clearKeyFromStorage();

        // Encrypt all plaintext records before clearing state.
        // Must happen while _cryptoKey and _db are still available.
        // Skip encryption in online-only mode (no persistent IDB data).
        if (_deferEncryption && _cryptoKey && _db && !clearData && !_onlineOnlyMode) {
            try {
                await encryptAllRecords();
            } catch (encErr) {
                console.error('[AminoData] Failed to encrypt records on logout:', encErr);
            }
        }
        _deferEncryption = false;

        _cryptoKey = null;
        _accessToken = null;
        _userId = null;
        _tableRoomMap = {};
        _roomTableMap = {};
        _orgSpaceId = null;
        _offlineMode = false;
        // Note: _onlineOnlyMode is NOT reset on logout — it persists via localStorage
        // so the preference survives across sessions.
        _initialized = false;
        _keyDerivationCache = { fingerprint: null, key: null };
        AminoHydration.reset();
        _perTableFailures = {};
        clearRecordCache();

        if (clearData && _db) {
            // Clear all data from IndexedDB
            var storeNames = ['records', 'tables', 'sync'];
            var tx = _db.transaction(storeNames, 'readwrite');
            storeNames.forEach(function(name) {
                tx.objectStore(name).clear();
            });
            // Note: crypto store (salt) is kept for session restore
        }

        if (_db) {
            _db.close();
            _db = null;
        }
    }

    function destroy() {
        // Full destruction — remove the entire database
        logout(false);
        return new Promise(function(resolve, reject) {
            var request = indexedDB.deleteDatabase(DB_NAME);
            request.onsuccess = function() { resolve(); };
            request.onerror = function() { reject(request.error); };
        });
    }


    // ============ Offline Session Manager ============

    // Check if we can reach the Matrix homeserver
    async function checkConnectivity() {
        var homeserverUrl = null;

        // Try MatrixClient first
        if (typeof MatrixClient !== 'undefined' && MatrixClient.getHomeserverUrl) {
            homeserverUrl = MatrixClient.getHomeserverUrl();
        }

        // Fall back to localStorage session
        if (!homeserverUrl) {
            try {
                var session = JSON.parse(localStorage.getItem('matrix_session') || '{}');
                homeserverUrl = session.homeserverUrl;
            } catch (e) { /* ignore */ }
        }

        if (!homeserverUrl) return false;

        try {
            var controller = new AbortController();
            var timeoutId = setTimeout(function() { controller.abort(); }, 5000);
            var response = await fetch(homeserverUrl + '/_matrix/client/versions', {
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            return response.ok;
        } catch (e) {
            return false;
        }
    }

    // Check if offline access has expired (too many days since last online auth)
    async function checkOfflineAccessExpiry(db) {
        var targetDb = db || _db;
        if (!targetDb) return false;

        try {
            var cryptoTx = targetDb.transaction('crypto', 'readonly');
            var lastOnlineAuth = await idbGet(cryptoTx.objectStore('crypto'), 'lastOnlineAuth');
            if (!lastOnlineAuth || !lastOnlineAuth.value) return false;

            // Read configurable max days from cached org config, or use default
            var maxDays = DEFAULT_OFFLINE_ACCESS_MAX_DAYS;
            try {
                var configStr = localStorage.getItem('amino_offline_max_days');
                if (configStr) {
                    var parsed = parseInt(configStr, 10);
                    if (parsed > 0) maxDays = parsed;
                }
            } catch (e) { /* use default */ }

            var daysSinceAuth = (Date.now() - lastOnlineAuth.value) / (1000 * 60 * 60 * 24);
            return daysSinceAuth <= maxDays;
        } catch (e) {
            return false;
        }
    }

    // Attempt offline unlock using stored verification token.
    // Requires a previous successful online login (verification token in IndexedDB).
    // Returns session info on success, throws on failure.
    async function offlineUnlock(password) {
        // 1. Get userId from localStorage session
        var session;
        try {
            session = JSON.parse(localStorage.getItem('matrix_session') || '{}');
        } catch (e) {
            throw new Error('No saved session found');
        }
        if (!session.userId) {
            throw new Error('No saved session found. You must log in online first.');
        }

        // 2. Open IndexedDB
        var db = await openDatabase();

        // 3. Check offline access expiry
        var accessValid = await checkOfflineAccessExpiry(db);
        if (!accessValid) {
            db.close();
            throw new Error('Offline access has expired. Connect to the internet to re-authenticate.');
        }

        // 4. Read verification token
        var cryptoTx = db.transaction('crypto', 'readonly');
        var verifyEntry = await idbGet(cryptoTx.objectStore('crypto'), 'verify');
        if (!verifyEntry || !verifyEntry.value) {
            db.close();
            throw new Error('No cached data available. Connect to internet for initial login.');
        }

        // 5. Derive key and verify
        var key = await deriveSynapseKey(password, session.userId);
        var isValid = await verifyEncryptionKey(key, verifyEntry.value);
        if (!isValid) {
            db.close();
            throw new Error('Incorrect password');
        }

        // 6. Success — set up offline session
        _db = db;
        _cryptoKey = key;
        _userId = session.userId;
        _offlineMode = true;

        // 7. Load cached tables from IndexedDB
        var tablesTx = db.transaction('tables', 'readonly');
        _tables = await idbGetAll(tablesTx.objectStore('tables'));
        _tableIds = _tables.map(function(t) { return t.table_id; });

        _deferEncryption = true;
        _initialized = true;

        // 8. Start connectivity monitoring
        startConnectivityMonitor();

        var lastSynced = await getLastSyncTime();

        console.log('[AminoData] Offline unlock successful for', session.userId,
            '(' + _tables.length + ' cached tables, last synced:', lastSynced + ', encrypt-on-logout)');

        return {
            userId: session.userId,
            tables: _tables,
            offlineMode: true,
            lastSynced: lastSynced
        };
    }

    // Get the most recent sync timestamp across all tables
    async function getLastSyncTime() {
        if (!_db) return null;
        try {
            var tx = _db.transaction('sync', 'readonly');
            var allSync = await idbGetAll(tx.objectStore('sync'));
            if (allSync.length === 0) return null;
            var latest = allSync.reduce(function(max, entry) {
                return entry.lastSynced > max ? entry.lastSynced : max;
            }, allSync[0].lastSynced);
            return latest;
        } catch (e) {
            return null;
        }
    }

    // ============ Connectivity Monitor ============

    var _onBrowserOnlineHandler = null; // G-9 fix: store reference for cleanup

    function startConnectivityMonitor() {
        if (_connectivityCheckTimer) return;

        _connectivityCheckTimer = setInterval(async function() {
            if (!_offlineMode) {
                stopConnectivityMonitor();
                return;
            }
            var online = await checkConnectivity();
            if (online) {
                window.dispatchEvent(new CustomEvent('amino:connectivity-restored'));
            }
        }, CONNECTIVITY_CHECK_INTERVAL);

        // G-9 fix: Store reference so we can remove it on cleanup
        if (!_onBrowserOnlineHandler) {
            _onBrowserOnlineHandler = function() {
                checkConnectivity().then(function(reachable) {
                    if (reachable) {
                        window.dispatchEvent(new CustomEvent('amino:connectivity-restored'));
                    }
                });
            };
            window.addEventListener('online', _onBrowserOnlineHandler);
        }

        console.log('[AminoData] Connectivity monitor started (checking every', CONNECTIVITY_CHECK_INTERVAL / 1000 + 's)');
    }

    function stopConnectivityMonitor() {
        if (_connectivityCheckTimer) {
            clearInterval(_connectivityCheckTimer);
            _connectivityCheckTimer = null;
        }
        // G-9 fix: Remove browser online listener
        if (_onBrowserOnlineHandler) {
            window.removeEventListener('online', _onBrowserOnlineHandler);
            _onBrowserOnlineHandler = null;
        }
    }

    // Transition from offline to online mode.
    // Verifies session, flushes pending mutations, resumes sync.
    async function transitionToOnline(password) {
        if (!_offlineMode) return { alreadyOnline: true };

        // Verify we can actually reach the homeserver
        var online = await checkConnectivity();
        if (!online) {
            throw new Error('Homeserver still unreachable');
        }

        // Check if the cached access token is still valid
        var session;
        try {
            session = JSON.parse(localStorage.getItem('matrix_session') || '{}');
        } catch (e) {
            throw new Error('No saved session');
        }

        var tokenValid = false;
        if (session.accessToken && session.homeserverUrl) {
            try {
                var whoami = await fetch(session.homeserverUrl + '/_matrix/client/v3/account/whoami', {
                    headers: { 'Authorization': 'Bearer ' + session.accessToken }
                });
                tokenValid = whoami.ok;
            } catch (e) {
                tokenValid = false;
            }
        }

        if (!tokenValid) {
            // Token expired or revoked — need full re-login
            // If password is provided, attempt fresh login
            if (password && session.homeserverUrl && session.userId) {
                var localpart = session.userId.split(':')[0].replace(/^@/, '');
                try {
                    var loginResult = await MatrixClient.login(session.homeserverUrl, localpart, password);
                    session.accessToken = loginResult.accessToken;
                    _accessToken = loginResult.accessToken;
                } catch (loginErr) {
                    throw new Error('Re-authentication failed: ' + loginErr.message);
                }
            } else {
                throw new Error('Session expired. Please log in again.');
            }
        } else {
            // Restore Matrix session
            _accessToken = session.accessToken;
            if (typeof MatrixClient !== 'undefined' && MatrixClient.setSession) {
                MatrixClient.setSession(session.homeserverUrl, session.accessToken, session.userId, session.deviceId);
            }
        }

        // Update last online auth timestamp
        var authTx = _db.transaction('crypto', 'readwrite');
        await idbPut(authTx.objectStore('crypto'), { key: 'lastOnlineAuth', value: Date.now() });
        await idbTxDone(authTx);

        // Flush pending mutations
        var flushResult = await flushPendingMutations();

        // Resume normal sync
        _offlineMode = false;
        stopConnectivityMonitor();

        // Incremental sync all tables
        var syncedRecords = 0;
        for (var i = 0; i < _tableIds.length; i++) {
            try {
                syncedRecords += await syncTable(_tableIds[i]);
            } catch (err) {
                console.warn('[AminoData] Sync failed for table', _tableIds[i], 'during online transition:', err.message);
            }
        }

        // Resume HTTP polling for record updates
        startPolling();

        console.log('[AminoData] Transitioned to online mode.',
            'Flushed:', flushResult.flushed, 'mutations.',
            'Synced:', syncedRecords, 'records.');

        window.dispatchEvent(new CustomEvent('amino:online-transition', {
            detail: {
                flushed: flushResult.flushed,
                flushFailed: flushResult.failed,
                syncedRecords: syncedRecords
            }
        }));

        return {
            flushed: flushResult.flushed,
            flushFailed: flushResult.failed,
            syncedRecords: syncedRecords
        };
    }

    // ============ Pending Mutations (Offline Write Queue) ============

    // Queue a mutation for later sync. Applies optimistically to local IndexedDB.
    async function queueOfflineMutation(tableId, recordId, fields, op) {
        if (!_db) throw new Error('Database not open');

        var mutId = 'mut_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
        var tx = _db.transaction('pending_mutations', 'readwrite');
        await idbPut(tx.objectStore('pending_mutations'), {
            id: mutId,
            tableId: tableId,
            recordId: recordId,
            op: op || 'ALT',
            fields: fields,
            timestamp: Date.now(),
            status: 'pending'
        });
        await idbTxDone(tx);

        // Apply optimistically to local IndexedDB
        await applyLocalMutation(tableId, recordId, fields, op);

        var queueDepth = await getPendingMutationCount();

        window.dispatchEvent(new CustomEvent('amino:offline-mutation-queued', {
            detail: { tableId: tableId, recordId: recordId, op: op || 'ALT', queueDepth: queueDepth }
        }));

        return mutId;
    }

    // Apply a mutation directly to the local IndexedDB record (optimistic update)
    async function applyLocalMutation(tableId, recordId, fields, op) {
        op = op || 'ALT';

        // Read existing record
        var readTx = _db.transaction('records', 'readonly');
        var existing = await idbGet(readTx.objectStore('records'), recordId);

        var currentFields;
        if (existing) {
            if (typeof existing.fields === 'string') {
                currentFields = JSON.parse(existing.fields);
            } else {
                currentFields = JSON.parse(await decrypt(_cryptoKey, existing.fields));
            }
        } else {
            currentFields = {};
        }

        // Apply operation
        if (op === 'ALT' || op === 'INS') {
            var keys = Object.keys(fields);
            for (var i = 0; i < keys.length; i++) {
                currentFields[keys[i]] = fields[keys[i]];
            }
        } else if (op === 'NUL') {
            var nulKeys = Array.isArray(fields) ? fields : Object.keys(fields);
            for (var j = 0; j < nulKeys.length; j++) {
                delete currentFields[nulKeys[j]];
            }
        }

        // Write back — plaintext when deferred, encrypted otherwise
        var storedFields;
        if (_deferEncryption) {
            storedFields = JSON.stringify(currentFields);
        } else {
            storedFields = await encrypt(_cryptoKey, JSON.stringify(currentFields));
        }
        var writeTx = _db.transaction('records', 'readwrite');
        await idbPut(writeTx.objectStore('records'), {
            id: recordId,
            tableId: tableId,
            tableName: (existing && existing.tableName) || tableId,
            fields: storedFields,
            lastSynced: (existing && existing.lastSynced) || new Date().toISOString()
        });
        await idbTxDone(writeTx);

        cacheRecord({
            id: recordId,
            tableId: tableId,
            tableName: (existing && existing.tableName) || tableId,
            fields: currentFields,
            lastSynced: (existing && existing.lastSynced) || new Date().toISOString()
        });

        // Emit update event for UI
        window.dispatchEvent(new CustomEvent('amino:record-update', {
            detail: { recordId: recordId, tableId: tableId, source: 'offline-local' }
        }));
    }

    var MAX_MUTATION_RETRIES = 3;  // G-7 fix: discard after this many permanent failures

    // Flush all pending mutations to the server (oldest first).
    // G-7 fix: Classifies errors as transient (5xx, network) vs permanent (4xx).
    // Permanent failures are discarded after MAX_MUTATION_RETRIES attempts.
    // Returns { flushed, failed, discarded }.
    async function flushPendingMutations() {
        if (!_db) return { flushed: 0, failed: 0, discarded: 0 };

        var tx = _db.transaction('pending_mutations', 'readonly');
        var pending = await idbGetAll(tx.objectStore('pending_mutations'));

        if (pending.length === 0) return { flushed: 0, failed: 0, discarded: 0 };

        // Sort by timestamp (oldest first) to preserve operation order
        pending.sort(function(a, b) { return a.timestamp - b.timestamp; });

        var flushed = 0;
        var failed = 0;
        var discarded = 0;

        for (var i = 0; i < pending.length; i++) {
            var mutation = pending[i];
            try {
                // Flush via HTTP write webhook (same path as editRecord)
                var writeUrl = WEBHOOK_BASE_URL + '/amino-write';
                var writeBody = JSON.stringify({
                    tableId: mutation.tableId,
                    recordId: mutation.recordId,
                    fields: mutation.fields,
                    access_token: _accessToken
                });
                var writeRes = await fetch(
                    writeUrl + '?access_token=' + encodeURIComponent(_accessToken),
                    { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: writeBody }
                );
                if (!writeRes.ok) {
                    var writeErr = new Error('Server returned ' + writeRes.status);
                    writeErr.status = writeRes.status;
                    throw writeErr;
                }

                // Remove from queue on success
                var delTx = _db.transaction('pending_mutations', 'readwrite');
                delTx.objectStore('pending_mutations').delete(mutation.id);
                await idbTxDone(delTx);

                flushed++;
            } catch (err) {
                var isPermanent = err.status >= 400 && err.status < 500;
                var retryCount = (mutation.retryCount || 0) + 1;

                if (isPermanent || retryCount >= MAX_MUTATION_RETRIES) {
                    // G-7 fix: Discard permanently failed mutations
                    console.warn('[AminoData] Discarding permanently failed mutation:', mutation.id,
                        '(status:', err.status || 'unknown', ', retries:', retryCount + ')');
                    var discardTx = _db.transaction('pending_mutations', 'readwrite');
                    discardTx.objectStore('pending_mutations').delete(mutation.id);
                    await idbTxDone(discardTx);
                    discarded++;

                    window.dispatchEvent(new CustomEvent('amino:mutation-discarded', {
                        detail: {
                            mutationId: mutation.id,
                            recordId: mutation.recordId,
                            tableId: mutation.tableId,
                            error: err.message,
                            retryCount: retryCount,
                            permanent: isPermanent
                        }
                    }));
                } else {
                    // Transient failure — update retry count and leave in queue
                    console.error('[AminoData] Transient failure flushing mutation:', mutation.id,
                        '(retry', retryCount + '/' + MAX_MUTATION_RETRIES + '):', err.message || err);
                    var updateTx = _db.transaction('pending_mutations', 'readwrite');
                    mutation.retryCount = retryCount;
                    mutation.status = 'failed';
                    await idbPut(updateTx.objectStore('pending_mutations'), mutation);
                    await idbTxDone(updateTx);
                    failed++;
                }
            }
        }

        if (flushed > 0 || failed > 0 || discarded > 0) {
            window.dispatchEvent(new CustomEvent('amino:offline-mutations-flushed', {
                detail: { flushed: flushed, failed: failed, discarded: discarded, remaining: failed }
            }));
        }

        console.log('[AminoData] Flushed', flushed, 'pending mutations (' + failed + ' failed, ' + discarded + ' discarded)');
        return { flushed: flushed, failed: failed, discarded: discarded };
    }

    // Get count of pending offline mutations
    async function getPendingMutationCount() {
        if (!_db) return 0;
        try {
            var tx = _db.transaction('pending_mutations', 'readonly');
            var all = await idbGetAll(tx.objectStore('pending_mutations'));
            return all.length;
        } catch (e) {
            return 0;
        }
    }

    // Get all pending mutations (for UI display)
    async function getPendingMutations() {
        if (!_db) return [];
        try {
            var tx = _db.transaction('pending_mutations', 'readonly');
            var all = await idbGetAll(tx.objectStore('pending_mutations'));
            all.sort(function(a, b) { return a.timestamp - b.timestamp; });
            return all;
        } catch (e) {
            return [];
        }
    }

    // ============ State Getters ============

    function isInitialized() {
        return _initialized;
    }

    function isOffline() {
        return _offlineMode;
    }

    function getTableList() {
        return _tables.slice(); // Return copy
    }

    function getTableIds() {
        return _tableIds.slice();
    }

    // ============ Encrypt-on-Logout: Safety Handlers ============
    // Best-effort encryption when the page is being discarded without a
    // clean logout. visibilitychange → hidden fires before beforeunload
    // and in some browsers allows async work to start.

    var _encryptOnUnloadRunning = false;

    function _tryEncryptOnUnload() {
        if (!_deferEncryption || !_cryptoKey || !_db || _encryptOnUnloadRunning) return;
        _encryptOnUnloadRunning = true;
        encryptAllRecords()
            .catch(function(err) {
                console.error('[AminoData] Encrypt-on-unload failed:', err);
            })
            .finally(function() {
                _encryptOnUnloadRunning = false;
            });
    }

    // G-9 fix: Store handler references so they can be removed on logout/re-init
    var _visibilityChangeHandler = function() {
        if (document.visibilityState === 'hidden' && _deferEncryption) {
            _tryEncryptOnUnload();
        }
    };
    var _beforeUnloadHandler = function() {
        _tryEncryptOnUnload();
    };

    document.addEventListener('visibilitychange', _visibilityChangeHandler);
    window.addEventListener('beforeunload', _beforeUnloadHandler);

    // G-9 fix: Remove all module-level event listeners. Called by logout().
    function _removeGlobalListeners() {
        document.removeEventListener('visibilitychange', _visibilityChangeHandler);
        window.removeEventListener('beforeunload', _beforeUnloadHandler);
        stopConnectivityMonitor(); // also removes 'online' listener
    }

    // G-9 fix: Re-register global listeners after logout → re-init cycle.
    function _reregisterGlobalListeners() {
        // Remove first to prevent duplicates
        document.removeEventListener('visibilitychange', _visibilityChangeHandler);
        window.removeEventListener('beforeunload', _beforeUnloadHandler);
        // Re-add
        document.addEventListener('visibilitychange', _visibilityChangeHandler);
        window.addEventListener('beforeunload', _beforeUnloadHandler);
    }

    // ============ Events API (Postgres activity stream) ============
    // On-demand queries for event history — NOT downloaded during hydration.
    // These hit the /amino-events-* webhook endpoints backed by amino.event_log.

    async function fetchEventsForRecord(recordId) {
        var data = await apiFetch(
            '/amino-events-record?recordId=' + encodeURIComponent(recordId),
            'onlineRead'
        );
        // Normalize response: add recordId to each event, map createdAt → created_at
        var events = (data.events || []).map(function(e) {
            return {
                id: e.id,
                recordId: recordId,
                record_id: recordId,
                created_at: e.createdAt,
                operator: e.operator,
                payload: e.payload,
                uuid: e.uuid,
                set: e.set
            };
        });
        return { recordId: data.recordId, count: data.count, events: events };
    }

    async function fetchEventsSince(since, options) {
        options = options || {};
        var params = 'since=' + encodeURIComponent(since);
        if (options.set) params += '&set=' + encodeURIComponent(options.set);
        if (options.limit) params += '&limit=' + encodeURIComponent(options.limit);
        var data = await apiFetch('/amino-events-since?' + params, 'onlineRead');
        var events = (data.events || []).map(function(e) {
            return {
                id: e.id,
                recordId: e.recordId,
                record_id: e.recordId,
                created_at: e.createdAt,
                operator: e.operator,
                payload: e.payload,
                uuid: e.uuid,
                set: e.set
            };
        });
        return { since: data.since, count: data.count, events: events };
    }

    async function fetchEventsBySet(set, limit) {
        var params = 'set=' + encodeURIComponent(set);
        if (limit) params += '&limit=' + encodeURIComponent(limit);
        var data = await apiFetch('/amino-events-set?' + params, 'onlineRead');
        var events = (data.events || []).map(function(e) {
            return {
                id: e.id,
                recordId: e.recordId,
                record_id: e.recordId,
                created_at: e.createdAt,
                operator: e.operator,
                payload: e.payload,
                uuid: e.uuid,
                set: e.set
            };
        });
        return { set: data.set, count: data.count, events: events };
    }

    // ============ Public API ============

    return {
        // Initialization
        init: init,
        initWithKey: initWithKey,
        prepareKey: prepareKey,
        hydrateAll: hydrateAll,
        hydrateAllFromPostgres: hydrateAllFromPostgres,
        initAndHydrate: initAndHydrate,
        restoreSession: restoreSession,

        // Data access (decrypted)
        getTableRecords: getTableRecords,
        getRecord: getRecord,
        searchRecords: searchRecords,
        searchRecordsFast: searchRecordsFast,
        getSearchIndex: getSearchIndex,
        getTableRecordsCached: getTableRecordsCached,
        getRecordCached: getRecordCached,
        getTables: getTables,

        // Sync
        syncTable: syncTable,
        startPolling: startPolling,
        stopPolling: stopPolling,
        triggerAirtableSync: triggerAirtableSync,
        getAirtableSyncStatus: getAirtableSyncStatus,

        // Event payload decryption (for reading historical room data in UI)
        decryptEventPayload: decryptEventPayload,
        isEncryptedPayload: isEncryptedPayload,

        // View deletion tracking (EO NUL/INS operators via Matrix)
        startViewDeletionSync: startViewDeletionSync,
        stopViewDeletionSync: stopViewDeletionSync,
        deleteView: deleteView,
        restoreView: restoreView,
        getViewDeletionHistory: getViewDeletionHistory,

        // Session lifecycle
        setAccessToken: setAccessToken,
        logout: logout,
        destroy: destroy,
        encryptAllRecords: encryptAllRecords,

        // Offline access
        offlineUnlock: offlineUnlock,
        checkConnectivity: checkConnectivity,
        checkOfflineAccessExpiry: checkOfflineAccessExpiry,
        transitionToOnline: transitionToOnline,
        startConnectivityMonitor: startConnectivityMonitor,
        stopConnectivityMonitor: stopConnectivityMonitor,
        getLastSyncTime: getLastSyncTime,

        // Offline write queue
        queueOfflineMutation: queueOfflineMutation,
        flushPendingMutations: flushPendingMutations,
        getPendingMutationCount: getPendingMutationCount,
        getPendingMutations: getPendingMutations,

        // State
        isInitialized: isInitialized,
        isOffline: isOffline,
        isOnlineOnly: isOnlineOnly,
        setOnlineOnlyMode: setOnlineOnlyMode,
        getTableList: getTableList,
        getTableIds: getTableIds,

        // Sync deduplication (called by editRecord in index.html)
        trackOptimisticWrite: _trackOptimisticWrite,

        // Events API (on-demand Postgres activity stream)
        fetchEventsForRecord: fetchEventsForRecord,
        fetchEventsSince: fetchEventsSince,
        fetchEventsBySet: fetchEventsBySet,

        // Constants (read-only access)
        WEBHOOK_BASE_URL: WEBHOOK_BASE_URL,
        BOX_DOWNLOAD_WEBHOOK: BOX_DOWNLOAD_WEBHOOK
    };
})();
