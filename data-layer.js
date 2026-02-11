// ============================================================================
// Amino Client Data Layer
// Hydrates current state from n8n webhook API endpoints, stores data in
// IndexedDB encrypted at rest (AES-GCM), and keeps data in sync via Matrix
// realtime sync or HTTP polling fallback. Builds a tableId <-> matrixRoomId
// lookup map from /api/tables, joins Matrix rooms, and applies incoming
// law.firm.record.mutate and law.firm.schema.object events (ALT/INS/NUL) to IndexedDB records.
// ============================================================================

var AminoData = (function() {
    'use strict';

    // ============ Constants ============
    var WEBHOOK_BASE_URL = 'https://n8n.intelechia.com/webhook';
    var DB_NAME = 'amino-data-layer';
    var DB_VERSION = 1;
    var DEFAULT_POLL_INTERVAL = 15000; // 15 seconds
    var SYNAPSE_SALT_PREFIX = 'amino-local-encrypt:';
    var ENCRYPTION_ALGORITHM = 'aes-gcm-256';
    var AIRTABLE_SYNC_WEBHOOK = 'https://n8n.intelechia.com/webhook/c875f674-9228-45ae-b6ec-10870df8a403';
    var AIRTABLE_SYNC_COOLDOWN = 60000; // 60 seconds minimum between triggers

    // ============ Internal State (memory only) ============
    var _db = null;
    var _cryptoKey = null;
    var _accessToken = null;
    var _userId = null;
    var _pollInterval = null;
    var _tableIds = [];
    var _tables = [];
    var _tableRoomMap = {}; // tableId -> matrixRoomId
    var _roomTableMap = {}; // matrixRoomId -> tableId (reverse lookup)
    var _matrixSyncRunning = false;
    var _matrixSyncAbort = null;
    var _initialized = false;
    var _lastAirtableSyncTrigger = 0;
    var _airtableSyncInFlight = false;

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

    // ============ Synapse-Derived Encryption ============

    // Derive encryption key from Synapse password + userId (deterministic salt).
    // This ties the encryption directly to the authenticated Synapse user —
    // different users get different keys, and re-login regenerates the same key.
    async function deriveSynapseKey(password, userId) {
        var encoder = new TextEncoder();
        var salt = encoder.encode(SYNAPSE_SALT_PREFIX + userId);
        return deriveKey(password, salt);
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

        var MAX_RETRIES = 2;
        var lastErr = null;

        for (var attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            if (attempt > 0) {
                var delay = attempt === 1 ? 1000 : 3000;
                console.log('[AminoData] Retry ' + attempt + '/' + MAX_RETRIES + ' for ' + path + ' (waiting ' + delay + 'ms)');
                await new Promise(function(r) { setTimeout(r, delay); });
            }

            // Use query-param auth by default to avoid CORS preflight.
            var separator = path.indexOf('?') === -1 ? '?' : '&';
            var url = WEBHOOK_BASE_URL + path + separator + 'access_token=' + encodeURIComponent(_accessToken);

            var response;
            try {
                response = await fetch(url);
            } catch (fetchErr) {
                // Network / CORS failure — try header auth as last resort
                console.warn('[AminoData] Query-param fetch failed (' + fetchErr.message + '), retrying with header auth for ' + path);
                try {
                    response = await fetch(WEBHOOK_BASE_URL + path, {
                        headers: { 'Authorization': 'Bearer ' + _accessToken }
                    });
                } catch (headerErr) {
                    lastErr = new Error('API unreachable (CORS/network): ' + headerErr.message);
                    continue;
                }
            }

            if (response.status === 401) {
                // Query-param token may not have been recognised — retry with header
                console.warn('[AminoData] 401 with query-param auth, retrying with header auth for ' + path);
                try {
                    response = await fetch(WEBHOOK_BASE_URL + path, {
                        headers: { 'Authorization': 'Bearer ' + _accessToken }
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
        var data = await apiFetch('/amino-tables');
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
        var data = await apiFetch('/amino-records?tableId=' + encodeURIComponent(tableId));
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
            '/amino-records-since?tableId=' + encodeURIComponent(tableId) +
            '&since=' + encodeURIComponent(since)
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
                body: JSON.stringify({ userId: userId })
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
        var fieldOps = payload.fields || {};

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

        // If no structured field ops, check for flat op/fields at top level
        // (handles simpler event formats: { recordId, op, fields: { key: val } })
        if (!fieldOps.ALT && !fieldOps.INS && !fieldOps.NUL && content.op && content.fields) {
            var op = content.op;
            var flatFields = content.fields;
            if (op === 'ALT' || op === 'INS') {
                var fKeys = Object.keys(flatFields);
                for (var f = 0; f < fKeys.length; f++) {
                    fields[fKeys[f]] = flatFields[fKeys[f]];
                }
            } else if (op === 'NUL') {
                var removeKeys = Array.isArray(flatFields) ? flatFields : Object.keys(flatFields);
                for (var r = 0; r < removeKeys.length; r++) {
                    delete fields[removeKeys[r]];
                }
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
            actor: (payload && payload._a) || null
        };
        // Include flat ops if that was the format used
        if (!fieldOps.ALT && !fieldOps.INS && !fieldOps.NUL && content.op && content.fields) {
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

        // Join rooms first
        await joinTableRooms();

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
            var response = await fetch(AIRTABLE_SYNC_WEBHOOK);

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

    // ============ Initialization ============

    async function init(accessToken, userId, password) {
        if (!accessToken || !userId || !password) {
            throw new Error('accessToken, userId, and password are required');
        }

        _accessToken = accessToken;
        _userId = userId;

        // Open database
        _db = await openDatabase();

        // Derive the Synapse-derived encryption key (deterministic salt from userId)
        _cryptoKey = await deriveSynapseKey(password, userId);

        // Check for existing encryption state and migrate if necessary
        var cryptoTx = _db.transaction('crypto', 'readonly');
        var saltEntry = await idbGet(cryptoTx.objectStore('crypto'), 'salt');
        var verifyEntry = await idbGet(cryptoTx.objectStore('crypto'), 'verify');

        if (saltEntry && saltEntry.value !== 'synapse-derived') {
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
            }
        }

        // Store Synapse-derived marker and verification token
        var verifyToken = await createVerificationToken(_cryptoKey);
        var metaTx = _db.transaction('crypto', 'readwrite');
        var metaStore = metaTx.objectStore('crypto');
        await idbPut(metaStore, { key: 'salt', value: 'synapse-derived', userId: userId });
        await idbPut(metaStore, { key: 'verify', value: verifyToken });
        await idbTxDone(metaTx);

        // Load table list from API
        await fetchAndStoreTables();

        _initialized = true;
        console.log('[AminoData] Initialized with', _tables.length, 'tables (Synapse-derived encryption)');

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
        _cryptoKey = null;
        _accessToken = null;
        _userId = null;
        _tableRoomMap = {};
        _roomTableMap = {};
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
        hydrateAll: hydrateAll,
        initAndHydrate: initAndHydrate,
        restoreSession: restoreSession,

        // Data access (decrypted)
        getTableRecords: getTableRecords,
        getRecord: getRecord,
        searchRecords: searchRecords,
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

        // State
        isInitialized: isInitialized,
        getTableList: getTableList,
        getTableIds: getTableIds,
        getTableRoomMap: getTableRoomMap,
        getRoomForTable: getRoomForTable,
        getTableForRoom: getTableForRoom,
        isMatrixSyncActive: isMatrixSyncActive,

        // Constants (read-only access)
        WEBHOOK_BASE_URL: WEBHOOK_BASE_URL
    };
})();
