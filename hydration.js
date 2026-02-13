// ============================================================================
// Amino Hydration Flow — Standalone Module
//
// Extracted from data-layer.js to allow isolated iteration on:
//   - What data to download (all tables vs selective, full vs delta)
//   - What order to hydrate (priority, parallel, lazy)
//   - Deduplication of change states across all sync channels
//   - Version tracking cursors (server-authoritative, never regress)
//   - Event timestamp authority (server > client, always)
//
// DEPENDENCIES: This module calls into the host data-layer via a `ctx` object
// injected at construction time. See HydrationContext typedef below.
//
// USAGE:
//   var hydrator = new AminoHydration(ctx);
//   var result = await hydrator.run(options);
//
// To iterate: modify the strategies, ordering, or tier logic here.
// The rest of data-layer.js should not need to change.
// ============================================================================

var AminoHydration = (function() {
    'use strict';

    // ========================================================================
    // CONFIGURATION — Tuning knobs. Change these to adjust behavior.
    // ========================================================================

    var config = {
        // Hydration
        BATCH_SIZE: 200,                    // Records per IDB write transaction
        MAX_ROOM_PAGES: 1000,               // Max pages to paginate in Matrix room rebuild
        ROOM_PAGE_SIZE: 200,                // Events per page in room rebuild

        // Sync
        POLL_INTERVAL_MS: 15000,            // HTTP polling interval (ms)
        MATRIX_SYNC_TIMEOUT_MS: 30000,      // Matrix long-poll timeout
        MATRIX_SYNC_EVENT_LIMIT: 100,       // Max events per sync batch
        MAX_CONSECUTIVE_SYNC_ERRORS: 10,    // Matrix errors before fallback to polling
        MAX_TABLE_POLL_FAILURES: 5,         // Skip table after N consecutive poll failures

        // Deduplication
        PROCESSED_EVENT_TTL_MS: 300000,     // 5 minutes — event ID dedup window
        MAX_PROCESSED_EVENTS: 5000,         // Prune dedup map when exceeds this
        OPTIMISTIC_WRITE_TTL_MS: 30000,     // 30 seconds — echo suppression window

        // Tier selection
        TIER_ORDER: ['postgres', 'matrix-room'],  // Tiers to try, in order
        // Possible values: 'bulk-download', 'postgres', 'matrix-room'
        // 'bulk-download' = single request for all tables (hydrateFromBoxDownload)
        // 'postgres'      = per-table from /amino-records (hydrateAllFromPostgres)
        // 'matrix-room'   = replay room timeline (rebuildTableFromRoom)

        // Table ordering strategy for per-table hydration
        // 'api-order'    = order returned by /amino-tables (current default)
        // 'priority'     = high-priority tables first (see TABLE_PRIORITY)
        // 'smallest'     = smallest tables first (fast initial render)
        // 'largest'      = largest tables first (long tail is smaller)
        TABLE_ORDER: 'api-order',

        // Priority list for TABLE_ORDER='priority'. Tables listed here are
        // hydrated first, in this order. Unlisted tables follow after.
        TABLE_PRIORITY: [],

        // Whether to allow parallel table hydration (experimental)
        PARALLEL_TABLES: false,
        PARALLEL_TABLE_CONCURRENCY: 3,
    };

    // ========================================================================
    // DEDUPLICATION — Change-state tracking across sync channels.
    //
    // Three independent mechanisms. All three must be preserved in any
    // iteration of the hydration flow.
    // ========================================================================

    // --- 6.1: Event ID Deduplication ---
    // Prevents the same Matrix event from being applied twice when received
    // via overlapping channels (Matrix sync + HTTP poll, duplicate delivery).
    var _processedEventIds = {};     // event_id → timestamp (ms)

    function markEventProcessed(eventId) {
        if (!eventId) return false;
        if (_processedEventIds[eventId]) return true;  // already seen
        _processedEventIds[eventId] = Date.now();
        _pruneProcessedEvents();
        return false;
    }

    function _pruneProcessedEvents() {
        var ids = Object.keys(_processedEventIds);
        if (ids.length <= config.MAX_PROCESSED_EVENTS) return;

        var now = Date.now();
        for (var i = 0; i < ids.length; i++) {
            if (now - _processedEventIds[ids[i]] > config.PROCESSED_EVENT_TTL_MS) {
                delete _processedEventIds[ids[i]];
            }
        }
        // If still over limit after TTL prune, drop oldest half
        ids = Object.keys(_processedEventIds);
        if (ids.length > config.MAX_PROCESSED_EVENTS) {
            ids.sort(function(a, b) {
                return _processedEventIds[a] - _processedEventIds[b];
            });
            var dropCount = Math.floor(ids.length / 2);
            for (var j = 0; j < dropCount; j++) {
                delete _processedEventIds[ids[j]];
            }
        }
    }

    // --- 6.2: Optimistic Write Echo Suppression ---
    // When a client writes a field, the server echoes it back via /sync.
    // This detects and skips redundant echoes.
    var _optimisticWrites = {};      // recordId → { fields, ts }

    function trackOptimisticWrite(recordId, changedFields) {
        _optimisticWrites[recordId] = {
            fields: changedFields,
            ts: Date.now()
        };
    }

    function isOptimisticEcho(recordId, incomingFieldOps) {
        var entry = _optimisticWrites[recordId];
        if (!entry) return false;
        if (Date.now() - entry.ts > config.OPTIMISTIC_WRITE_TTL_MS) {
            delete _optimisticWrites[recordId];
            return false;
        }

        var alt = incomingFieldOps.ALT;
        if (!alt) return false;

        var optimistic = entry.fields;
        var altKeys = Object.keys(alt);
        for (var i = 0; i < altKeys.length; i++) {
            if (!_looseFieldEqual(alt[altKeys[i]], optimistic[altKeys[i]])) {
                return false;
            }
        }

        delete _optimisticWrites[recordId];
        return true;
    }

    function pruneOptimisticWrites() {
        var now = Date.now();
        var ids = Object.keys(_optimisticWrites);
        for (var i = 0; i < ids.length; i++) {
            if (now - _optimisticWrites[ids[i]].ts > config.OPTIMISTIC_WRITE_TTL_MS) {
                delete _optimisticWrites[ids[i]];
            }
        }
    }

    // Loose comparison for echo detection — handles type coercion
    // from server normalization (e.g. "123" vs 123, "true" vs true).
    function _looseFieldEqual(a, b) {
        if (a === b) return true;
        if (a == null && b == null) return true;
        if (a == null || b == null) return false;

        var typeA = typeof a;
        var typeB = typeof b;
        if (typeA !== typeB &&
            (typeA === 'string' || typeA === 'number' || typeA === 'boolean') &&
            (typeB === 'string' || typeB === 'number' || typeB === 'boolean')) {
            return String(a) === String(b);
        }

        return JSON.stringify(a) === JSON.stringify(b);
    }

    // --- 6.3: Full-Table Clear-Before-Write ---
    // During full hydration, deleteTableRecords is called before writing.
    // This is handled inline in the tier functions below.

    // ========================================================================
    // VERSION TRACKING — Sync cursors that determine "what do we have?"
    //
    // Cursors must NEVER regress. Server-authoritative timestamps preferred.
    // ========================================================================

    var VersionTracker = {

        // Read the sync cursor for a table from IndexedDB.
        // Returns { tableId, lastSynced } or null if no cursor exists.
        async readCursor(ctx, tableId) {
            var syncTx = ctx.db.transaction('sync', 'readonly');
            var record = await ctx.idbGet(syncTx.objectStore('sync'), tableId);
            return record || null;
        },

        // Write a sync cursor. The new cursor must be >= the existing cursor
        // to prevent regression. Returns the cursor that was written.
        async writeCursor(ctx, tableId, newCursor, source) {
            if (!newCursor) {
                console.warn('[Hydration] Refusing to write null cursor for table', tableId);
                return null;
            }

            // Read existing cursor to enforce monotonic advance
            var existing = await VersionTracker.readCursor(ctx, tableId);
            if (existing && existing.lastSynced && existing.lastSynced >= newCursor) {
                // Existing cursor is already ahead — don't regress
                console.log('[Hydration] Cursor for', tableId, 'already at',
                    existing.lastSynced, '— not regressing to', newCursor);
                return existing.lastSynced;
            }

            var syncTx = ctx.db.transaction('sync', 'readwrite');
            await ctx.idbPut(syncTx.objectStore('sync'), {
                tableId: tableId,
                lastSynced: newCursor,
                cursorSource: source || 'unknown',
                updatedAt: new Date().toISOString()
            });
            await ctx.idbTxDone(syncTx);

            console.log('[Hydration] Cursor for', tableId, 'advanced to', newCursor,
                '(source:', source || 'unknown', ')');
            return newCursor;
        },

        // Resolve the best cursor from an API response.
        // Priority: server next_since > max record timestamp > NEVER client clock.
        resolveCursorFromResponse(data, records) {
            // 1. Server-provided cursor (authoritative, preferred)
            if (data && data.next_since) {
                return { value: data.next_since, source: 'server-next-since' };
            }

            // 2. Max last_synced from response records (server-generated timestamps)
            if (records && records.length > 0) {
                var maxTs = records.reduce(function(max, r) {
                    var ts = r.last_synced || r.lastSynced || '';
                    return ts > max ? ts : max;
                }, '');
                if (maxTs) {
                    return { value: maxTs, source: 'server-record-max' };
                }
            }

            // 3. Client clock as LAST RESORT — logged as degraded mode
            console.warn('[Hydration] No server cursor available — falling back to client clock. '
                + 'This is vulnerable to clock skew.');
            return { value: new Date().toISOString(), source: 'client-clock-fallback' };
        }
    };

    // ========================================================================
    // EVENT TIMESTAMPS — Authoritative timestamp extraction from events.
    //
    // Server timestamps are always preferred over client timestamps.
    // ========================================================================

    var Timestamps = {

        // Extract the best timestamp from a Matrix event.
        // Returns an ISO string. Prefers origin_server_ts (Matrix homeserver clock).
        fromMatrixEvent: function(event) {
            if (event.origin_server_ts) {
                return new Date(event.origin_server_ts).toISOString();
            }
            // Fallback to content.sourceTimestamp (set by n8n/upstream)
            if (event.content && event.content.sourceTimestamp) {
                return event.content.sourceTimestamp;
            }
            // Last resort: client clock (logged as degraded)
            console.warn('[Hydration] Matrix event has no server timestamp, using client clock');
            return new Date().toISOString();
        },

        // Extract timestamp from an API record.
        fromApiRecord: function(record) {
            return record.last_synced || record.lastSynced || new Date().toISOString();
        },

        // Server time from an API response envelope (for cursor use).
        fromApiResponse: function(data) {
            return data.server_time || data.serverTime || null;
        }
    };

    // ========================================================================
    // FIELD OPERATIONS — Normalize and apply ALT/INS/NUL mutations.
    // ========================================================================

    // Normalize incoming mutation content to canonical { ALT, INS, NUL } form.
    // Supports two wire formats:
    //   Structured: { payload: { fields: { ALT: {...}, INS: {...}, NUL: [...] } } }
    //   Flat:       { op: 'ALT', fields: { key: val } }
    function normalizeFieldOps(content) {
        var payload = content.payload || content;
        var fieldOps = payload.fields || {};

        // Detect flat format and convert
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

    // Apply field operations to a fields object (mutates in place).
    // Order: ALT → INS → NUL (same semantics as data-layer.js)
    function applyFieldOps(fields, fieldOps) {
        if (fieldOps.ALT) {
            var altKeys = Object.keys(fieldOps.ALT);
            for (var a = 0; a < altKeys.length; a++) {
                fields[altKeys[a]] = fieldOps.ALT[altKeys[a]];
            }
        }
        if (fieldOps.INS) {
            var insKeys = Object.keys(fieldOps.INS);
            for (var n = 0; n < insKeys.length; n++) {
                fields[insKeys[n]] = fieldOps.INS[insKeys[n]];
            }
        }
        if (fieldOps.NUL) {
            var nulFields = Array.isArray(fieldOps.NUL) ? fieldOps.NUL : Object.keys(fieldOps.NUL);
            for (var d = 0; d < nulFields.length; d++) {
                delete fields[nulFields[d]];
            }
        }
        return fields;
    }

    // ========================================================================
    // RECORD PIPELINE — Normalize → Encrypt → Write → Cache
    //
    // Shared across all tiers. Every record passes through this.
    // ========================================================================

    // Normalize a raw API record to canonical form.
    function normalizeRecord(record, tableId) {
        return {
            id: record.id,
            tableId: tableId || record.tableId || record.table_id,
            tableName: record.tableName || record.table_name || tableId || '',
            fields: record.fields || {},
            lastSynced: Timestamps.fromApiRecord(record)
        };
    }

    // Batch-write records to IndexedDB + cache. Handles encryption.
    async function writeRecordBatch(ctx, records, tableId) {
        var prepared = await ctx.prepareEncryptedRecords(records, tableId);
        var tx = ctx.db.transaction('records', 'readwrite');
        var store = tx.objectStore('records');
        for (var i = 0; i < prepared.length; i++) {
            await ctx.idbPut(store, prepared[i].entry);
            ctx.cacheRecord(prepared[i].normalizedRecord);
        }
        await ctx.idbTxDone(tx);
        return prepared.length;
    }

    // Write records in configurable batches.
    async function writeRecordsBatched(ctx, records, tableId) {
        var written = 0;
        for (var b = 0; b < records.length; b += config.BATCH_SIZE) {
            var batch = records.slice(b, b + config.BATCH_SIZE);
            written += await writeRecordBatch(ctx, batch, tableId);
        }
        return written;
    }

    // ========================================================================
    // TIER 1: BULK DOWNLOAD (currently bypassed — set config.TIER_ORDER to
    // include 'bulk-download' to re-enable)
    //
    // Single HTTP request for ALL tables. Fastest initial load.
    // ========================================================================

    async function tierBulkDownload(ctx, options) {
        var onProgress = options.onProgress || null;

        console.log('[Hydration] Tier bulk-download: fetching all records in one request');
        var matrixToken = ctx.getAuthToken();
        var url = ctx.BOX_DOWNLOAD_WEBHOOK + '?access_token=' + encodeURIComponent(matrixToken);

        var response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + matrixToken
            },
            body: JSON.stringify({ access_token: matrixToken })
        });

        if (!response.ok) {
            throw new Error('Bulk download failed: HTTP ' + response.status);
        }

        var data = await response.json();

        // Parse response — supports 3 formats
        var allRecords = [];
        if (Array.isArray(data)) {
            allRecords = data;
        } else if (data && Array.isArray(data.records)) {
            allRecords = data.records;
        } else if (data && typeof data.tables === 'object' && !Array.isArray(data.tables)) {
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
            throw new Error('Bulk download returned no records');
        }

        // Group by table
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

            // Clear existing rows so deleted records don't linger
            await ctx.deleteTableRecords(tid);

            // Write batched
            await writeRecordsBatched(ctx, records, tid);

            // Update cursor — use server time from response
            var cursorInfo = VersionTracker.resolveCursorFromResponse(data, records);
            await VersionTracker.writeCursor(ctx, tid, cursorInfo.value, cursorInfo.source);

            // Cache
            ctx.cacheFullTable(tid, records.map(function(record) {
                return normalizeRecord(record, tid);
            }));

            totalHydrated += records.length;

            if (onProgress) {
                onProgress({
                    tableId: tid,
                    tableName: (records[0] || {}).tableName || (records[0] || {}).table_name || tid,
                    tableIndex: j,
                    tableCount: tableIds.length,
                    recordCount: records.length,
                    totalRecords: totalHydrated
                });
            }
        }

        return {
            success: true,
            totalRecords: totalHydrated,
            totalTables: tableIds.length,
            hydratedTables: tableIds.filter(function(id) { return (byTable[id] || []).length > 0; }),
            emptyTables: tableIds.filter(function(id) { return (byTable[id] || []).length === 0; })
        };
    }

    // ========================================================================
    // TIER 2: POSTGRES PER-TABLE (current default)
    //
    // Fetches each table individually via /amino-records.
    // Supports incremental sync via /amino-records-since when cursor exists.
    // ========================================================================

    // Hydrate a single table — full fetch, clear-before-write.
    async function hydrateTableFromPostgres(ctx, tableId) {
        var data = await ctx.apiFetch('/amino-records?tableId=' + encodeURIComponent(tableId), 'fullBackfill');
        var records = data.records || [];

        if (ctx.onlineOnlyMode) {
            // Online-only: cache in memory, skip IDB
            var normalized = records.map(function(rec) {
                var nr = normalizeRecord(rec, tableId);
                ctx.cacheRecord(nr);
                return nr;
            });
            ctx.cacheFullTable(tableId, normalized);
            return { count: records.length, cursor: null };
        }

        // Full hydration: clear stale data, then write
        await ctx.deleteTableRecords(tableId);
        await writeRecordsBatched(ctx, records, tableId);

        // Update cursor — server-authoritative
        var cursorInfo = VersionTracker.resolveCursorFromResponse(data, records);
        var writtenCursor = await VersionTracker.writeCursor(
            ctx, tableId, cursorInfo.value, cursorInfo.source
        );

        // Cache full table
        ctx.cacheFullTable(tableId, records.map(function(rec) {
            return normalizeRecord(rec, tableId);
        }));

        return { count: records.length, cursor: writtenCursor };
    }

    // Sync a single table — incremental if cursor exists, full otherwise.
    async function syncTableFromPostgres(ctx, tableId) {
        // Online-only: always full hydrate (no cursors in IDB)
        if (ctx.onlineOnlyMode) {
            return hydrateTableFromPostgres(ctx, tableId);
        }

        var cursor = await VersionTracker.readCursor(ctx, tableId);
        var since = cursor ? cursor.lastSynced : null;

        // No cursor → full hydration
        if (!since) {
            return hydrateTableFromPostgres(ctx, tableId);
        }

        // Incremental sync
        var data = await ctx.apiFetch(
            '/amino-records-since?tableId=' + encodeURIComponent(tableId) +
            '&since=' + encodeURIComponent(since),
            'incrementalBackfill'
        );
        var records = data.records || [];

        if (records.length > 0) {
            await writeRecordsBatched(ctx, records, tableId);
        }

        // Advance cursor — server-authoritative, never regress
        var cursorInfo = VersionTracker.resolveCursorFromResponse(data, records);
        var writtenCursor = await VersionTracker.writeCursor(
            ctx, tableId, cursorInfo.value, cursorInfo.source
        );

        return { count: records.length, cursor: writtenCursor };
    }

    // Hydrate all tables from Postgres, respecting TABLE_ORDER config.
    async function tierPostgres(ctx, options) {
        var onProgress = options.onProgress || null;
        var tableIds = orderTables(ctx.tableIds, ctx.tables);
        var totalHydrated = 0;

        if (config.PARALLEL_TABLES) {
            totalHydrated = await _hydrateTablesParallel(ctx, tableIds, onProgress);
        } else {
            totalHydrated = await _hydrateTablesSequential(ctx, tableIds, onProgress);
        }

        return {
            success: true,
            totalRecords: totalHydrated,
            totalTables: tableIds.length
        };
    }

    async function _hydrateTablesSequential(ctx, tableIds, onProgress) {
        var totalHydrated = 0;
        for (var i = 0; i < tableIds.length; i++) {
            var tableId = tableIds[i];
            try {
                var result = await syncTableFromPostgres(ctx, tableId);
                totalHydrated += result.count;
                if (onProgress) {
                    onProgress({
                        tableId: tableId,
                        tableName: _getTableName(ctx, tableId),
                        tableIndex: i,
                        tableCount: tableIds.length,
                        recordCount: result.count,
                        totalRecords: totalHydrated
                    });
                }
            } catch (err) {
                console.error('[Hydration] Failed to hydrate table', tableId, ':', err);
                if (err.status === 401) throw err;

                // Per-table failure: try Matrix room rebuild if available
                var roomCount = await _tryMatrixRoomFallback(ctx, tableId);
                if (roomCount > 0) totalHydrated += roomCount;
            }
        }
        return totalHydrated;
    }

    async function _hydrateTablesParallel(ctx, tableIds, onProgress) {
        var concurrency = config.PARALLEL_TABLE_CONCURRENCY;
        var totalHydrated = 0;
        var completed = 0;

        // Simple concurrency pool
        var queue = tableIds.slice();
        var active = 0;

        return new Promise(function(resolve, reject) {
            function next() {
                while (active < concurrency && queue.length > 0) {
                    var tableId = queue.shift();
                    active++;
                    (function(tid) {
                        syncTableFromPostgres(ctx, tid).then(function(result) {
                            totalHydrated += result.count;
                            completed++;
                            active--;
                            if (onProgress) {
                                onProgress({
                                    tableId: tid,
                                    tableName: _getTableName(ctx, tid),
                                    tableIndex: completed - 1,
                                    tableCount: tableIds.length,
                                    recordCount: result.count,
                                    totalRecords: totalHydrated
                                });
                            }
                            if (queue.length === 0 && active === 0) {
                                resolve(totalHydrated);
                            } else {
                                next();
                            }
                        }).catch(function(err) {
                            console.error('[Hydration] Parallel hydrate failed for', tid, ':', err);
                            if (err.status === 401) {
                                reject(err);
                                return;
                            }
                            active--;
                            completed++;
                            // Try fallback
                            _tryMatrixRoomFallback(ctx, tid).then(function(roomCount) {
                                if (roomCount > 0) totalHydrated += roomCount;
                                if (queue.length === 0 && active === 0) {
                                    resolve(totalHydrated);
                                } else {
                                    next();
                                }
                            });
                        });
                    })(tableId);
                }
            }
            if (queue.length === 0) {
                resolve(0);
            } else {
                next();
            }
        });
    }

    // ========================================================================
    // TIER 3: MATRIX ROOM REBUILD (last resort)
    //
    // Reconstructs current state by replaying all mutations from the Matrix
    // room timeline in reverse chronological order.
    // ========================================================================

    async function tierMatrixRoom(ctx, tableId) {
        var roomId = ctx.tableRoomMap[tableId];
        if (!roomId) throw new Error('No Matrix room mapped for table: ' + tableId);
        if (!ctx.MatrixClient || !ctx.MatrixClient.isLoggedIn()) {
            throw new Error('Matrix client unavailable for room-based rebuild');
        }

        console.warn('[Hydration] Rebuilding table from room history:', tableId, roomId);

        var recordStates = {};   // recordId → { fields, resolved }
        var paginationToken = null;

        for (var page = 0; page < config.MAX_ROOM_PAGES; page++) {
            var options = {
                dir: 'b',  // newest first
                limit: config.ROOM_PAGE_SIZE,
                filter: { types: ['law.firm.record.mutate'] }
            };
            if (paginationToken) options.from = paginationToken;

            var response = await ctx.MatrixClient.getRoomMessages(roomId, options);
            if (!response || !response.chunk || response.chunk.length === 0) break;

            var chunk = response.chunk;
            for (var i = 0; i < chunk.length; i++) {
                var evt = chunk[i];
                if (!evt.content || !evt.content.recordId) continue;

                var content = evt.content;

                // Skip metadata events
                var payloadSet = content.payload && content.payload._set;
                if (payloadSet === 'table' || payloadSet === 'field' ||
                    payloadSet === 'view' || payloadSet === 'viewConfig' ||
                    payloadSet === 'tableSettings') {
                    continue;
                }

                // Decrypt if needed
                if (ctx.isEncryptedPayload && ctx.isEncryptedPayload(content)) {
                    try {
                        var decryptedFields = await ctx.decryptEventPayload(content);
                        content = {
                            recordId: content.recordId,
                            tableId: content.tableId,
                            op: content.op || 'ALT',
                            payload: content.payload,
                            set: content.set,
                            fields: decryptedFields
                        };
                    } catch (decErr) {
                        continue;  // Skip undecryptable events
                    }
                }

                var recordId = content.recordId;
                var state = recordStates[recordId];
                if (!state) {
                    state = { fields: {}, resolved: {} };
                    recordStates[recordId] = state;
                }

                var fieldOps = normalizeFieldOps(content);

                // NUL: mark fields as resolved (deleted)
                if (fieldOps.NUL) {
                    var nulFields = Array.isArray(fieldOps.NUL) ? fieldOps.NUL : Object.keys(fieldOps.NUL);
                    for (var n = 0; n < nulFields.length; n++) {
                        if (!state.resolved[nulFields[n]]) {
                            state.resolved[nulFields[n]] = true;
                        }
                    }
                }

                // ALT/INS: set field value if not yet resolved
                var assignOps = ['ALT', 'INS'];
                for (var a = 0; a < assignOps.length; a++) {
                    var opFields = fieldOps[assignOps[a]];
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

            if (!response.end || chunk.length < config.ROOM_PAGE_SIZE) break;
            paginationToken = response.end;
        }

        // Clear and write
        await ctx.deleteTableRecords(tableId);

        var recordIds = Object.keys(recordStates);
        var tableName = _getTableName(ctx, tableId);

        for (var b = 0; b < recordIds.length; b += config.BATCH_SIZE) {
            var batchIds = recordIds.slice(b, b + config.BATCH_SIZE);
            var batchRecords = batchIds.map(function(id) {
                return {
                    id: id,
                    tableId: tableId,
                    tableName: tableName,
                    fields: recordStates[id].fields,
                    lastSynced: new Date().toISOString()
                };
            });
            await writeRecordBatch(ctx, batchRecords, tableId);
        }

        // Write cursor (client-clock — Matrix rooms don't provide a sync cursor)
        await VersionTracker.writeCursor(ctx, tableId, new Date().toISOString(), 'matrix-room-rebuild');

        // Cache
        var allRebuilt = recordIds.map(function(id) {
            return {
                id: id,
                tableId: tableId,
                tableName: tableName,
                fields: recordStates[id].fields,
                lastSynced: new Date().toISOString()
            };
        });
        ctx.cacheFullTable(tableId, allRebuilt);

        console.warn('[Hydration] Rebuilt', recordIds.length, 'records for', tableId, 'from room history');
        return recordIds.length;
    }

    // Try Matrix room fallback for a single table. Returns record count or 0.
    async function _tryMatrixRoomFallback(ctx, tableId) {
        if (!ctx.tableRoomMap[tableId] || !ctx.MatrixClient || !ctx.MatrixClient.isLoggedIn()) {
            return 0;
        }
        try {
            var count = await tierMatrixRoom(ctx, tableId);
            console.log('[Hydration] Fallback: rebuilt', count, 'records from room for', tableId);
            return count;
        } catch (roomErr) {
            console.warn('[Hydration] Room fallback also failed for', tableId, ':', roomErr.message || roomErr);
            return 0;
        }
    }

    // ========================================================================
    // REAL-TIME SYNC — Post-hydration event application.
    //
    // applyMutateEvent is the core function that applies a single mutation
    // to a local record. Used by both Matrix sync and HTTP polling.
    // ========================================================================

    async function applyMutateEvent(ctx, event, roomId) {
        var content = event.content;
        if (!content) return;

        // --- DEDUP: skip events already processed ---
        var eventId = event.event_id;
        if (markEventProcessed(eventId)) {
            return;  // Already applied
        }

        // --- FILTER: skip metadata events ---
        var payloadSet = content.payload && content.payload._set;
        if (payloadSet === 'table' || payloadSet === 'field' ||
            payloadSet === 'view' || payloadSet === 'viewConfig' ||
            payloadSet === 'tableSettings') {
            return;
        }

        // --- DECRYPT if encrypted ---
        if (ctx.isEncryptedPayload && ctx.isEncryptedPayload(content)) {
            try {
                var decryptedFields = await ctx.decryptEventPayload(content);
                content = {
                    recordId: content.recordId,
                    tableId: content.tableId,
                    op: content.op || 'ALT',
                    fields: decryptedFields
                };
            } catch (err) {
                ctx.onDecryptFailure && ctx.onDecryptFailure(eventId, err);
                return;
            }
        }

        if (!content.recordId) return;

        var recordId = content.recordId;
        var tableId = ctx.roomTableMap[roomId];
        if (!tableId && content.set) {
            tableId = content.set.replace(/^airtable:/, '');
        }
        if (!tableId) {
            console.warn('[Hydration] Cannot determine tableId for event in room', roomId);
            return;
        }

        // --- READ existing record ---
        var tx = ctx.db.transaction('records', 'readonly');
        var existing = await ctx.idbGet(tx.objectStore('records'), recordId);

        var fields;
        if (existing) {
            if (typeof existing.fields === 'string') {
                fields = JSON.parse(existing.fields);
            } else {
                fields = JSON.parse(await ctx.decrypt(existing.fields));
            }
        } else {
            fields = {};
        }

        // --- NORMALIZE field ops ---
        var fieldOps = normalizeFieldOps(content);

        // --- ECHO CHECK ---
        if (isOptimisticEcho(recordId, fieldOps)) {
            // Still emit for field history, but skip the write cycle
            ctx.emitEvent && ctx.emitEvent('amino:record-mutate', {
                recordId: recordId,
                tableId: tableId,
                eventId: eventId,
                sender: event.sender || null,
                timestamp: event.origin_server_ts || Date.now(),
                fieldOps: fieldOps,
                echoSuppressed: true
            });
            return;
        }

        // --- MERGE: apply field operations ---
        applyFieldOps(fields, fieldOps);

        // --- WRITE back to IDB ---
        var storedFields;
        if (ctx.deferEncryption) {
            storedFields = JSON.stringify(fields);
        } else {
            storedFields = await ctx.encrypt(JSON.stringify(fields));
        }

        // Use server timestamp for lastSynced, not client clock
        var lastSynced = Timestamps.fromMatrixEvent(event);

        var writeTx = ctx.db.transaction('records', 'readwrite');
        await ctx.idbPut(writeTx.objectStore('records'), {
            id: recordId,
            tableId: tableId,
            tableName: (existing && existing.tableName) || tableId,
            fields: storedFields,
            lastSynced: lastSynced
        });
        await ctx.idbTxDone(writeTx);

        // --- CACHE ---
        ctx.cacheRecord({
            id: recordId,
            tableId: tableId,
            tableName: (existing && existing.tableName) || tableId,
            fields: fields,
            lastSynced: lastSynced
        });

        // --- EMIT ---
        ctx.emitEvent && ctx.emitEvent('amino:record-update', {
            recordId: recordId,
            tableId: tableId,
            source: 'matrix'
        });
        ctx.emitEvent && ctx.emitEvent('amino:record-mutate', {
            recordId: recordId,
            tableId: tableId,
            eventId: eventId,
            sender: event.sender || null,
            timestamp: event.origin_server_ts || Date.now(),
            fieldOps: fieldOps,
            source: content.source || null,
            sourceTimestamp: content.sourceTimestamp || null,
            actor: (content.payload && content.payload._a) || null,
            device: (content.payload && content.payload._d) || content.device || null
        });
    }

    // ========================================================================
    // TABLE ORDERING — Determines the order tables are hydrated.
    // ========================================================================

    function orderTables(tableIds, tables) {
        var strategy = config.TABLE_ORDER;

        if (strategy === 'api-order') {
            return tableIds.slice();  // Preserve API order
        }

        if (strategy === 'priority') {
            var prioritized = [];
            var rest = [];
            var prioritySet = {};
            for (var p = 0; p < config.TABLE_PRIORITY.length; p++) {
                prioritySet[config.TABLE_PRIORITY[p]] = p;
            }
            for (var i = 0; i < tableIds.length; i++) {
                if (prioritySet[tableIds[i]] !== undefined) {
                    prioritized.push(tableIds[i]);
                } else {
                    rest.push(tableIds[i]);
                }
            }
            prioritized.sort(function(a, b) {
                return prioritySet[a] - prioritySet[b];
            });
            return prioritized.concat(rest);
        }

        if (strategy === 'smallest' || strategy === 'largest') {
            var tableMap = {};
            for (var t = 0; t < tables.length; t++) {
                tableMap[tables[t].table_id] = tables[t];
            }
            var sorted = tableIds.slice().sort(function(a, b) {
                var countA = (tableMap[a] && tableMap[a].record_count) || 0;
                var countB = (tableMap[b] && tableMap[b].record_count) || 0;
                return strategy === 'smallest' ? countA - countB : countB - countA;
            });
            return sorted;
        }

        return tableIds.slice();  // fallback: api-order
    }

    // ========================================================================
    // HELPERS
    // ========================================================================

    function _getTableName(ctx, tableId) {
        for (var i = 0; i < ctx.tables.length; i++) {
            if (ctx.tables[i].table_id === tableId) {
                return ctx.tables[i].table_name || tableId;
            }
        }
        return tableId;
    }

    // ========================================================================
    // MAIN ORCHESTRATOR — Call this to run hydration.
    // ========================================================================

    /**
     * Run the hydration flow.
     *
     * @param {HydrationContext} ctx - Dependency injection context (see typedef below)
     * @param {Object} options
     * @param {Function} [options.onProgress] - Progress callback
     * @param {string[]} [options.tableIds] - Subset of tables to hydrate (default: all)
     * @param {string[]} [options.tierOrder] - Override config.TIER_ORDER for this run
     * @returns {Object} { success, totalRecords, totalTables, tier }
     */
    async function run(ctx, options) {
        options = options || {};
        var tiers = options.tierOrder || config.TIER_ORDER;

        console.log('[Hydration] Starting with tier order:', tiers.join(' → '));
        console.log('[Hydration] Table order strategy:', config.TABLE_ORDER);
        console.log('[Hydration] Parallel tables:', config.PARALLEL_TABLES ?
            'yes (' + config.PARALLEL_TABLE_CONCURRENCY + ')' : 'no');

        // If specific tables requested, override ctx for this run
        if (options.tableIds) {
            ctx = Object.create(ctx);
            ctx.tableIds = options.tableIds;
        }

        for (var i = 0; i < tiers.length; i++) {
            var tier = tiers[i];
            console.log('[Hydration] Attempting tier:', tier);

            try {
                var result;
                if (tier === 'bulk-download') {
                    result = await tierBulkDownload(ctx, options);
                } else if (tier === 'postgres') {
                    result = await tierPostgres(ctx, options);
                } else if (tier === 'matrix-room') {
                    // Matrix room is per-table, hydrate all
                    var total = 0;
                    var orderedIds = orderTables(ctx.tableIds, ctx.tables);
                    for (var t = 0; t < orderedIds.length; t++) {
                        try {
                            total += await tierMatrixRoom(ctx, orderedIds[t]);
                        } catch (err) {
                            console.error('[Hydration] Matrix room failed for', orderedIds[t], ':', err);
                        }
                    }
                    result = { success: true, totalRecords: total, totalTables: orderedIds.length };
                } else {
                    console.warn('[Hydration] Unknown tier:', tier);
                    continue;
                }

                if (result && result.totalRecords > 0) {
                    console.log('[Hydration] Tier', tier, 'succeeded:', result.totalRecords, 'records');
                    result.tier = tier;
                    return result;
                }
            } catch (err) {
                console.error('[Hydration] Tier', tier, 'failed:', err.message || err);
                if (err.status === 401) throw err;  // Don't retry auth failures
            }
        }

        console.error('[Hydration] All tiers exhausted, no records hydrated');
        return { success: false, totalRecords: 0, totalTables: 0, tier: null };
    }

    // ========================================================================
    // RESET — Clear all dedup/tracking state (call on logout).
    // ========================================================================

    function reset() {
        _processedEventIds = {};
        _optimisticWrites = {};
    }

    // ========================================================================
    // EXPORTS
    // ========================================================================

    return {
        // Main entry point
        run: run,

        // Configuration (mutable — change before calling run())
        config: config,

        // Deduplication (used by data-layer for real-time sync)
        markEventProcessed: markEventProcessed,
        isOptimisticEcho: isOptimisticEcho,
        trackOptimisticWrite: trackOptimisticWrite,
        pruneOptimisticWrites: pruneOptimisticWrites,

        // Version tracking (used by data-layer for sync cursors)
        VersionTracker: VersionTracker,

        // Timestamps (used by data-layer for consistent timestamp sourcing)
        Timestamps: Timestamps,

        // Field operations (used by data-layer for mutation application)
        normalizeFieldOps: normalizeFieldOps,
        applyFieldOps: applyFieldOps,

        // Real-time event application
        applyMutateEvent: applyMutateEvent,

        // Record pipeline
        normalizeRecord: normalizeRecord,
        writeRecordsBatched: writeRecordsBatched,

        // Individual tiers (for direct use or testing)
        tierBulkDownload: tierBulkDownload,
        tierPostgres: tierPostgres,
        tierMatrixRoom: tierMatrixRoom,
        syncTableFromPostgres: syncTableFromPostgres,
        hydrateTableFromPostgres: hydrateTableFromPostgres,

        // Table ordering
        orderTables: orderTables,

        // Reset state
        reset: reset
    };

})();

// ============================================================================
// HydrationContext typedef — The `ctx` object passed to all hydration functions.
//
// This is the dependency injection contract between hydration.js and
// data-layer.js. When calling AminoHydration.run(ctx, options), `ctx` must
// provide these properties and methods.
//
// To create a ctx from inside data-layer.js:
//
//   var ctx = {
//       // State
//       db: _db,
//       tableIds: _tableIds,
//       tables: _tables,
//       tableRoomMap: _tableRoomMap,
//       roomTableMap: _roomTableMap,
//       onlineOnlyMode: _onlineOnlyMode,
//       deferEncryption: _deferEncryption,
//       MatrixClient: MatrixClient,
//       BOX_DOWNLOAD_WEBHOOK: BOX_DOWNLOAD_WEBHOOK,
//
//       // Auth
//       getAuthToken: function() {
//           return (MatrixClient && MatrixClient.getAccessToken && MatrixClient.getAccessToken())
//               ? MatrixClient.getAccessToken() : _accessToken;
//       },
//
//       // IDB helpers
//       idbPut: idbPut,
//       idbGet: idbGet,
//       idbGetAll: idbGetAll,
//       idbTxDone: idbTxDone,
//
//       // Record pipeline
//       prepareEncryptedRecords: prepareEncryptedRecords,
//       cacheRecord: cacheRecord,
//       cacheFullTable: cacheFullTable,
//       deleteTableRecords: deleteTableRecords,
//
//       // Encryption
//       encrypt: function(plaintext) { return encrypt(_cryptoKey, plaintext); },
//       decrypt: function(ciphertext) { return decrypt(_cryptoKey, ciphertext); },
//       isEncryptedPayload: isEncryptedPayload,
//       decryptEventPayload: decryptEventPayload,
//
//       // API
//       apiFetch: apiFetch,
//
//       // Events
//       emitEvent: function(name, detail) {
//           window.dispatchEvent(new CustomEvent(name, { detail: detail }));
//       },
//
//       // Error hooks
//       onDecryptFailure: function(eventId, err) {
//           _consecutiveDecryptFailures++;
//           console.warn('[Hydration] Decrypt failure:', err.message);
//           if (_consecutiveDecryptFailures >= DECRYPT_FAILURE_THRESHOLD) {
//               window.dispatchEvent(new CustomEvent('amino:sync-error', {
//                   detail: { type: 'decrypt-failure-critical', consecutiveFailures: _consecutiveDecryptFailures }
//               }));
//           }
//       }
//   };
// ============================================================================
