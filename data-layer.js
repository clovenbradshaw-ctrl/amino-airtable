// ============================================================================
// Amino Client Data Layer
// Hydrates current state from n8n webhook API endpoints, stores data in
// IndexedDB encrypted at rest (AES-GCM), and keeps data in sync via polling.
// Matrix rooms serve as the changelog; this layer handles state hydration.
// ============================================================================

var AminoData = (function() {
    'use strict';

    // ============ Constants ============
    var WEBHOOK_BASE_URL = 'https://n8n.intelechia.com/webhook';
    var DB_NAME = 'amino';
    var DB_VERSION = 1;
    var DEFAULT_POLL_INTERVAL = 15000; // 15 seconds

    // ============ Internal State (memory only) ============
    var _db = null;
    var _cryptoKey = null;
    var _accessToken = null;
    var _userId = null;
    var _pollInterval = null;
    var _tableIds = [];
    var _tables = [];
    var _initialized = false;

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
            false, // not extractable
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

    // ============ API Client ============

    async function apiFetch(path) {
        if (!_accessToken) {
            throw new Error('Not authenticated');
        }

        var response = await fetch(WEBHOOK_BASE_URL + path, {
            headers: { 'Authorization': 'Bearer ' + _accessToken }
        });

        if (response.status === 401) {
            var err = new Error('Authentication expired');
            err.status = 401;
            throw err;
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

    // ============ Table Operations ============

    async function fetchAndStoreTables() {
        var data = await apiFetch('/api/tables');
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

    // ============ Record Encryption Helpers ============

    async function encryptAndStoreRecord(store, record, tableId) {
        var encryptedFields = await encrypt(_cryptoKey, JSON.stringify(record.fields));
        await idbPut(store, {
            id: record.id,
            tableId: tableId,
            tableName: record.tableName,
            fields: encryptedFields, // ArrayBuffer — encrypted
            lastSynced: record.lastSynced
        });
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

    // ============ Hydration & Sync ============

    async function hydrateTable(tableId) {
        console.log('[AminoData] Hydrating table:', tableId);
        var data = await apiFetch('/api/records/' + encodeURIComponent(tableId));
        var records = data.records || [];

        // Write records in batches to avoid holding a single long transaction
        var BATCH_SIZE = 200;
        for (var b = 0; b < records.length; b += BATCH_SIZE) {
            var batch = records.slice(b, b + BATCH_SIZE);
            var tx = _db.transaction('records', 'readwrite');
            var store = tx.objectStore('records');
            for (var i = 0; i < batch.length; i++) {
                await encryptAndStoreRecord(store, batch[i], tableId);
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

        console.log('[AminoData] Hydrated', records.length, 'records for table', tableId);
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
            '/api/records/' + encodeURIComponent(tableId) +
            '/since/' + encodeURIComponent(since)
        );
        var records = data.records || [];

        if (records.length > 0) {
            var BATCH_SIZE = 200;
            for (var b = 0; b < records.length; b += BATCH_SIZE) {
                var batch = records.slice(b, b + BATCH_SIZE);
                var tx = _db.transaction('records', 'readwrite');
                var store = tx.objectStore('records');
                for (var i = 0; i < batch.length; i++) {
                    await encryptAndStoreRecord(store, batch[i], tableId);
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

    // ============ Polling ============

    function startPolling(intervalMs) {
        intervalMs = intervalMs || DEFAULT_POLL_INTERVAL;

        if (_pollInterval) {
            clearInterval(_pollInterval);
        }

        var poll = async function() {
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

        _pollInterval = setInterval(poll, intervalMs);
        poll(); // Run immediately on start
    }

    function stopPolling() {
        if (_pollInterval) {
            clearInterval(_pollInterval);
            _pollInterval = null;
        }
    }

    // ============ Data Accessors (Decrypted) ============

    async function getTableRecords(tableId) {
        if (!_db || !_cryptoKey) throw new Error('Data layer not initialized');

        var tx = _db.transaction('records', 'readonly');
        var index = tx.objectStore('records').index('byTable');
        var entries = await idbGetAll(index, tableId);

        var results = [];
        for (var i = 0; i < entries.length; i++) {
            results.push(await decryptRecord(entries[i]));
        }
        return results;
    }

    async function getRecord(recordId) {
        if (!_db || !_cryptoKey) throw new Error('Data layer not initialized');

        var tx = _db.transaction('records', 'readonly');
        var entry = await idbGet(tx.objectStore('records'), recordId);
        if (!entry) return null;
        return decryptRecord(entry);
    }

    async function searchRecords(tableId, fieldName, searchValue) {
        var records = await getTableRecords(tableId);
        return records.filter(function(r) {
            var val = r.fields[fieldName];
            if (typeof val === 'string') {
                return val.toLowerCase().indexOf(searchValue.toLowerCase()) !== -1;
            }
            return val === searchValue;
        });
    }

    async function getTables() {
        if (!_db) throw new Error('Data layer not initialized');

        var tx = _db.transaction('tables', 'readonly');
        return idbGetAll(tx.objectStore('tables'));
    }

    async function getRecordDirect(recordId) {
        // Fetch a single record directly from the API (bypasses local cache)
        var data = await apiFetch('/api/record/' + encodeURIComponent(recordId));
        return data.record || null;
    }

    // ============ Initialization ============

    async function init(accessToken, userId, password) {
        if (!accessToken || !userId || !password) {
            throw new Error('accessToken, userId, and password are required');
        }

        _accessToken = accessToken;
        _userId = userId;

        // Open database
        _db = await openDatabase();

        // Get or create salt
        var cryptoTx = _db.transaction('crypto', 'readonly');
        var saltEntry = await idbGet(cryptoTx.objectStore('crypto'), 'salt');
        var salt;

        if (!saltEntry) {
            salt = crypto.getRandomValues(new Uint8Array(16));
            var writeTx = _db.transaction('crypto', 'readwrite');
            await idbPut(writeTx.objectStore('crypto'), { key: 'salt', value: salt });
            await idbTxDone(writeTx);
        } else {
            salt = new Uint8Array(saltEntry.value);
        }

        // Derive encryption key
        _cryptoKey = await deriveKey(password, salt);

        // Load table list from API
        await fetchAndStoreTables();

        _initialized = true;
        console.log('[AminoData] Initialized with', _tables.length, 'tables');

        return _tables;
    }

    async function hydrateAll(onProgress) {
        if (!_initialized) throw new Error('Call init() first');

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

        var tables = await init(accessToken, userId, password);
        var totalRecords = await hydrateAll(onProgress);

        // Start polling for live updates
        startPolling(pollInterval);

        return {
            tables: tables,
            totalRecords: totalRecords,
            stopPolling: stopPolling
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
        _cryptoKey = null;
        _accessToken = null;
        _userId = null;
        _initialized = false;

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

    // ============ State Getters ============

    function isInitialized() {
        return _initialized;
    }

    function getTableList() {
        return _tables.slice(); // Return copy
    }

    function getTableIds() {
        return _tableIds.slice();
    }

    // ============ Public API ============

    return {
        // Initialization
        init: init,
        hydrateAll: hydrateAll,
        initAndHydrate: initAndHydrate,
        restoreSession: restoreSession,

        // Data access (decrypted)
        getTableRecords: getTableRecords,
        getRecord: getRecord,
        getRecordDirect: getRecordDirect,
        searchRecords: searchRecords,
        getTables: getTables,

        // Sync
        syncTable: syncTable,
        startPolling: startPolling,
        stopPolling: stopPolling,

        // Session lifecycle
        setAccessToken: setAccessToken,
        logout: logout,
        destroy: destroy,

        // State
        isInitialized: isInitialized,
        getTableList: getTableList,
        getTableIds: getTableIds,

        // Constants (read-only access)
        WEBHOOK_BASE_URL: WEBHOOK_BASE_URL
    };
})();
