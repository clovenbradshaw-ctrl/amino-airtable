// ============================================================================
// Amino Client Data Layer
// Treats IndexedDB as the primary read source, and uses n8n webhook APIs
// only to backfill/sync local state so the on-device mirror stays current.
// Stores data in IndexedDB encrypted at rest (AES-GCM), and keeps data in sync via Matrix
// realtime sync or HTTP polling fallback. Builds a tableId <-> matrixRoomId
// lookup map from /api/tables, joins Matrix rooms, and applies incoming
// law.firm.record.mutate and law.firm.schema.object events (ALT/INS/NUL) to IndexedDB records.
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
    var AIRTABLE_SYNC_COOLDOWN = 60000; // 60 seconds minimum between triggers
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
    var _connectivityCheckTimer = null;
    var _tables = [];
    var _tableRoomMap = {}; // tableId -> matrixRoomId
    var _roomTableMap = {}; // matrixRoomId -> tableId (reverse lookup)
    var _matrixSyncRunning = false;
    var _matrixSyncAbort = null;
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

    // ============ Sync Deduplication ============
    // Tracks Matrix event_ids already applied to IndexedDB so duplicate
    // deliveries (own echo via /sync, HTTP polling overlap) are skipped.
    var _processedEventIds = {};         // event_id -> timestamp (ms)
    var PROCESSED_EVENT_TTL = 300000;    // 5 minutes
    var MAX_PROCESSED_EVENTS = 5000;

    // Records recently written optimistically by editRecord() so that
    // the /sync echo of the same mutation can skip the redundant
    // decrypt → merge → encrypt → write cycle.
    var _optimisticWrites = {};          // recordId -> { fields, ts }
    var OPTIMISTIC_WRITE_TTL = 30000;    // 30 seconds

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

    // ============ Matrix Event Payload Encryption ============

    // Encrypt record fields for inclusion in Matrix events.
    // Returns a JSON-safe object with the ciphertext as base64.
    async function encryptEventPayload(fields) {
        if (!_cryptoKey) throw new Error('Encryption key not initialized');
        var plaintext = JSON.stringify(fields);
        var encryptedBuffer = await encrypt(_cryptoKey, plaintext);
        return {
            _encrypted: true,
            _algorithm: ENCRYPTION_ALGORITHM,
            _userId: _userId,
            _ciphertext: arrayBufferToBase64(encryptedBuffer)
        };
    }

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

    // Returns true if this event_id was already processed; marks it as seen.
    function _markEventProcessed(eventId) {
        if (!eventId) return false;
        if (_processedEventIds[eventId]) return true; // already seen
        _processedEventIds[eventId] = Date.now();
        _pruneProcessedEvents();
        return false;
    }

    // Evict stale entries so the map doesn't grow unbounded.
    function _pruneProcessedEvents() {
        var ids = Object.keys(_processedEventIds);
        if (ids.length <= MAX_PROCESSED_EVENTS) return;
        var now = Date.now();
        for (var i = 0; i < ids.length; i++) {
            if (now - _processedEventIds[ids[i]] > PROCESSED_EVENT_TTL) {
                delete _processedEventIds[ids[i]];
            }
        }
        // If still over limit after TTL prune, drop oldest half
        ids = Object.keys(_processedEventIds);
        if (ids.length > MAX_PROCESSED_EVENTS) {
            ids.sort(function(a, b) { return _processedEventIds[a] - _processedEventIds[b]; });
            var dropCount = Math.floor(ids.length / 2);
            for (var j = 0; j < dropCount; j++) {
                delete _processedEventIds[ids[j]];
            }
        }
    }

    // Record an optimistic write so the /sync echo can be detected.
    function _trackOptimisticWrite(recordId, changedFields) {
        _optimisticWrites[recordId] = {
            fields: changedFields,
            ts: Date.now()
        };
    }

    // Check if an incoming mutation is a redundant echo of a recent
    // optimistic write. Returns true if the event can be safely skipped
    // (same fields already applied locally).
    function _isOptimisticEcho(recordId, incomingFieldOps) {
        var entry = _optimisticWrites[recordId];
        if (!entry) return false;
        if (Date.now() - entry.ts > OPTIMISTIC_WRITE_TTL) {
            delete _optimisticWrites[recordId];
            return false;
        }

        // Compare ALT fields — if every field in the incoming ALT matches
        // what we wrote optimistically, it's an echo.
        var alt = incomingFieldOps.ALT;
        if (!alt) return false;

        var optimistic = entry.fields;
        var altKeys = Object.keys(alt);
        for (var i = 0; i < altKeys.length; i++) {
            var key = altKeys[i];
            // Stringify comparison handles objects/arrays
            if (JSON.stringify(alt[key]) !== JSON.stringify(optimistic[key])) {
                return false;
            }
        }

        // Match — clear the entry and signal skip
        delete _optimisticWrites[recordId];
        return true;
    }

    // Prune expired optimistic writes (called periodically).
    function _pruneOptimisticWrites() {
        var now = Date.now();
        var ids = Object.keys(_optimisticWrites);
        for (var i = 0; i < ids.length; i++) {
            if (now - _optimisticWrites[ids[i]].ts > OPTIMISTIC_WRITE_TTL) {
                delete _optimisticWrites[ids[i]];
            }
        }
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
            incrementalBackfill: true
        };
        if (!allowedIntents[intent]) {
            throw new Error('apiFetch requires a sync intent (metadataSync/fullBackfill/incrementalBackfill)');
        }

        var MAX_RETRIES = 2;
        var lastErr = null;

        for (var attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            if (attempt > 0) {
                var delay = attempt === 1 ? 1000 : 3000;
                console.log('[AminoData] Retry ' + attempt + '/' + MAX_RETRIES + ' for ' + path + ' (waiting ' + delay + 'ms)');
                await new Promise(function(r) { setTimeout(r, delay); });
            }

            // Auth: POST with access_token in JSON body + query-param fallback.
            var separator = path.indexOf('?') === -1 ? '?' : '&';
            var url = WEBHOOK_BASE_URL + path + separator + 'access_token=' + encodeURIComponent(_accessToken);

            var response;
            try {
                response = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ access_token: _accessToken })
                });
            } catch (fetchErr) {
                // Network / CORS failure — try header auth as last resort
                console.warn('[AminoData] POST fetch failed (' + fetchErr.message + '), retrying with header auth for ' + path);
                try {
                    response = await fetch(WEBHOOK_BASE_URL + path, {
                        method: 'POST',
                        headers: {
                            'Authorization': 'Bearer ' + _accessToken,
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({ access_token: _accessToken })
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
                        method: 'POST',
                        headers: {
                            'Authorization': 'Bearer ' + _accessToken,
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({ access_token: _accessToken })
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

            return response.json();
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

        // Build tableId <-> matrixRoomId lookup maps
        _tableRoomMap = {};
        _roomTableMap = {};
        for (var j = 0; j < tables.length; j++) {
            var t = tables[j];
            if (t.matrix_room_id) {
                _tableRoomMap[t.table_id] = t.matrix_room_id;
                _roomTableMap[t.matrix_room_id] = t.table_id;
            }
        }
        console.log('[AminoData] Built table-room map:', Object.keys(_tableRoomMap).length, 'mappings');

        return tables;
    }

    async function loadTablesFromCache() {
        if (!_db) throw new Error('Data layer not initialized');

        var tx = _db.transaction('tables', 'readonly');
        var tables = await idbGetAll(tx.objectStore('tables'));

        _tables = tables;
        _tableIds = tables.map(function(t) { return t.table_id; });

        _tableRoomMap = {};
        _roomTableMap = {};
        for (var j = 0; j < tables.length; j++) {
            var t = tables[j];
            if (t.matrix_room_id) {
                _tableRoomMap[t.table_id] = t.matrix_room_id;
                _roomTableMap[t.matrix_room_id] = t.table_id;
            }
        }

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
        var encryptedFields = await encrypt(_cryptoKey, JSON.stringify(normalizedRecord.fields));
        await idbPut(store, {
            id: normalizedRecord.id,
            tableId: normalizedRecord.tableId,
            tableName: normalizedRecord.tableName,
            fields: encryptedFields, // ArrayBuffer — encrypted
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
            var encryptedFields = await encrypt(_cryptoKey, JSON.stringify(normalizedRecord.fields));
            return {
                entry: {
                    id: normalizedRecord.id,
                    tableId: normalizedRecord.tableId,
                    tableName: normalizedRecord.tableName,
                    fields: encryptedFields,
                    lastSynced: normalizedRecord.lastSynced
                },
                normalizedRecord: normalizedRecord
            };
        }));
    }

    async function decryptRecord(entry) {
        var fields = JSON.parse(await decrypt(_cryptoKey, entry.fields));
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

    function cacheRecord(record) {
        if (!record || !record.id || !record.tableId) return;
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
        var payload = content.payload || content;
        var fieldOps = payload.fields || {};

        // Support flat format: { recordId, op, fields: { key: val } }
        if (!fieldOps.ALT && !fieldOps.INS && !fieldOps.NUL && content.op && content.fields) {
            fieldOps = {};
            if (content.op === 'INS' || content.op === 'ALT') {
                fieldOps[content.op] = content.fields;
            } else if (content.op === 'NUL') {
                fieldOps.NUL = content.fields;
            }
        }

        return fieldOps;
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

    async function rebuildTableFromRoom(tableId) {
        var roomId = _tableRoomMap[tableId];
        if (!roomId) throw new Error('No Matrix room mapped for table: ' + tableId);
        if (!MatrixClient || !MatrixClient.isLoggedIn()) {
            throw new Error('Matrix client unavailable for room-based rebuild');
        }

        console.warn('[AminoData] Rebuilding table from room history:', tableId, roomId);

        var recordStates = {}; // recordId -> { fields, resolved }
        var pageSize = 200;
        var maxPages = 1000;
        var paginationToken = null;

        for (var page = 0; page < maxPages; page++) {
            var options = {
                dir: 'b', // newest first
                limit: pageSize,
                filter: { types: ['law.firm.record.mutate'] }
            };
            if (paginationToken) options.from = paginationToken;

            var response = await MatrixClient.getRoomMessages(roomId, options);
            if (!response || !response.chunk || response.chunk.length === 0) break;

            var chunk = response.chunk;
            for (var i = 0; i < chunk.length; i++) {
                var evt = chunk[i];
                if (!evt.content || !evt.content.recordId) continue;

                var content = evt.content;
                var payloadSet = content.payload && content.payload._set;
                if (payloadSet === 'table' || payloadSet === 'field' || payloadSet === 'view' || payloadSet === 'viewConfig' || payloadSet === 'tableSettings') {
                    continue;
                }

                if (isEncryptedPayload(content)) {
                    try {
                        var decryptedFields = await decryptEventPayload(content);
                        content = {
                            recordId: content.recordId,
                            tableId: content.tableId,
                            op: content.op || 'ALT',
                            payload: content.payload,
                            set: content.set,
                            fields: decryptedFields
                        };
                    } catch (decErr) {
                        continue;
                    }
                }

                var recordId = content.recordId;
                var state = recordStates[recordId];
                if (!state) {
                    state = { fields: {}, resolved: {} };
                    recordStates[recordId] = state;
                }

                var fieldOps = normalizeFieldOps(content);

                if (fieldOps.NUL) {
                    var nulFields = Array.isArray(fieldOps.NUL) ? fieldOps.NUL : Object.keys(fieldOps.NUL);
                    for (var n = 0; n < nulFields.length; n++) {
                        if (!state.resolved[nulFields[n]]) state.resolved[nulFields[n]] = true;
                    }
                }

                var assignOps = ['ALT', 'INS'];
                for (var a = 0; a < assignOps.length; a++) {
                    var opName = assignOps[a];
                    var opFields = fieldOps[opName];
                    if (!opFields) continue;
                    var keys = Object.keys(opFields);
                    for (var k = 0; k < keys.length; k++) {
                        var key = keys[k];
                        if (!state.resolved[key]) {
                            state.fields[key] = opFields[key];
                            state.resolved[key] = true;
                        }
                    }
                }
            }

            if (!response.end || chunk.length < pageSize) break;
            paginationToken = response.end;
        }

        await deleteTableRecords(tableId);

        var recordIds = Object.keys(recordStates);
        var tableName = tableId;
        for (var t = 0; t < _tables.length; t++) {
            if (_tables[t].table_id === tableId) {
                tableName = _tables[t].table_name || tableId;
                break;
            }
        }

        var BATCH_SIZE = 200;
        for (var b = 0; b < recordIds.length; b += BATCH_SIZE) {
            var batchIds = recordIds.slice(b, b + BATCH_SIZE);
            var writeTx = _db.transaction('records', 'readwrite');
            var writeStore = writeTx.objectStore('records');

            for (var r = 0; r < batchIds.length; r++) {
                var recId = batchIds[r];
                var fields = recordStates[recId].fields;
                var encryptedFields = await encrypt(_cryptoKey, JSON.stringify(fields));
                await idbPut(writeStore, {
                    id: recId,
                    tableId: tableId,
                    tableName: tableName,
                    fields: encryptedFields,
                    lastSynced: new Date().toISOString()
                });
            }
            await idbTxDone(writeTx);
        }

        var syncTx = _db.transaction('sync', 'readwrite');
        await idbPut(syncTx.objectStore('sync'), {
            tableId: tableId,
            lastSynced: new Date().toISOString()
        });
        await idbTxDone(syncTx);

        var rebuildTx = _db.transaction('records', 'readonly');
        var rebuildIndex = rebuildTx.objectStore('records').index('byTable');
        var rebuildEntries = await idbGetAll(rebuildIndex, tableId);
        var rebuiltRecords = await Promise.all(rebuildEntries.map(function(entry) {
            return decryptRecord(entry);
        }));
        cacheFullTable(tableId, rebuiltRecords);

        console.warn('[AminoData] Rebuilt', recordIds.length, 'records for table', tableId, 'from Matrix room history');
        return recordIds.length;
    }

    // ============ Hydration & Sync ============

    // Primary hydration: bulk download all records from Box via n8n webhook.
    // Returns total record count on success, or throws so caller can fall back.
    async function hydrateFromBoxDownload(onProgress) {
        if (!_accessToken) throw new Error('Not authenticated');

        console.log('[AminoData] Attempting primary hydration via box-download webhook');
        var url = BOX_DOWNLOAD_WEBHOOK + '?access_token=' + encodeURIComponent(_accessToken);

        var response;
        try {
            response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + _accessToken
                },
                body: JSON.stringify({ access_token: _accessToken })
            });
        } catch (fetchErr) {
            throw new Error('Box download unreachable: ' + fetchErr.message);
        }

        if (!response.ok) {
            throw new Error('Box download failed: HTTP ' + response.status);
        }

        var data = await response.json();

        // Expect either:
        //   { records: [ { id, table_id|tableId, fields, ... }, ... ] }
        //   { tables: { tableId: [ records ] } }
        //   or a flat array of records
        var allRecords = [];
        if (Array.isArray(data)) {
            allRecords = data;
        } else if (data && Array.isArray(data.records)) {
            allRecords = data.records;
        } else if (data && typeof data.tables === 'object' && !Array.isArray(data.tables)) {
            // Records grouped by table
            var tableKeys = Object.keys(data.tables);
            for (var t = 0; t < tableKeys.length; t++) {
                var tRecords = data.tables[tableKeys[t]];
                if (Array.isArray(tRecords)) {
                    for (var r = 0; r < tRecords.length; r++) {
                        tRecords[r].tableId = tRecords[r].tableId || tRecords[r].table_id || tableKeys[t];
                        allRecords.push(tRecords[r]);
                    }
                }
            }
        }

        if (!allRecords.length) {
            throw new Error('Box download returned no records');
        }

        console.log('[AminoData] Box download received', allRecords.length, 'records, grouping by table');

        // Group records by tableId
        var byTable = {};
        for (var i = 0; i < allRecords.length; i++) {
            var rec = allRecords[i];
            var tableId = rec.tableId || rec.table_id;
            if (!tableId) continue;
            if (!byTable[tableId]) byTable[tableId] = [];
            byTable[tableId].push(rec);
        }

        var tableIds = Object.keys(byTable);
        var totalHydrated = 0;

        for (var j = 0; j < tableIds.length; j++) {
            var tid = tableIds[j];
            var records = byTable[tid];

            // Clear existing rows for this table so stale records don't linger
            await deleteTableRecords(tid);

            // Write in batches
            var BATCH_SIZE = 200;
            for (var b = 0; b < records.length; b += BATCH_SIZE) {
                var batch = records.slice(b, b + BATCH_SIZE);
                var encryptedBatch = await prepareEncryptedRecords(batch, tid);
                var tx = _db.transaction('records', 'readwrite');
                var store = tx.objectStore('records');
                for (var k = 0; k < encryptedBatch.length; k++) {
                    await idbPut(store, encryptedBatch[k].entry);
                    cacheRecord(encryptedBatch[k].normalizedRecord);
                }
                await idbTxDone(tx);
            }

            // Update sync cursor
            var syncTx = _db.transaction('sync', 'readwrite');
            await idbPut(syncTx.objectStore('sync'), {
                tableId: tid,
                lastSynced: new Date().toISOString()
            });
            await idbTxDone(syncTx);

            cacheFullTable(tid, records.map(function(record) {
                return {
                    id: record.id,
                    tableId: tid,
                    tableName: record.tableName || record.table_name || tid,
                    fields: record.fields || {},
                    lastSynced: record.lastSynced || new Date().toISOString()
                };
            }));

            totalHydrated += records.length;

            if (onProgress) {
                onProgress({
                    tableId: tid,
                    tableName: (byTable[tid][0] || {}).tableName || (byTable[tid][0] || {}).table_name || tid,
                    tableIndex: j,
                    tableCount: tableIds.length,
                    recordCount: records.length,
                    totalRecords: totalHydrated
                });
            }

            console.log('[AminoData] Box hydrated', records.length, 'records for table', tid);
        }

        console.log('[AminoData] Box download hydration complete:', totalHydrated, 'total records across', tableIds.length, 'tables');
        return totalHydrated;
    }

    async function hydrateTable(tableId) {
        console.log('[AminoData] Hydrating table:', tableId);

        // ── Prefer room-based hydration (Given-Log) when Matrix is available.
        // The room timeline is the append-only source of truth. amino.current_state
        // (served by /amino-records) is a materialized projection that may be stale
        // or lag behind n8n processing. Rebuilding from the room guarantees the
        // client sees every event the Given-Log contains.
        if (_tableRoomMap[tableId] && MatrixClient && MatrixClient.isLoggedIn()) {
            try {
                var roomCount = await rebuildTableFromRoom(tableId);
                console.log('[AminoData] Hydrated', roomCount, 'records from room for table', tableId);
                return roomCount;
            } catch (roomErr) {
                console.warn('[AminoData] Room-based hydration failed for table ' + tableId +
                    ', falling back to amino.current_state:', roomErr.message || roomErr);
            }
        }

        // ── Fallback: hydrate from amino.current_state via n8n API.
        // Used when Matrix is unavailable (no room mapping, not logged in,
        // or room rebuild failed).
        var records = [];
        try {
            var data = await apiFetch('/amino-records?tableId=' + encodeURIComponent(tableId), 'fullBackfill');
            records = data.records || [];
        } catch (err) {
            console.warn('[AminoData] API hydrate also failed for table ' + tableId + ':', err.message || err);
            throw err;
        }

        // Full hydration should mirror current server state.
        // Clear existing table rows first so deleted upstream records
        // do not linger as stale local entries.
        await deleteTableRecords(tableId);

        // Write records in batches to avoid holding a single long transaction
        var BATCH_SIZE = 200;
        for (var b = 0; b < records.length; b += BATCH_SIZE) {
            var batch = records.slice(b, b + BATCH_SIZE);
            var encryptedBatch = await prepareEncryptedRecords(batch, tableId);
            var tx = _db.transaction('records', 'readwrite');
            var store = tx.objectStore('records');
            for (var i = 0; i < encryptedBatch.length; i++) {
                await idbPut(store, encryptedBatch[i].entry);
                cacheRecord(encryptedBatch[i].normalizedRecord);
            }
            await idbTxDone(tx);
        }

        // Update sync cursor
        var syncTx = _db.transaction('sync', 'readwrite');
        await idbPut(syncTx.objectStore('sync'), {
            tableId: tableId,
            lastSynced: new Date().toISOString()
        });
        await idbTxDone(syncTx);

        cacheFullTable(tableId, records.map(function(record) {
            return {
                id: record.id,
                tableId: tableId,
                tableName: record.tableName || tableId,
                fields: record.fields || {},
                lastSynced: record.lastSynced || new Date().toISOString()
            };
        }));

        console.log('[AminoData] Hydrated', records.length, 'records from API for table', tableId);
        return records.length;
    }

    async function syncTable(tableId) {
        var syncTx = _db.transaction('sync', 'readonly');
        var syncRecord = await idbGet(syncTx.objectStore('sync'), tableId);
        var since = syncRecord ? syncRecord.lastSynced : null;

        if (!since) {
            return hydrateTable(tableId);
        }

        var data = await apiFetch(
            '/amino-records-since?tableId=' + encodeURIComponent(tableId) +
            '&since=' + encodeURIComponent(since),
            'incrementalBackfill'
        );
        var records = data.records || [];

        if (records.length > 0) {
            var BATCH_SIZE = 200;
            for (var b = 0; b < records.length; b += BATCH_SIZE) {
                var batch = records.slice(b, b + BATCH_SIZE);
                var encryptedBatch = await prepareEncryptedRecords(batch, tableId);
                var tx = _db.transaction('records', 'readwrite');
                var store = tx.objectStore('records');
                for (var i = 0; i < encryptedBatch.length; i++) {
                    await idbPut(store, encryptedBatch[i].entry);
                    cacheRecord(encryptedBatch[i].normalizedRecord);
                }
                await idbTxDone(tx);
            }
        }

        var updateTx = _db.transaction('sync', 'readwrite');
        await idbPut(updateTx.objectStore('sync'), {
            tableId: tableId,
            lastSynced: new Date().toISOString()
        });
        await idbTxDone(updateTx);

        return records.length;
    }

    // ============ Matrix Realtime Sync ============

    // Join all Matrix rooms that correspond to tables in the table-room map.
    // Uses a lightweight /sync to detect which rooms the user has already joined,
    // requests bot invites for unjoined rooms via /webhook/amino-invite, then
    // calls /join on each. The optional onProgress callback receives
    // { phase, joined, total, current } updates for UI feedback.
    async function joinTableRooms(onProgress) {
        if (!MatrixClient || !MatrixClient.isLoggedIn()) {
            console.warn('[AminoData] MatrixClient not available or not logged in, skipping room join');
            return [];
        }

        var roomIds = Object.values(_tableRoomMap);
        if (roomIds.length === 0) return [];

        // Step 1: Lightweight /sync to discover already-joined rooms
        var homeserverUrl = MatrixClient.getHomeserverUrl();
        var accessToken = MatrixClient.getAccessToken();
        var userId = MatrixClient.getUserId();
        var joinedRoomIds = new Set();
        try {
            var syncFilter = JSON.stringify({
                room: { timeline: { limit: 0 }, state: { types: [] }, ephemeral: { types: [] }, account_data: { types: [] } },
                presence: { types: [] },
                account_data: { types: [] }
            });
            var syncRes = await fetch(
                homeserverUrl + '/_matrix/client/v3/sync?filter=' + encodeURIComponent(syncFilter) + '&timeout=0',
                { headers: { 'Authorization': 'Bearer ' + accessToken } }
            );
            if (syncRes.ok) {
                var syncData = await syncRes.json();
                var joinRooms = (syncData.rooms && syncData.rooms.join) || {};
                for (var rid in joinRooms) {
                    joinedRoomIds.add(rid);
                }
            }
        } catch (syncErr) {
            console.warn('[AminoData] Membership sync check failed, will attempt all joins:', syncErr.message);
        }

        // Step 2: Identify rooms the user hasn't joined
        var unjoinedRoomIds = roomIds.filter(function(id) { return !joinedRoomIds.has(id); });
        console.log('[AminoData] Room membership: ' + joinedRoomIds.size + ' already joined, ' + unjoinedRoomIds.length + ' to join');

        if (unjoinedRoomIds.length === 0) {
            console.log('[AminoData] Already a member of all ' + roomIds.length + ' table rooms');
            return roomIds;
        }

        if (onProgress) onProgress({ phase: 'inviting', joined: 0, total: unjoinedRoomIds.length, current: null });

        // Step 3: Ask the bot to invite us into all rooms
        try {
            var inviteRes = await fetch(WEBHOOK_BASE_URL + '/amino-invite', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId: userId, access_token: _accessToken })
            });
            var inviteData = await inviteRes.json();
            console.log('[AminoData] Invite response:', inviteData.message || ('invited to ' + (inviteData.roomsInvited || 0) + ' rooms'));
        } catch (inviteErr) {
            console.warn('[AminoData] Invite request failed:', inviteErr.message);
            // Continue anyway — some rooms may be public / already invited
        }

        // Small delay for invites to propagate through Synapse
        await new Promise(function(r) { setTimeout(r, 1000); });

        // Step 4: Join each unjoined room
        if (onProgress) onProgress({ phase: 'joining', joined: 0, total: unjoinedRoomIds.length, current: null });

        var joined = [];
        var failed = [];
        for (var i = 0; i < unjoinedRoomIds.length; i++) {
            var roomId = unjoinedRoomIds[i];
            // Reverse-lookup table name for logging
            var tableId = _roomTableMap[roomId];
            try {
                await MatrixClient.joinRoom(roomId);
                joined.push(roomId);
            } catch (err) {
                console.warn('[AminoData] Failed to join room', roomId, '(table ' + tableId + '):', err.message || err.errcode);
                failed.push(roomId);
            }
            if (onProgress) onProgress({ phase: 'joining', joined: joined.length, total: unjoinedRoomIds.length, current: tableId });
        }

        // Include previously-joined rooms in the result
        var allJoined = roomIds.filter(function(id) {
            return joinedRoomIds.has(id) || joined.indexOf(id) !== -1;
        });

        console.log('[AminoData] Room membership complete: ' + joined.length + ' newly joined, ' + failed.length + ' failed, ' + allJoined.length + ' total');
        return allJoined;
    }

    // Apply a law.firm.record.mutate or law.firm.schema.object event to a record in IndexedDB
    async function applyMutateEvent(event, roomId) {
        var content = event.content;
        if (!content) return;

        // ── Dedup: skip events already processed via another sync channel ──
        var eventId = event.event_id;
        if (_markEventProcessed(eventId)) {
            return; // Already applied
        }

        // Skip metadata records (table/field/view definitions) — only process data records
        var payloadSet = content.payload && content.payload._set;
        if (payloadSet === 'table' || payloadSet === 'field' || payloadSet === 'view' || payloadSet === 'viewConfig' || payloadSet === 'tableSettings') {
            return;
        }

        // Handle encrypted event payloads — decrypt before processing
        if (isEncryptedPayload(content)) {
            try {
                var decryptedFields = await decryptEventPayload(content);
                // Reconstruct content with decrypted fields
                content = {
                    recordId: content.recordId,
                    tableId: content.tableId,
                    op: content.op || 'ALT',
                    fields: decryptedFields
                };
            } catch (err) {
                console.warn('[AminoData] Could not decrypt event payload (may be encrypted for another user):', err.message);
                return;
            }
        }

        if (!content.recordId) return;

        var recordId = content.recordId;
        var tableId = _roomTableMap[roomId];

        // Fallback: derive tableId from the set field (strip airtable: prefix)
        if (!tableId && content.set) {
            tableId = content.set.replace(/^airtable:/, '');
        }
        if (!tableId) {
            console.warn('[AminoData] Cannot determine tableId for mutate event in room', roomId);
            return;
        }

        // Read existing record from IndexedDB
        var tx = _db.transaction('records', 'readonly');
        var existing = await idbGet(tx.objectStore('records'), recordId);

        var fields;
        if (existing) {
            // Decrypt existing fields
            fields = JSON.parse(await decrypt(_cryptoKey, existing.fields));
        } else {
            fields = {};
        }

        // Apply field-level operations from the payload
        var payload = content.payload || content;
        var rawFieldOps = payload.fields || {};
        var hadFlatOps = !rawFieldOps.ALT && !rawFieldOps.INS && !rawFieldOps.NUL && content.op && content.fields;
        var fieldOps = normalizeFieldOps(content);

        // ── Echo suppression: skip if this is the /sync echo of a recent
        // optimistic write — the local state already has these values.
        if (_isOptimisticEcho(recordId, fieldOps)) {
            console.log('[AminoData] Skipping echo for optimistic write:', recordId);
            // Still emit the mutation event so field history records the event_id,
            // but skip the redundant decrypt→merge→encrypt→write cycle.
            window.dispatchEvent(new CustomEvent('amino:record-mutate', {
                detail: {
                    recordId: recordId,
                    tableId: tableId,
                    eventId: eventId,
                    sender: event.sender || null,
                    timestamp: event.origin_server_ts || Date.now(),
                    fieldOps: fieldOps,
                    source: content.source || null,
                    sourceTimestamp: content.sourceTimestamp || null,
                    actor: (payload && payload._a) || null,
                    device: (payload && payload._d) || content.device || null,
                    echoSuppressed: true
                }
            }));
            return;
        }

        // ALT — merge altered fields over existing values
        if (fieldOps.ALT) {
            var altKeys = Object.keys(fieldOps.ALT);
            for (var a = 0; a < altKeys.length; a++) {
                fields[altKeys[a]] = fieldOps.ALT[altKeys[a]];
            }
        }

        // INS — insert new fields
        if (fieldOps.INS) {
            var insKeys = Object.keys(fieldOps.INS);
            for (var n = 0; n < insKeys.length; n++) {
                fields[insKeys[n]] = fieldOps.INS[insKeys[n]];
            }
        }

        // NUL — remove (nullify) fields
        if (fieldOps.NUL) {
            var nulFields = Array.isArray(fieldOps.NUL) ? fieldOps.NUL : Object.keys(fieldOps.NUL);
            for (var d = 0; d < nulFields.length; d++) {
                delete fields[nulFields[d]];
            }
        }

        // Encrypt and write back
        var encryptedFields = await encrypt(_cryptoKey, JSON.stringify(fields));
        var writeTx = _db.transaction('records', 'readwrite');
        await idbPut(writeTx.objectStore('records'), {
            id: recordId,
            tableId: tableId,
            tableName: (existing && existing.tableName) || tableId,
            fields: encryptedFields,
            lastSynced: new Date().toISOString()
        });
        await idbTxDone(writeTx);

        cacheRecord({
            id: recordId,
            tableId: tableId,
            tableName: (existing && existing.tableName) || tableId,
            fields: fields,
            lastSynced: new Date().toISOString()
        });

        // Emit sync event so UI can react
        window.dispatchEvent(new CustomEvent('amino:record-update', {
            detail: { recordId: recordId, tableId: tableId, source: 'matrix' }
        }));

        // Emit detailed mutation event for field history tracking
        var mutationDetail = {
            recordId: recordId,
            tableId: tableId,
            eventId: event.event_id || null,
            sender: event.sender || null,
            timestamp: event.origin_server_ts || Date.now(),
            fieldOps: fieldOps,
            // Metadata from event payload
            source: content.source || null,
            sourceTimestamp: content.sourceTimestamp || null,
            actor: (payload && payload._a) || null,
            device: (payload && payload._d) || content.device || null
        };
        // Include flat ops if that was the format used
        if (hadFlatOps) {
            mutationDetail.flatOp = content.op;
            mutationDetail.flatFields = content.fields;
        }
        window.dispatchEvent(new CustomEvent('amino:record-mutate', {
            detail: mutationDetail
        }));
    }

    // Process timeline events from a Matrix /sync response
    function processMatrixSyncResponse(syncData) {
        if (!syncData || !syncData.rooms || !syncData.rooms.join) return 0;

        var updated = 0;
        var joinedRooms = syncData.rooms.join;
        var roomIds = Object.keys(joinedRooms);

        for (var i = 0; i < roomIds.length; i++) {
            var roomId = roomIds[i];
            var room = joinedRooms[roomId];

            // Only process rooms we care about (rooms in our table-room map)
            if (!_roomTableMap[roomId]) continue;

            if (room.timeline && room.timeline.events) {
                var events = room.timeline.events;
                for (var e = 0; e < events.length; e++) {
                    var event = events[e];
                    if (event.type === 'law.firm.record.mutate' || event.type === 'law.firm.schema.object') {
                        applyMutateEvent(event, roomId);
                        updated++;
                    }
                }
            }
        }
        return updated;
    }

    // Build a sync filter scoped to only the rooms we care about
    function buildSyncFilter() {
        var roomIds = Object.values(_tableRoomMap);
        return {
            room: {
                rooms: roomIds,
                timeline: {
                    types: ['law.firm.record.mutate', 'law.firm.schema.object'],
                    limit: 100
                },
                state: { lazy_load_members: true, types: [] },
                ephemeral: { types: [] },
                account_data: { types: [] }
            },
            presence: { types: [] },
            account_data: { types: [] }
        };
    }

    // Start long-poll Matrix sync loop
    async function startMatrixSync() {
        if (!MatrixClient || !MatrixClient.isLoggedIn()) {
            console.warn('[AminoData] MatrixClient not available, falling back to HTTP polling');
            return false;
        }

        if (Object.keys(_tableRoomMap).length === 0) {
            console.warn('[AminoData] No table-room mappings, falling back to HTTP polling');
            return false;
        }

        _matrixSyncRunning = true;
        console.log('[AminoData] Starting Matrix realtime sync for', Object.keys(_tableRoomMap).length, 'tables');

        // Run sync loop in the background
        _runSyncLoop();
        return true;
    }

    async function _runSyncLoop() {
        var syncToken = null;
        var filter = JSON.stringify(buildSyncFilter());
        var homeserverUrl = MatrixClient.getHomeserverUrl();

        while (_matrixSyncRunning) {
            try {
                var params = {
                    filter: filter,
                    timeout: '30000' // 30-second long poll
                };
                if (syncToken) {
                    params.since = syncToken;
                }

                // Build URL manually to use the data layer's own fetch
                // (MatrixClient._request is private, so we call the CS API directly)
                var url = homeserverUrl + '/_matrix/client/v3/sync?' + new URLSearchParams(params).toString();

                var controller = new AbortController();
                _matrixSyncAbort = controller;

                var response = await fetch(url, {
                    headers: { 'Authorization': 'Bearer ' + MatrixClient.getAccessToken() },
                    signal: controller.signal
                });

                if (!response.ok) {
                    if (response.status === 429) {
                        // Rate limited — back off
                        var retryData = await response.json().catch(function() { return {}; });
                        var delay = (retryData.retry_after_ms || 5000);
                        console.warn('[AminoData] Matrix sync rate-limited, waiting', delay, 'ms');
                        await new Promise(function(r) { setTimeout(r, delay); });
                        continue;
                    }
                    throw new Error('Sync failed: ' + response.status);
                }

                var data = await response.json();
                syncToken = data.next_batch;

                var updatedCount = processMatrixSyncResponse(data);
                if (updatedCount > 0) {
                    window.dispatchEvent(new CustomEvent('amino:sync', {
                        detail: { source: 'matrix', updatedCount: updatedCount }
                    }));
                }
            } catch (err) {
                if (err.name === 'AbortError') {
                    // Intentionally stopped
                    break;
                }
                console.error('[AminoData] Matrix sync error:', err);
                // Back off on errors
                await new Promise(function(r) { setTimeout(r, 5000); });
            }
        }
    }

    function stopMatrixSync() {
        _matrixSyncRunning = false;
        if (_matrixSyncAbort) {
            _matrixSyncAbort.abort();
            _matrixSyncAbort = null;
        }
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

    // ============ Encrypted Record Writing ============

    // Send an encrypted law.firm.record.mutate event to a Matrix room.
    // The fields are encrypted with the current user's Synapse-derived key
    // so they appear as ciphertext in the Synapse database.
    async function sendEncryptedRecord(roomId, recordId, fields, op) {
        if (!MatrixClient || !MatrixClient.isLoggedIn()) {
            throw new Error('MatrixClient not available or not logged in');
        }
        if (!_cryptoKey) {
            throw new Error('Encryption key not initialized');
        }

        var encPayload = await encryptEventPayload(fields);
        encPayload.recordId = recordId;
        encPayload.op = op || 'ALT';
        encPayload.actor = _userId;
        encPayload.device = MatrixClient.getDeviceId() || null;

        return MatrixClient.sendEvent(roomId, 'law.firm.record.mutate', encPayload);
    }

    // Send an encrypted record to a specific table room (lookup room from tableId).
    async function sendEncryptedTableRecord(tableId, recordId, fields, op) {
        var roomId = _tableRoomMap[tableId];
        if (!roomId) {
            throw new Error('No Matrix room mapped for table: ' + tableId);
        }
        return sendEncryptedRecord(roomId, recordId, fields, op);
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
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ access_token: _accessToken })
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
                try {
                    var count = await syncTable(tableId);
                    if (count > 0) {
                        window.dispatchEvent(new CustomEvent('amino:sync', {
                            detail: { tableId: tableId, updatedCount: count }
                        }));
                    }
                } catch (err) {
                    console.error('[AminoData] Sync failed for ' + tableId + ':', err);
                    if (err.status === 401) {
                        stopPolling();
                        window.dispatchEvent(new CustomEvent('amino:auth-expired'));
                        return;
                    }
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
        cacheFullTable(tableId, results);
        return results.map(function(record) { return cloneRecord(record); });
    }

    async function getRecord(recordId) {
        if (!_db || !_cryptoKey) throw new Error('Data layer not initialized');

        if (_recordCacheById[recordId]) {
            return cloneRecord(_recordCacheById[recordId]);
        }

        var tx = _db.transaction('records', 'readonly');
        var entry = await idbGet(tx.objectStore('records'), recordId);
        if (!entry) return null;
        var record = await decryptRecord(entry);
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

        _initialized = true;
        console.log('[AminoData] Initialized with', _tables.length, 'tables (Synapse-derived encryption)');

        return _tables;
    }

    async function init(accessToken, userId, password) {
        if (!accessToken || !userId || !password) {
            throw new Error('accessToken, userId, and password are required');
        }

        var key = await deriveSynapseKey(password, userId);
        return _initCore(accessToken, userId, key, password);
    }

    // Initialize using a previously exported key from localStorage.
    // Used by sub-pages (layout builder, client profile) that don't have the password.
    async function initWithKey(accessToken, userId) {
        if (!accessToken || !userId) {
            throw new Error('accessToken and userId are required');
        }
        var key = await importKeyFromStorage();
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

        // Primary: try bulk hydration from Box download webhook (~70k records)
        try {
            var boxTotal = await hydrateFromBoxDownload(onProgress);
            console.log('[AminoData] Primary hydration (box-download) succeeded:', boxTotal, 'records');
            return boxTotal;
        } catch (boxErr) {
            console.warn('[AminoData] Primary hydration (box-download) failed, falling back to Postgres:', boxErr.message || boxErr);
        }

        // Fallback: per-table hydration from Postgres via /amino-records
        var totalHydrated = 0;
        for (var i = 0; i < _tableIds.length; i++) {
            var tableId = _tableIds[i];
            try {
                var count = await syncTable(tableId);
                totalHydrated += count;
                if (onProgress) {
                    onProgress({
                        tableId: tableId,
                        tableName: (_tables[i] || {}).table_name || tableId,
                        tableIndex: i,
                        tableCount: _tableIds.length,
                        recordCount: count,
                        totalRecords: totalHydrated
                    });
                }
            } catch (err) {
                console.error('[AminoData] Failed to hydrate table ' + tableId + ':', err);
                if (err.status === 401) throw err; // Propagate auth errors
            }
        }
        return totalHydrated;
    }

    async function initAndHydrate(accessToken, userId, password, options) {
        options = options || {};
        var pollInterval = options.pollInterval || DEFAULT_POLL_INTERVAL;
        var onProgress = options.onProgress || null;
        var useMatrixSync = options.useMatrixSync !== false; // default true

        var tables = await init(accessToken, userId, password);
        var totalRecords = await hydrateAll(onProgress);

        // Prefer Matrix realtime sync; fall back to HTTP polling
        var matrixSyncStarted = false;
        if (useMatrixSync) {
            try {
                matrixSyncStarted = await startMatrixSync();
            } catch (err) {
                console.warn('[AminoData] Matrix sync failed to start:', err);
            }
        }

        if (!matrixSyncStarted) {
            console.log('[AminoData] Using HTTP polling for updates');
            startPolling(pollInterval);
        }

        return {
            tables: tables,
            totalRecords: totalRecords,
            tableRoomMap: getTableRoomMap(),
            usingMatrixSync: matrixSyncStarted,
            stopPolling: stopPolling,
            stopMatrixSync: stopMatrixSync
        };
    }

    // ============ Session Lifecycle ============

    function setAccessToken(token) {
        _accessToken = token;
    }

    async function restoreSession(accessToken, userId, password) {
        // For page reloads: re-derive key, incremental sync
        return init(accessToken, userId, password);
    }

    function logout(clearData) {
        stopPolling();
        stopMatrixSync();
        stopViewDeletionSync();
        stopConnectivityMonitor();
        clearKeyFromStorage();
        _cryptoKey = null;
        _accessToken = null;
        _userId = null;
        _tableRoomMap = {};
        _roomTableMap = {};
        _orgSpaceId = null;
        _offlineMode = false;
        _initialized = false;
        _keyDerivationCache = { fingerprint: null, key: null };
        _processedEventIds = {};
        _optimisticWrites = {};
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

    // ============ Record Mutation History ============

    // Fetch the full mutation history for a single record from its table's
    // Matrix room. Paginates forward (oldest-first) through all
    // Fetch a changelog of all mutations across all rooms (tables).
    // Paginates through law.firm.record.mutate events in each room
    // backwards (newest first), merges across rooms, and returns
    // a unified list sorted by timestamp descending.
    //
    // Options:
    //   limit           — max entries to return (default 50)
    //   paginationTokens — object { roomId: token } from previous call for continuation
    //   tableFilter     — optional tableId to filter to a single table
    //
    // Returns: { entries: [...], paginationTokens: { roomId: token }, hasMore: boolean }
    async function getRoomChangelog(options) {
        options = options || {};
        var limit = options.limit || 50;
        var prevTokens = options.paginationTokens || {};
        var tableFilter = options.tableFilter || null;

        if (!MatrixClient || !MatrixClient.isLoggedIn()) {
            throw new Error('MatrixClient not available or not logged in');
        }

        var roomIds = Object.keys(_roomTableMap);
        if (tableFilter) {
            var filterRoom = _tableRoomMap[tableFilter];
            if (!filterRoom) throw new Error('No Matrix room for table: ' + tableFilter);
            roomIds = [filterRoom];
        }

        // Fetch a page from each room (backwards — newest first)
        var perRoomEntries = [];
        var nextTokens = {};
        var anyHasMore = false;

        for (var r = 0; r < roomIds.length; r++) {
            var roomId = roomIds[r];
            var tableId = _roomTableMap[roomId];
            var fromToken = prevTokens[roomId] || undefined;

            // If this room's token is 'exhausted', skip it
            if (fromToken === 'exhausted') {
                nextTokens[roomId] = 'exhausted';
                continue;
            }

            try {
                var msgOpts = {
                    dir: 'b', // backwards — newest first
                    limit: limit,
                    filter: { types: ['law.firm.record.mutate'] }
                };
                if (fromToken) msgOpts.from = fromToken;

                var response = await MatrixClient.getRoomMessages(roomId, msgOpts);
                if (!response || !response.chunk) {
                    nextTokens[roomId] = 'exhausted';
                    continue;
                }

                var chunk = response.chunk;
                for (var i = 0; i < chunk.length; i++) {
                    var evt = chunk[i];
                    if (!evt.content) continue;

                    var content = evt.content;

                    // Decrypt if needed
                    if (isEncryptedPayload(content)) {
                        try {
                            var decryptedFields = await decryptEventPayload(content);
                            content = {
                                recordId: content.recordId,
                                tableId: content.tableId,
                                op: content.op || 'ALT',
                                payload: content.payload,
                                set: content.set,
                                source: content.source,
                                sourceTimestamp: content.sourceTimestamp,
                                fields: decryptedFields
                            };
                        } catch (decErr) {
                            continue; // skip entries we can't decrypt
                        }
                    }

                    var payload = content.payload || {};
                    var fieldOps = payload.fields || {};

                    // Handle flat format
                    if (!fieldOps.ALT && !fieldOps.INS && !fieldOps.NUL && content.op && content.fields) {
                        fieldOps = {};
                        if (content.op === 'INS' || content.op === 'ALT') {
                            fieldOps[content.op] = content.fields;
                        } else if (content.op === 'NUL') {
                            fieldOps.NUL = content.fields;
                        }
                    }

                    perRoomEntries.push({
                        eventId: evt.event_id || null,
                        sender: evt.sender || null,
                        timestamp: evt.origin_server_ts || null,
                        tableId: tableId,
                        recordId: content.recordId || null,
                        op: content.op || 'ALT',
                        source: content.source || null,
                        sourceTimestamp: content.sourceTimestamp || null,
                        actor: payload._a || null,
                        device: payload._d || content.device || null,
                        fieldOps: fieldOps
                    });
                }

                // Update pagination token
                if (response.end && chunk.length >= limit) {
                    nextTokens[roomId] = response.end;
                    anyHasMore = true;
                } else {
                    nextTokens[roomId] = 'exhausted';
                }
            } catch (err) {
                console.warn('[AminoData] Error fetching changelog for room', roomId, err.message);
                nextTokens[roomId] = prevTokens[roomId] || 'exhausted';
            }
        }

        // Sort all entries by timestamp descending (newest first)
        perRoomEntries.sort(function(a, b) {
            return (b.timestamp || 0) - (a.timestamp || 0);
        });

        // Cap to requested limit
        var entries = perRoomEntries.slice(0, limit);
        if (perRoomEntries.length > limit) anyHasMore = true;

        return {
            entries: entries,
            paginationTokens: nextTokens,
            hasMore: anyHasMore
        };
    }

    // law.firm.record.mutate events, filters by recordId client-side,
    // decrypts encrypted payloads, and returns an array of mutation objects
    // in chronological order. Each mutation includes extracted metadata
    // (source, sourceTimestamp, actor) from the event payload.
    //
    // Options:
    //   maxPages  — safety cap on pagination rounds (default 50)
    //   pageSize  — events per /messages request (default 100)
    //   rebuildState — if true, also return reconstructed field state (default false)
    //
    // Returns: { mutations: [...], state?: {...} }
    async function getRecordMutationHistory(tableId, recordId, options) {
        options = options || {};
        var maxPages = options.maxPages || 50;
        var pageSize = options.pageSize || 100;
        var rebuildState = options.rebuildState || false;

        var roomId = _tableRoomMap[tableId];
        if (!roomId) {
            throw new Error('No Matrix room mapped for table: ' + tableId);
        }
        if (!MatrixClient || !MatrixClient.isLoggedIn()) {
            throw new Error('MatrixClient not available or not logged in');
        }

        var mutations = [];
        var paginationToken = null;

        for (var page = 0; page < maxPages; page++) {
            var opts = {
                dir: 'f', // forward — oldest first (chronological)
                limit: pageSize,
                filter: { types: ['law.firm.record.mutate'] }
            };
            if (paginationToken) opts.from = paginationToken;

            var response = await MatrixClient.getRoomMessages(roomId, opts);
            if (!response || !response.chunk) break;

            var chunk = response.chunk;
            for (var i = 0; i < chunk.length; i++) {
                var evt = chunk[i];
                if (!evt.content) continue;

                var content = evt.content;

                // Match by recordId
                if (content.recordId !== recordId) continue;

                // Decrypt encrypted payloads
                if (isEncryptedPayload(content)) {
                    try {
                        var decryptedFields = await decryptEventPayload(content);
                        content = {
                            recordId: content.recordId,
                            tableId: content.tableId,
                            op: content.op || 'ALT',
                            payload: content.payload,
                            set: content.set,
                            source: content.source,
                            sourceTimestamp: content.sourceTimestamp,
                            fields: decryptedFields
                        };
                    } catch (decErr) {
                        console.warn('[AminoData] Could not decrypt history event:', decErr.message);
                        continue;
                    }
                }

                // Extract metadata from payload and top-level fields
                var payload = content.payload || {};
                var mutation = {
                    eventId: evt.event_id || null,
                    sender: evt.sender || null,
                    timestamp: evt.origin_server_ts || null,
                    recordId: recordId,
                    op: content.op || 'ALT',
                    source: content.source || null,
                    sourceTimestamp: content.sourceTimestamp || null,
                    actor: payload._a || null,
                    device: payload._d || content.device || null,
                    formatVersion: payload._f || null,
                    set: content.set || (payload._set ? payload._set : null),
                    fieldOps: payload.fields || {}
                };

                // Handle flat format: { recordId, op, fields: { key: val } }
                if (!mutation.fieldOps.ALT && !mutation.fieldOps.INS && !mutation.fieldOps.NUL && content.op && content.fields) {
                    var flatOp = content.op;
                    if (flatOp === 'INS' || flatOp === 'ALT') {
                        mutation.fieldOps = {};
                        mutation.fieldOps[flatOp] = content.fields;
                    } else if (flatOp === 'NUL') {
                        mutation.fieldOps = { NUL: content.fields };
                    }
                }

                mutations.push(mutation);
            }

            // Check if there are more pages
            if (!response.end || chunk.length < pageSize) break;
            paginationToken = response.end;
        }

        var result = { mutations: mutations };

        // Optionally reconstruct the current state by replaying mutations
        if (rebuildState) {
            var state = {};
            for (var m = 0; m < mutations.length; m++) {
                var ops = mutations[m].fieldOps;
                if (ops.INS) {
                    var insKeys = Object.keys(ops.INS);
                    for (var a = 0; a < insKeys.length; a++) {
                        state[insKeys[a]] = ops.INS[insKeys[a]];
                    }
                }
                if (ops.ALT) {
                    var altKeys = Object.keys(ops.ALT);
                    for (var b = 0; b < altKeys.length; b++) {
                        state[altKeys[b]] = ops.ALT[altKeys[b]];
                    }
                }
                if (ops.NUL) {
                    var nulFields = Array.isArray(ops.NUL) ? ops.NUL : Object.keys(ops.NUL);
                    for (var c = 0; c < nulFields.length; c++) {
                        delete state[nulFields[c]];
                    }
                }
            }
            result.state = state;
        }

        return result;
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

        // Rebuild table-room map from cached tables
        _tableRoomMap = {};
        _roomTableMap = {};
        for (var i = 0; i < _tables.length; i++) {
            var t = _tables[i];
            if (t.matrix_room_id) {
                _tableRoomMap[t.table_id] = t.matrix_room_id;
                _roomTableMap[t.matrix_room_id] = t.table_id;
            }
        }

        _initialized = true;

        // 8. Start connectivity monitoring
        startConnectivityMonitor();

        var lastSynced = await getLastSyncTime();

        console.log('[AminoData] Offline unlock successful for', session.userId,
            '(' + _tables.length + ' cached tables, last synced:', lastSynced + ')');

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

        // Also listen for browser online event
        window.addEventListener('online', function onBrowserOnline() {
            checkConnectivity().then(function(reachable) {
                if (reachable) {
                    window.dispatchEvent(new CustomEvent('amino:connectivity-restored'));
                }
            });
        });

        console.log('[AminoData] Connectivity monitor started (checking every', CONNECTIVITY_CHECK_INTERVAL / 1000 + 's)');
    }

    function stopConnectivityMonitor() {
        if (_connectivityCheckTimer) {
            clearInterval(_connectivityCheckTimer);
            _connectivityCheckTimer = null;
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

        // Start real-time sync
        var matrixSyncStarted = false;
        try {
            matrixSyncStarted = await startMatrixSync();
        } catch (err) {
            console.warn('[AminoData] Matrix sync failed to start after online transition:', err);
        }
        if (!matrixSyncStarted) {
            startPolling();
        }

        console.log('[AminoData] Transitioned to online mode.',
            'Flushed:', flushResult.flushed, 'mutations.',
            'Synced:', syncedRecords, 'records.');

        window.dispatchEvent(new CustomEvent('amino:online-transition', {
            detail: {
                flushed: flushResult.flushed,
                flushFailed: flushResult.failed,
                syncedRecords: syncedRecords,
                usingMatrixSync: matrixSyncStarted
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
            currentFields = JSON.parse(await decrypt(_cryptoKey, existing.fields));
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

        // Encrypt and write back
        var encryptedFields = await encrypt(_cryptoKey, JSON.stringify(currentFields));
        var writeTx = _db.transaction('records', 'readwrite');
        await idbPut(writeTx.objectStore('records'), {
            id: recordId,
            tableId: tableId,
            tableName: (existing && existing.tableName) || tableId,
            fields: encryptedFields,
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

    // Flush all pending mutations to the server (oldest first).
    // Returns { flushed, failed }.
    async function flushPendingMutations() {
        if (!_db) return { flushed: 0, failed: 0 };

        var tx = _db.transaction('pending_mutations', 'readonly');
        var pending = await idbGetAll(tx.objectStore('pending_mutations'));

        if (pending.length === 0) return { flushed: 0, failed: 0 };

        // Sort by timestamp (oldest first) to preserve operation order
        pending.sort(function(a, b) { return a.timestamp - b.timestamp; });

        var flushed = 0;
        var failed = 0;

        for (var i = 0; i < pending.length; i++) {
            var mutation = pending[i];
            try {
                await sendEncryptedTableRecord(
                    mutation.tableId,
                    mutation.recordId,
                    mutation.fields,
                    mutation.op
                );

                // Remove from queue on success
                var delTx = _db.transaction('pending_mutations', 'readwrite');
                delTx.objectStore('pending_mutations').delete(mutation.id);
                await idbTxDone(delTx);

                flushed++;
            } catch (err) {
                console.error('[AminoData] Failed to flush mutation:', mutation.id, err.message || err);
                failed++;
                // Don't remove — will retry on next flush
            }
        }

        if (flushed > 0 || failed > 0) {
            window.dispatchEvent(new CustomEvent('amino:offline-mutations-flushed', {
                detail: { flushed: flushed, failed: failed, remaining: failed }
            }));
        }

        console.log('[AminoData] Flushed', flushed, 'pending mutations (' + failed + ' failed)');
        return { flushed: flushed, failed: failed };
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

    function getTableRoomMap() {
        return Object.assign({}, _tableRoomMap); // Return copy
    }

    function getRoomForTable(tableId) {
        return _tableRoomMap[tableId] || null;
    }

    function getTableForRoom(roomId) {
        return _roomTableMap[roomId] || null;
    }

    function isMatrixSyncActive() {
        return _matrixSyncRunning;
    }

    // ============ Public API ============

    return {
        // Initialization
        init: init,
        initWithKey: initWithKey,
        prepareKey: prepareKey,
        hydrateAll: hydrateAll,
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
        getRecordMutationHistory: getRecordMutationHistory,
        getRoomChangelog: getRoomChangelog,

        // Sync
        syncTable: syncTable,
        startPolling: startPolling,
        stopPolling: stopPolling,
        startMatrixSync: startMatrixSync,
        stopMatrixSync: stopMatrixSync,
        triggerAirtableSync: triggerAirtableSync,
        getAirtableSyncStatus: getAirtableSyncStatus,

        // View deletion tracking (EO NUL/INS operators via Matrix)
        startViewDeletionSync: startViewDeletionSync,
        stopViewDeletionSync: stopViewDeletionSync,
        deleteView: deleteView,
        restoreView: restoreView,
        getViewDeletionHistory: getViewDeletionHistory,

        // Encrypted record writing (fields encrypted in Matrix events)
        sendEncryptedRecord: sendEncryptedRecord,
        sendEncryptedTableRecord: sendEncryptedTableRecord,

        // Event payload encryption utilities
        encryptEventPayload: encryptEventPayload,
        decryptEventPayload: decryptEventPayload,
        isEncryptedPayload: isEncryptedPayload,

        // Session lifecycle
        setAccessToken: setAccessToken,
        logout: logout,
        destroy: destroy,

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
        getTableList: getTableList,
        getTableIds: getTableIds,
        getTableRoomMap: getTableRoomMap,
        getRoomForTable: getRoomForTable,
        getTableForRoom: getTableForRoom,
        isMatrixSyncActive: isMatrixSyncActive,

        // Sync deduplication (called by editRecord in index.html)
        trackOptimisticWrite: _trackOptimisticWrite,

        // Constants (read-only access)
        WEBHOOK_BASE_URL: WEBHOOK_BASE_URL,
        BOX_DOWNLOAD_WEBHOOK: BOX_DOWNLOAD_WEBHOOK
    };
})();
