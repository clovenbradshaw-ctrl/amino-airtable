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
        TIER_ORDER: ['postgres'],  // Tiers to try, in order
        // Possible values: 'bulk-download', 'postgres', 'csv', 'url'
        // 'bulk-download' = single request for all tables (hydrateFromBoxDownload)
        // 'postgres'      = per-table from /amino-records (hydrateAllFromPostgres)
        // 'csv'           = parse local CSV file (tierCSV)
        // 'url'           = fetch from arbitrary URL (tierURL)

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
        // n8n Postgres node may return JSONB columns as strings — parse them.
        var fields = record.fields;
        if (typeof fields === 'string') {
            try { fields = JSON.parse(fields); } catch (e) { fields = {}; }
        }
        return {
            id: record.id,
            tableId: tableId || record.tableId || record.table_id,
            tableName: record.tableName || record.table_name || tableId || '',
            fields: fields || {},
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

    // Filter out schema metadata (fld*, viw*, tbl*) from Postgres responses.
    // amino.current_state stores both record data (rec*) and schema metadata
    // in the same table; only rec* entries are actual data records.
    function filterDataRecords(records) {
        return records.filter(function(rec) {
            var id = rec.id || '';
            return id.startsWith('rec');
        });
    }

    // Hydrate a single table — full fetch, clear-before-write.
    async function hydrateTableFromPostgres(ctx, tableId) {
        var data = await ctx.apiFetch('/amino-records?tableId=' + encodeURIComponent(tableId), 'fullBackfill');
        var records = filterDataRecords(data.records || []);

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
        var records = filterDataRecords(data.records || []);

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
                            if (queue.length === 0 && active === 0) {
                                resolve(totalHydrated);
                            } else {
                                next();
                            }
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
                } else if (tier === 'csv') {
                    result = await tierCSV(ctx, options);
                } else if (tier === 'url') {
                    result = await tierURL(ctx, options);
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
    // TIER 4: CSV FILE — Hydrate from a local .csv file.
    //
    // Expected CSV schema:
    //   id (integer), created_at (timestamp), recordId (text),
    //   operator (text), payload (json), uuid (uuid), set (text)
    //
    // Each CSV row is an event. Rows are grouped by recordId+set (table),
    // field operations are replayed in created_at order to build current state,
    // then written to IDB.
    // ========================================================================

    // Minimal CSV line parser — handles quoted fields and escaped quotes.
    function _parseCSVLine(line) {
        var result = [];
        var current = '';
        var inQuotes = false;
        for (var i = 0; i < line.length; i++) {
            var ch = line.charAt(i);
            if (inQuotes) {
                if (ch === '"') {
                    if (i + 1 < line.length && line.charAt(i + 1) === '"') {
                        current += '"';
                        i++;
                    } else {
                        inQuotes = false;
                    }
                } else {
                    current += ch;
                }
            } else {
                if (ch === '"') {
                    inQuotes = true;
                } else if (ch === ',') {
                    result.push(current);
                    current = '';
                } else {
                    current += ch;
                }
            }
        }
        result.push(current);
        return result;
    }

    // Parse CSV text into an array of event objects.
    // Returns { events: [...], errors: [...] }
    function _parseCSVEvents(csvText) {
        var lines = csvText.split(/\r?\n/);
        var headers = null;
        var colMap = {};
        var events = [];
        var errors = [];

        // Canonical column name mapping
        var canonical = {
            'id': 'id', 'created_at': 'created_at', 'createdat': 'created_at',
            'recordid': 'recordId', 'record_id': 'recordId',
            'operator': 'operator', 'payload': 'payload',
            'uuid': 'uuid', 'set': 'set'
        };

        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (!line) continue;

            if (!headers) {
                headers = _parseCSVLine(line);
                for (var h = 0; h < headers.length; h++) {
                    var lower = headers[h].toLowerCase().trim().replace(/"/g, '');
                    colMap[h] = canonical[lower] || headers[h].trim().replace(/"/g, '');
                }
                continue;
            }

            var values = _parseCSVLine(line);
            var obj = {};
            for (var v = 0; v < values.length; v++) {
                var key = colMap[v];
                if (!key) continue;
                var val = values[v];
                if (key === 'id') {
                    var numVal = parseInt(val, 10);
                    obj[key] = isNaN(numVal) ? val : numVal;
                } else if (key === 'payload') {
                    try {
                        obj[key] = (typeof val === 'string' && val.trim()) ? JSON.parse(val) : {};
                    } catch (e) {
                        obj[key] = {};
                        errors.push('Row ' + (i + 1) + ': invalid JSON in payload');
                    }
                } else {
                    obj[key] = val;
                }
            }

            if (obj.recordId) {
                events.push(obj);
            }
        }

        if (!headers) {
            errors.push('CSV has no header row');
        }

        return { events: events, errors: errors };
    }

    // Build current state from CSV events by replaying mutations in order.
    // Returns { byTable: { tableId: { recordId: { fields } } } }
    function _buildStateFromCSVEvents(events) {
        // Sort by created_at ascending (earliest first)
        events.sort(function(a, b) {
            var tsA = a.created_at || '';
            var tsB = b.created_at || '';
            return tsA < tsB ? -1 : tsA > tsB ? 1 : 0;
        });

        var byTable = {};  // set (tableId) → { recordId → { fields } }

        for (var i = 0; i < events.length; i++) {
            var evt = events[i];
            var tableId = evt.set || 'unknown';
            var recordId = evt.recordId;
            var op = evt.operator || 'ALT';
            var payload = evt.payload || {};

            if (!byTable[tableId]) byTable[tableId] = {};
            if (!byTable[tableId][recordId]) byTable[tableId][recordId] = {};

            var fields = byTable[tableId][recordId];

            // Extract field operations from payload
            var fieldOps = {};
            if (payload.fields) {
                fieldOps = payload.fields;
            } else if (payload.ALT || payload.INS || payload.NUL) {
                fieldOps = payload;
            } else {
                // Flat payload: treat entire payload as ALT fields
                // (exclude internal keys)
                var altFields = {};
                var payloadKeys = Object.keys(payload);
                for (var k = 0; k < payloadKeys.length; k++) {
                    if (payloadKeys[k].charAt(0) !== '_') {
                        altFields[payloadKeys[k]] = payload[payloadKeys[k]];
                    }
                }
                if (Object.keys(altFields).length > 0) {
                    fieldOps = { ALT: altFields };
                }
            }

            // Normalize to { ALT, INS, NUL } using op if flat
            if (!fieldOps.ALT && !fieldOps.INS && !fieldOps.NUL) {
                if (op === 'ALT' || op === 'INS') {
                    fieldOps = {};
                    fieldOps[op] = payload.fields || payload;
                } else if (op === 'NUL') {
                    fieldOps = { NUL: payload.fields || payload };
                }
            }

            applyFieldOps(fields, fieldOps);
        }

        return { byTable: byTable };
    }

    async function tierCSV(ctx, options) {
        var csvText = options.csvText || null;
        var csvFile = options.csvFile || null;
        var onProgress = options.onProgress || null;

        if (!csvText && csvFile) {
            // Read File object as text
            csvText = await new Promise(function(resolve, reject) {
                var reader = new FileReader();
                reader.onload = function() { resolve(reader.result); };
                reader.onerror = function() { reject(reader.error); };
                reader.readAsText(csvFile);
            });
        }

        if (!csvText) {
            throw new Error('CSV hydration requires csvText or csvFile in options');
        }

        console.log('[Hydration] Tier csv: parsing CSV data (' + csvText.length + ' chars)');

        var parsed = _parseCSVEvents(csvText);
        if (parsed.errors.length > 0) {
            console.warn('[Hydration] CSV parse warnings:', parsed.errors);
        }
        if (parsed.events.length === 0) {
            throw new Error('CSV contained no valid events');
        }

        console.log('[Hydration] CSV parsed:', parsed.events.length, 'events');

        // Build current state by replaying events
        var state = _buildStateFromCSVEvents(parsed.events);
        var tableIds = Object.keys(state.byTable);
        var totalHydrated = 0;

        for (var t = 0; t < tableIds.length; t++) {
            var tableId = tableIds[t];
            var recordMap = state.byTable[tableId];
            var recordIds = Object.keys(recordMap);

            // Build normalized records
            var records = [];
            for (var r = 0; r < recordIds.length; r++) {
                records.push({
                    id: recordIds[r],
                    tableId: tableId,
                    tableName: _getTableName(ctx, tableId) || tableId,
                    fields: recordMap[recordIds[r]],
                    lastSynced: new Date().toISOString()
                });
            }

            if (records.length === 0) continue;

            // Clear existing rows and write new data
            await ctx.deleteTableRecords(tableId);
            await writeRecordsBatched(ctx, records, tableId);

            // Write cursor
            await VersionTracker.writeCursor(ctx, tableId, new Date().toISOString(), 'csv-import');

            // Cache
            ctx.cacheFullTable(tableId, records);

            totalHydrated += records.length;

            if (onProgress) {
                onProgress({
                    tableId: tableId,
                    tableName: _getTableName(ctx, tableId) || tableId,
                    tableIndex: t,
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
            parsedEvents: parsed.events.length,
            parseErrors: parsed.errors
        };
    }

    // ========================================================================
    // TIER 5: URL — Fetch data from an arbitrary URL (JSON or CSV).
    //
    // Supports:
    //   - JSON array of records: [{ id, tableId, fields, ... }, ...]
    //   - JSON object with tables: { tables: { tblXXX: [...], ... } }
    //   - JSON object with records: { records: [...] }
    //   - CSV text (detected by content-type or first-line heuristic)
    // ========================================================================

    async function tierURL(ctx, options) {
        var url = options.url;
        var onProgress = options.onProgress || null;

        if (!url) {
            throw new Error('URL hydration requires a url in options');
        }

        console.log('[Hydration] Tier url: fetching from', url);

        var response = await fetch(url, {
            method: 'GET',
            headers: { 'Accept': 'application/json, text/csv, text/plain' }
        });

        if (!response.ok) {
            throw new Error('URL hydration failed: HTTP ' + response.status);
        }

        var contentType = (response.headers.get('content-type') || '').toLowerCase();
        var text = await response.text();

        if (!text || !text.trim()) {
            throw new Error('URL returned empty response');
        }

        // Detect CSV vs JSON
        var isCSV = contentType.indexOf('csv') !== -1 ||
                    contentType.indexOf('text/plain') !== -1;

        // Heuristic: if first non-whitespace char is not [ or {, treat as CSV
        if (!isCSV) {
            var firstChar = text.trim().charAt(0);
            if (firstChar !== '[' && firstChar !== '{') {
                isCSV = true;
            }
        }

        if (isCSV) {
            // Delegate to CSV tier
            return tierCSV(ctx, {
                csvText: text,
                onProgress: onProgress
            });
        }

        // JSON path — parse and process like bulk-download
        var data = JSON.parse(text);
        var allRecords = [];

        if (Array.isArray(data)) {
            allRecords = data;
        } else if (data && Array.isArray(data.records)) {
            allRecords = data.records;
        } else if (data && typeof data.tables === 'object' && !Array.isArray(data.tables)) {
            var tableKeys = Object.keys(data.tables);
            for (var tk = 0; tk < tableKeys.length; tk++) {
                var tRecords = data.tables[tableKeys[tk]];
                if (Array.isArray(tRecords)) {
                    for (var tr = 0; tr < tRecords.length; tr++) {
                        tRecords[tr].tableId = tRecords[tr].tableId || tRecords[tr].table_id || tableKeys[tk];
                        allRecords.push(tRecords[tr]);
                    }
                }
            }
        }

        if (!allRecords.length) {
            throw new Error('URL response contained no records');
        }

        // Group by table
        var byTable = {};
        for (var i = 0; i < allRecords.length; i++) {
            var rec = allRecords[i];
            var tableId = rec.tableId || rec.table_id || rec.set || 'unknown';
            if (!byTable[tableId]) byTable[tableId] = [];
            byTable[tableId].push(rec);
        }

        var tableIds = Object.keys(byTable);
        var totalHydrated = 0;

        for (var j = 0; j < tableIds.length; j++) {
            var tid = tableIds[j];
            var records = byTable[tid];

            await ctx.deleteTableRecords(tid);
            await writeRecordsBatched(ctx, records, tid);

            var cursorInfo = VersionTracker.resolveCursorFromResponse(data, records);
            await VersionTracker.writeCursor(ctx, tid, cursorInfo.value, 'url-import');

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
            totalTables: tableIds.length
        };
    }

    // ========================================================================
    // HYDRATION SOURCE SELECTION
    //
    // Manages which hydration source the user has chosen. Persisted to
    // localStorage so it survives page reloads. The background hydration
    // flow reads this to decide which tier(s) to attempt.
    //
    // Sources:
    //   'postgres'      — Default. Fetch from Postgres via webhook API.
    //   'csv'           — Load from a local .csv file (user provides File).
    //   'box'           — Download from Box AMO snapshot.
    //   'url'           — Fetch from an arbitrary URL.
    //   'none'          — No local data. Use postgres for current state,
    //                     room data for historical. (online-only mode)
    // ========================================================================

    var HYDRATION_SOURCE_KEY = 'amino_hydration_source';
    var HYDRATION_URL_KEY = 'amino_hydration_url';

    function getHydrationSource() {
        try {
            return localStorage.getItem(HYDRATION_SOURCE_KEY) || 'postgres';
        } catch (e) {
            return 'postgres';
        }
    }

    function setHydrationSource(source) {
        try {
            localStorage.setItem(HYDRATION_SOURCE_KEY, source);
        } catch (e) {
            console.warn('[Hydration] Could not persist hydration source:', e);
        }
        console.log('[Hydration] Hydration source set to:', source);
    }

    function getHydrationURL() {
        try {
            return localStorage.getItem(HYDRATION_URL_KEY) || '';
        } catch (e) {
            return '';
        }
    }

    function setHydrationURL(url) {
        try {
            localStorage.setItem(HYDRATION_URL_KEY, url);
        } catch (e) {
            console.warn('[Hydration] Could not persist hydration URL:', e);
        }
    }

    // Pending CSV file — set by the UI before calling run().
    // Not persisted (File objects can't be serialized).
    var _pendingCSVFile = null;

    function setPendingCSVFile(file) {
        _pendingCSVFile = file;
    }

    function getPendingCSVFile() {
        return _pendingCSVFile;
    }

    // ========================================================================
    // RESET — Clear all dedup/tracking state (call on logout).
    // ========================================================================

    function reset() {
        _processedEventIds = {};
        _optimisticWrites = {};
        _pendingCSVFile = null;
    }

    // ========================================================================
    // EXPORTS
    // ========================================================================

    return {
        // Main entry point
        run: run,

        // Configuration (mutable — change before calling run())
        config: config,

        // Hydration source selection
        getHydrationSource: getHydrationSource,
        setHydrationSource: setHydrationSource,
        getHydrationURL: getHydrationURL,
        setHydrationURL: setHydrationURL,
        setPendingCSVFile: setPendingCSVFile,
        getPendingCSVFile: getPendingCSVFile,

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

        // Record pipeline
        normalizeRecord: normalizeRecord,
        writeRecordsBatched: writeRecordsBatched,

        // Individual tiers (for direct use or testing)
        tierBulkDownload: tierBulkDownload,
        tierPostgres: tierPostgres,
        tierCSV: tierCSV,
        tierURL: tierURL,
        syncTableFromPostgres: syncTableFromPostgres,
        hydrateTableFromPostgres: hydrateTableFromPostgres,

        // CSV parsing utilities (exposed for direct use)
        parseCSVEvents: _parseCSVEvents,
        buildStateFromCSVEvents: _buildStateFromCSVEvents,

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
//       onlineOnlyMode: _onlineOnlyMode,
//       deferEncryption: _deferEncryption,
//       BOX_DOWNLOAD_WEBHOOK: BOX_DOWNLOAD_WEBHOOK,
//
//       // Auth
//       getAuthToken: function() {
//           return (typeof MatrixClient !== 'undefined' && MatrixClient.getAccessToken && MatrixClient.getAccessToken())
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
//
//       // API
//       apiFetch: apiFetch,
//
//       // Events
//       emitEvent: function(name, detail) {
//           window.dispatchEvent(new CustomEvent(name, { detail: detail }));
//       }
//   };
// ============================================================================
