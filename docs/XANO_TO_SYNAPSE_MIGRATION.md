# Migrating from Xano to Synapse as Source of Truth

## Context

Today the data flow is:

```
Airtable  ──webhook/poll──▸  Xano (event stream)  ──GET poll──▸  SPA (IndexedDB)
                                                    ◂──POST────  SPA (write-back)
                                                                     │
                                                                     ▾
                                                               Matrix/Synapse
                                                               (optional bridge)
```

Xano owns the event stream. Synapse is a secondary destination. We want to invert this: **Synapse becomes the source of truth**, Xano is removed entirely.

```
Airtable  ──bridge──▸  Synapse (rooms = event stream)  ◂──/sync──▸  SPA (IndexedDB)
```

---

## What Xano Does Today (and What Must Be Replaced)

| Xano Responsibility | Current Implementation | Replacement in Synapse |
|---------------------|----------------------|----------------------|
| **Event ingestion** | Airtable changes arrive as events (INS/ALT/NUL) via webhook or poll into Xano's database | An Airtable-to-Matrix bridge writes events into Matrix rooms |
| **Event storage** | Ordered event log with auto-increment IDs, timestamps | Matrix room timeline — events are inherently ordered, have `origin_server_ts`, and unique `event_id` |
| **Paginated read** | `GET /aminostream?page=N&created_after=T` | Matrix `/messages` API with `from` token for pagination, or `/sync` with `since` token for incremental |
| **Write-back** | `POST /aminostreampost` with event payload | `PUT /_matrix/client/v3/rooms/{roomId}/send/{eventType}/{txnId}` |
| **Authentication** | API key header | Matrix access token (from Synapse login) |
| **Filtering by table** | `?set=airtable:tblXXXX` query param | Each table lives in its own room — filter by joining/reading specific rooms |
| **Cursor/bookmark** | `lastEventTimestamp` stored in IndexedDB sync store | Matrix `since` / `next_batch` token from `/sync` |

---

## Strategy Options

### Strategy A: Room-per-Table (Recommended)

Map each Airtable table to a dedicated Matrix room within the org space. Schema metadata lives as state events, record mutations live as timeline events.

**Room structure:**

```
Org Space (!orgSpaceId)
├── Table Room: "tblClients" (!roomClients)
│   ├── State: law.firm.schema.table  (table metadata)
│   ├── State: law.firm.schema.field/fldName  (one per field)
│   ├── State: law.firm.schema.field/fldEmail
│   ├── Timeline: law.firm.record.mutate  (INS for recABC)
│   ├── Timeline: law.firm.record.mutate  (ALT for recABC)
│   ├── Timeline: law.firm.record.mutate  (NUL for recABC, fldEmail)
│   └── ...
│
├── Table Room: "tblMatters" (!roomMatters)
│   └── ...
│
├── Table Room: "tblNotes" (!roomNotes)
│   └── ...
│
└── Config Room (!configRoom)  [optional, or use org space state]
    ├── State: law.firm.org.config
    └── State: law.firm.bridge.config
```

**Event schema for `law.firm.record.mutate`:**

```json
{
  "type": "law.firm.record.mutate",
  "content": {
    "recordId": "recABC123",
    "op": "INS",
    "fields": {
      "fldName": "Jane Doe",
      "fldEmail": "jane@example.com"
    },
    "source": "airtable",
    "sourceTimestamp": 1705315800000
  }
}
```

For ALT (alter) events, only changed fields are included. For NUL (nullify), `fields` contains the nullified field IDs mapped to `null`:

```json
{
  "type": "law.firm.record.mutate",
  "content": {
    "recordId": "recABC123",
    "op": "ALT",
    "fields": {
      "fldEmail": "newemail@example.com"
    },
    "source": "airtable",
    "sourceTimestamp": 1705316000000
  }
}
```

```json
{
  "type": "law.firm.record.mutate",
  "content": {
    "recordId": "recABC123",
    "op": "NUL",
    "fields": {
      "fldEmail": null
    },
    "source": "airtable",
    "sourceTimestamp": 1705316100000
  }
}
```

**Why this strategy works:**

- Matrix room timelines are an append-only ordered event log — exactly what Xano's event stream is
- State events give us a natural place for schema (tables, fields) that's queryable without replaying the full timeline
- Room membership = access control. Staff see all table rooms; clients see portal rooms (existing design)
- `/sync` gives us real-time push instead of polling every 15 seconds
- Pagination via `/messages?dir=f&from=token` replaces `?page=N&created_after=T`
- The existing `MatrixBridge` already writes `law.firm.record` events — this extends that pattern

**Drawbacks:**

- Large tables generate long timelines. Matrix is designed for this (chat rooms can have millions of events), but materialization on the client must be efficient
- No server-side SQL queries — all filtering/sorting happens client-side (same as today with IndexedDB)

---

### Strategy B: Single Event Stream Room

All events across all tables go into one room, mirroring how Xano stores everything in a single event stream.

```
Org Space
└── Event Stream Room (!streamRoom)
    ├── Timeline: law.firm.record.mutate  (tblClients, recABC, INS)
    ├── Timeline: law.firm.record.mutate  (tblMatters, recXYZ, INS)
    ├── Timeline: law.firm.record.mutate  (tblClients, recABC, ALT)
    └── ...
```

Each event includes a `tableId` field so the client can filter.

**Pros:**
- Simplest migration — almost 1:1 with Xano's model
- Single sync cursor for everything
- Easy to reason about event ordering across tables

**Cons:**
- Loses room-based access control granularity (can't give a client access to only their table)
- One massive timeline — harder to paginate per-table
- Doesn't leverage Matrix's room model
- Would require a separate mechanism for per-table client access (portal rooms become disconnected from the event stream)

**Verdict:** Simpler to build, but throws away the structural advantage of Matrix. Not recommended long-term.

---

### Strategy C: Hybrid — Stream Room + View Rooms

Combine A and B: a single internal event stream room (for staff/bridge use) plus per-client portal rooms that receive filtered copies of events.

```
Org Space
├── Stream Room (!streamRoom)  ← bridge writes here, staff sync from here
│   └── All events, all tables
│
├── Client Portal: "Jane Doe" (!portalJane)  ← filtered subset
│   └── Only records linked to Jane, only visible fields
│
└── Client Portal: "Acme Corp" (!portalAcme)
    └── Only records linked to Acme
```

**Pros:**
- Staff get a single stream (fast sync, simple cursor)
- Clients get access-controlled views
- Bridge only writes to one place; a "fan-out" worker copies to portals

**Cons:**
- Data duplication (events exist in stream room AND portal rooms)
- Fan-out logic adds complexity
- Two sources of truth for the same data (potential consistency issues)

**Verdict:** Reasonable middle ground, but the duplication adds operational burden. Strategy A is cleaner.

---

## Recommended Approach: Strategy A (Room-per-Table)

### Component 1: Airtable-to-Synapse Bridge

Replaces Xano's role as event ingestion. This is a lightweight service that:

1. Receives Airtable webhook notifications (or polls the Airtable API for changes)
2. Converts each change into a `law.firm.record.mutate` event
3. Sends the event to the appropriate table room via Matrix client-server API
4. Maintains schema state events when table/field definitions change

**Implementation options (ranked):**

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| **n8n workflow** | Airtable webhook → n8n → Matrix send | Reuses existing n8n infra at `n8n.intelechia.com`; visual workflow; quick to build | Limited error handling; n8n becomes a dependency |
| **Matrix Application Service** | Registered AS on the Synapse homeserver; receives Airtable webhooks directly | First-class Matrix citizen; can act as any user; no rate limits; can use virtual users | Requires Synapse admin access to register; more code to write |
| **Standalone bridge service** | Small Node.js/Python service running alongside Synapse | Full control; can batch events; proper error handling and retry | Another service to deploy and monitor |

**Recommendation:** Start with an **n8n workflow** for speed, plan to move to a **standalone bridge** or **Application Service** when the n8n approach hits limits.

**n8n workflow sketch:**

```
Airtable Webhook Trigger
  → Parse change (extract table, record, changed fields)
  → Determine operation type (INS/ALT/NUL)
  → Look up table-to-room mapping (stored in Matrix org space state or a config node)
  → HTTP Request: PUT /_matrix/client/v3/rooms/{roomId}/send/law.firm.record.mutate/{txnId}
     Headers: Authorization: Bearer {bridge_bot_access_token}
     Body: { recordId, op, fields, source: "airtable", sourceTimestamp }
```

**Schema sync:** When Airtable tables or fields change, the bridge updates state events:

```
PUT /_matrix/client/v3/rooms/{roomId}/state/law.firm.schema.field/{fieldId}
{
  "fieldId": "fldName",
  "name": "Full Name",
  "type": "singleLineText",
  "options": {}
}
```

### Component 2: SPA Sync Rewrite

Replace `fetchPage()` / `incrementalSync()` / `postEvent()` with Matrix sync.

**Key changes in index.html:**

| Current Function | Replacement | Notes |
|-----------------|------------|-------|
| `fetchPage(page, createdAfter)` | `matrixSync(since)` using `/sync?since=token&filter=...` | Filter to only `law.firm.*` event types |
| `incrementalSync()` | Long-poll `/sync` loop | Matrix's native real-time sync; no 15s polling needed |
| `postEvent(payload)` | `matrixClient.sendEvent(roomId, type, content)` | Already implemented in matrix.js |
| `SyncHistory` polling class | `MatrixSyncLoop` class | Uses `/sync` with `timeout=30000` for long-poll |
| `_EP` endpoint array | Gone — replaced by Synapse homeserver URL | Single URL: `https://app.aminoimmigration.com` |
| `API_KEY` auth | Matrix access token | From Synapse login (already implemented) |

**New sync flow:**

```javascript
class MatrixSyncLoop {
    constructor(matrixClient, orgSpaceId) {
        this.client = matrixClient;
        this.orgSpaceId = orgSpaceId;
        this.since = loadSyncToken();  // from IndexedDB sync store
        this.running = false;
    }

    async start() {
        this.running = true;

        // Initial sync: fetch full state + recent timeline for each table room
        if (!this.since) {
            await this.initialSync();
        }

        // Incremental sync loop (long-poll)
        while (this.running) {
            try {
                var response = await this.client.sync({
                    since: this.since,
                    timeout: 30000,
                    filter: {
                        room: {
                            rooms: this.tableRoomIds,  // only table rooms
                            timeline: {
                                types: ['law.firm.record.mutate'],
                                limit: 100
                            },
                            state: {
                                types: [
                                    'law.firm.schema.table',
                                    'law.firm.schema.field'
                                ]
                            }
                        }
                    }
                });

                await this.processSync(response);
                this.since = response.next_batch;
                await saveSyncToken(this.since);
            } catch (err) {
                // Exponential backoff on failure (same pattern as current SyncHistory)
                await this.backoff();
            }
        }
    }

    async initialSync() {
        // For each table room, paginate backwards through /messages
        // to build initial state, or use /sync with no since token
        // (Synapse returns full state + recent timeline)
    }

    async processSync(response) {
        for (var [roomId, roomData] of Object.entries(response.rooms?.join || {})) {
            var tableId = this.roomToTableMap[roomId];

            // Process state events (schema changes)
            for (var event of roomData.state?.events || []) {
                if (event.type === 'law.firm.schema.table') {
                    await updateTableMetadata(event.content);
                } else if (event.type === 'law.firm.schema.field') {
                    await updateFieldMetadata(tableId, event.state_key, event.content);
                }
            }

            // Process timeline events (record mutations)
            for (var event of roomData.timeline?.events || []) {
                if (event.type === 'law.firm.record.mutate') {
                    await processRecordMutation(tableId, event.content, event.event_id, event.origin_server_ts);
                }
            }
        }
    }
}
```

**Mapping the current event processing to Matrix events:**

The existing `processRecordMutation` logic (lines 5166-5228 in index.html) handles INS/ALT/NUL operations and writes to IndexedDB. This logic stays largely the same — instead of receiving events from Xano's JSON response, it receives them from the Matrix `/sync` response. The event structure changes from:

```javascript
// Xano event (current)
{
  id: 12345,
  set: "airtable:tblClients",
  recordId: "recABC",
  operator: "ALT",
  payload: { fields: { ALT: { fldEmail: "new@example.com" } } },
  created_at: 1705316000000
}
```

to:

```javascript
// Matrix event (proposed)
{
  event_id: "$abcdef123456",
  type: "law.firm.record.mutate",
  origin_server_ts: 1705316000000,
  content: {
    recordId: "recABC",
    op: "ALT",
    fields: { fldEmail: "new@example.com" },
    source: "airtable"
  }
}
```

The table ID is implicit (derived from which room the event is in) rather than embedded in the event. The field payload is flattened (no nested `{ ALT: {...} }` wrapper) since the `op` field carries the operation type.

### Component 3: Write Path (SPA → Synapse)

Currently `postEvent()` POSTs to Xano's `/aminostreampost`. Replace with Matrix event sends:

```javascript
async function postRecordMutation(tableId, recordId, op, fields) {
    var roomId = tableToRoomMap[tableId];
    var txnId = 'm' + Date.now() + '.' + Math.random().toString(36).slice(2);

    await matrixClient.sendEvent(roomId, 'law.firm.record.mutate', {
        recordId: recordId,
        op: op,
        fields: fields,
        source: 'app',
        sourceTimestamp: Date.now()
    }, txnId);
}
```

The `matrixClient.sendEvent()` in matrix.js (line 454) already handles this. The write path is nearly zero new code.

### Component 4: Table-to-Room Discovery

The SPA needs to know which rooms correspond to which tables. Two approaches:

**Option 1: Org space state event (recommended)**

Store a mapping in the org space:

```json
// State event: law.firm.table.registry (state_key: "")
{
  "tables": {
    "tblClients": { "roomId": "!abc123:app.aminoimmigration.com", "name": "Clients" },
    "tblMatters": { "roomId": "!def456:app.aminoimmigration.com", "name": "Matters" },
    "tblNotes":   { "roomId": "!ghi789:app.aminoimmigration.com", "name": "Notes" }
  }
}
```

On login, the SPA reads this state event and joins all listed rooms.

**Option 2: Room directory / space hierarchy**

Use the existing space hierarchy (Synapse's `/hierarchy` endpoint) to discover child rooms. Each table room has a `law.firm.schema.table` state event that identifies it.

Option 1 is simpler and faster (one request vs. hierarchy traversal).

### Component 5: Authentication Consolidation

Already designed in `SYNAPSE_LOGIN_ENCRYPTION_DESIGN.md`. Key change for this migration: the API key is no longer needed at all. Synapse access tokens replace it entirely.

```
Before:  API_KEY → authenticates to Xano
After:   Matrix access_token → authenticates to Synapse (already have this)
```

The `law.firm.api_config` account data (from the encryption design doc) can still be used for per-user configuration, but it no longer needs to carry a Xano API key.

### Component 6: Box Backup Adaptation

`BoxSync.push()` currently serializes IndexedDB to `.amo` format and uploads via n8n. This can remain unchanged — the data is still in IndexedDB regardless of where it came from. The `.amo` snapshot is a client-side concern.

However, consider whether Box backups are still needed. With Synapse as the source of truth:

- **Data durability** is handled by Synapse's PostgreSQL database
- **Point-in-time recovery** can use Synapse's event history (events are immutable and ordered)
- **Offline snapshots** might still be valuable for air-gapped use cases

**Recommendation:** Keep Box backup as an optional feature, but it's no longer critical for data safety.

---

## Migration Phases

### Phase 0: Preparation (No User-Facing Changes)

- [ ] Define the `law.firm.record.mutate` event schema (finalize the format above)
- [ ] Define the `law.firm.table.registry` state event schema
- [ ] Create Matrix rooms for each existing Airtable table
- [ ] Write the table registry state event to the org space
- [ ] Write schema state events (table metadata, field definitions) to each table room

### Phase 1: Dual-Write Bridge

Run Airtable changes through **both** Xano and Synapse simultaneously.

- [ ] Build the Airtable→Synapse bridge (n8n workflow or standalone service)
- [ ] Bridge writes `law.firm.record.mutate` events to table rooms
- [ ] Bridge writes schema changes as state events
- [ ] Verify event parity: same data arrives in both Xano and Synapse
- [ ] Monitor for gaps, ordering issues, or missed events
- [ ] Duration: run dual-write for 2-4 weeks to build confidence

### Phase 2: SPA Reads from Synapse (Xano Still Available as Fallback)

- [ ] Implement `MatrixSyncLoop` in the SPA (new sync engine)
- [ ] Implement table-to-room discovery via `law.firm.table.registry`
- [ ] Wire `processSync()` into the existing IndexedDB write path
- [ ] Add a feature flag / toggle: `syncSource: 'xano' | 'synapse'`
- [ ] Default to Synapse, allow fallback to Xano via settings
- [ ] Replace `postEvent()` with Matrix event sends
- [ ] Test: full sync from empty state, incremental sync, write-back
- [ ] Verify data parity between Xano-sourced and Synapse-sourced IndexedDB

### Phase 3: Consolidate Authentication

- [ ] Implement the Synapse-unified login flow (from `SYNAPSE_LOGIN_ENCRYPTION_DESIGN.md`)
- [ ] Remove API key input/storage (no longer needed — Synapse token is the credential)
- [ ] Remove `_EP` endpoint array and `initSecureEndpoints()`
- [ ] Single login screen: Matrix username + password → everything derived

### Phase 4: Remove Xano

- [ ] Remove `fetchPage()` and Xano-specific pagination logic
- [ ] Remove `XANO_POST_API` and Xano POST logic
- [ ] Remove `API_KEY` variable and all references
- [ ] Remove the Xano endpoint base64 array (`_EP[0]`, `_EP[1]`)
- [ ] Remove `SyncHistory` polling class (replaced by `MatrixSyncLoop`)
- [ ] Stop the Airtable→Xano webhook/ingestion
- [ ] Archive or decommission the Xano workspace
- [ ] Update Box backup to no longer reference Xano metadata (if applicable)

### Phase 5: Post-Migration Enhancements

Things that become possible once Synapse is the source of truth:

- [ ] **Real-time collaboration**: Multiple users see changes instantly via `/sync` (no 15s polling delay)
- [ ] **Granular access control**: Give clients read access to specific table rooms (their data only)
- [ ] **Offline-first with conflict resolution**: Matrix handles event ordering across offline/online transitions
- [ ] **Audit trail**: Matrix events are immutable — full history of every change, who made it, when
- [ ] **Federation**: Optionally federate with client-owned Matrix servers for data sovereignty
- [ ] **E2EE**: End-to-end encrypt table rooms for zero-knowledge hosting (Synapse server can't read the data)
- [ ] **Typing indicators / presence**: Real-time "who's looking at this record" via Matrix presence

---

## Risk Analysis

| Risk | Impact | Mitigation |
|------|--------|-----------|
| **Matrix /sync is slower than Xano API for bulk initial sync** | First load could be slow with large datasets | Use `/messages` pagination for initial backfill; cache aggressively in IndexedDB; consider a "snapshot" state event for fast bootstrap |
| **Synapse storage grows unbounded** | PostgreSQL disk usage increases over time as events accumulate | Use Synapse's purge history admin API for old events (keep last N months); data is materialized in IndexedDB anyway |
| **Rate limits on Matrix client-server API** | Bridge could be throttled during high-volume Airtable changes | Use Application Service (exempt from rate limits) or batch events; Synapse can be configured with higher limits for local users |
| **Event ordering across tables** | Xano gives a single global order; Matrix rooms have independent timelines | Use `origin_server_ts` for cross-table ordering; the bridge can include a sequence number in event content |
| **Bridge downtime = missed Airtable changes** | Data gap between Airtable and Synapse | Bridge maintains a cursor/bookmark of last processed Airtable change; on restart, replays from cursor; Airtable webhook replay or API polling for catch-up |
| **Breaking change to event schema** | Old events in rooms have wrong format | Version the event type (e.g., `law.firm.record.mutate.v2`) or include a `schemaVersion` field in content |
| **Synapse downtime** | App can't sync at all (unlike Xano, there's no backup API) | IndexedDB provides offline access to last-synced data; Synapse has good uptime on managed hosting; can keep a read-only Xano fallback during transition |

---

## Performance Considerations

### Initial Sync (Cold Start)

**Current (Xano):** Paginate through `/aminostream?page=1`, `page=2`, etc. Each page returns ~100 events. For 50,000 events = 500 requests.

**Proposed (Synapse):** Two options:

1. **Room-by-room /messages pagination:** For each table room, paginate backwards. Slightly more requests (one stream per room) but parallelizable.

2. **Snapshot state event (recommended for large datasets):** The bridge periodically writes a "snapshot" state event to each table room containing the current materialized state of all records. On cold start, the SPA reads this snapshot (one request per table), then syncs incrementally from that point forward.

```json
// State event: law.firm.snapshot (state_key: "")
{
  "version": 42,
  "cursor": "$eventIdAtSnapshot",
  "records": {
    "recABC": { "fldName": "Jane", "fldEmail": "jane@example.com" },
    "recDEF": { "fldName": "John", "fldEmail": "john@example.com" }
  },
  "generatedAt": 1705316000000
}
```

Note: Matrix state events have a size limit (~65KB default). For large tables, split across multiple state events with different state keys:

```
law.firm.snapshot / "chunk:0"  → records 0-499
law.firm.snapshot / "chunk:1"  → records 500-999
law.firm.snapshot / "chunk:2"  → records 1000-1499
```

### Incremental Sync (Warm)

**Current (Xano):** Poll every 15 seconds, fetch events after `lastEventTimestamp`.

**Proposed (Synapse):** Long-poll `/sync?since=token&timeout=30000`. Server holds the connection open until new events arrive or timeout. This gives:

- Sub-second latency for new events (vs. up to 15 seconds with polling)
- Zero wasted requests when nothing has changed
- Lower server load (one long-poll vs. repeated short polls)

### Write Path

**Current (Xano):** POST to `/aminostreampost` — single HTTP request.

**Proposed (Synapse):** PUT to `/rooms/{roomId}/send/...` — single HTTP request. Same cost.

---

## Mapping Current Code to New Code

### Files That Change

| File | Changes |
|------|---------|
| **index.html** | Replace `fetchPage()`, `incrementalSync()`, `postEvent()`, `SyncHistory`, `_EP` array, `API_KEY` usage, auth screens. Add `MatrixSyncLoop`, table-room discovery, Synapse-only auth. ~500-800 lines of sync code replaced. |
| **matrix.js** | Mostly unchanged. May add helper methods for `/messages` pagination, sync filter construction, snapshot reading. The `MatrixBridge` class may be simplified since writing to rooms is now the primary path, not a secondary bridge. |

### Functions Removed

```
fetchPage()              → replaced by MatrixSyncLoop.processSync()
incrementalSync()        → replaced by MatrixSyncLoop.start()
postEvent()              → replaced by postRecordMutation() using matrixClient
SyncHistory class        → replaced by MatrixSyncLoop class
initSecureEndpoints()    → removed (no encrypted Xano URLs to manage)
_EP array                → removed
API_KEY variable         → removed
initAuthScreen()         → merged into Synapse login flow
```

### Functions Modified

```
openDB()                 → sync store schema: replace lastEventTimestamp with matrixSyncToken
processEvent()           → adapt to Matrix event shape (content.op instead of operator, etc.)
BoxSync.push()           → unchanged (reads from IndexedDB, format-agnostic)
BoxSync.pull()           → unchanged (writes to IndexedDB)
```

### Functions Added

```
MatrixSyncLoop           → new class replacing SyncHistory
discoverTableRooms()     → reads law.firm.table.registry from org space
postRecordMutation()     → writes law.firm.record.mutate to table room
readSnapshotState()      → reads law.firm.snapshot for fast cold start
```

---

## Open Questions

1. **Airtable webhook reliability.** How reliably does Airtable deliver webhooks today? If the current Xano ingestion uses polling instead of webhooks, the bridge needs the same approach. Investigate whether the Xano backend polls Airtable or receives pushes.

2. **Event size limits.** Matrix events have a default max size of ~65KB. Airtable records with large attachment fields or long rich text could exceed this. Strategy: store large blobs separately (e.g., in Matrix content repository via `/_matrix/media/`) and reference them by `mxc://` URI in the event.

3. **Synapse hosting.** Is `app.aminoimmigration.com` self-hosted or managed? If self-hosted, who manages backups, upgrades, and monitoring? This becomes more critical when Synapse is the sole source of truth.

4. **Multi-tenancy.** If multiple law firms use this, does each get their own Synapse homeserver, or do they share one with separate org spaces? Room-level access control handles isolation, but separate homeservers provide stronger guarantees.

5. **Historical data migration.** How many events are in Xano today? The bridge needs a one-time backfill to replay all historical events into Matrix rooms before going live.

6. **Conflict resolution for writes.** If two users edit the same record field simultaneously, Xano presumably uses last-write-wins (based on event ordering). Matrix rooms have a single linear timeline — events from both users will both appear, and the client materializes the latest value. Same semantics, but worth validating.

---

## Summary

The migration is feasible and architecturally sound. Matrix/Synapse provides everything Xano does (ordered event log, pagination, auth, real-time sync) plus things Xano doesn't (access control, room-based data isolation, E2EE, federation, real-time push).

**Estimated scope:**
- Bridge service: new component (~200-400 lines)
- SPA sync rewrite: ~500-800 lines replaced in index.html
- Auth consolidation: aligned with existing SYNAPSE_LOGIN_ENCRYPTION_DESIGN.md
- Xano removal: ~300 lines deleted from index.html

The phased approach (dual-write → read switchover → auth consolidation → Xano removal) ensures zero data loss and provides rollback options at every stage.
