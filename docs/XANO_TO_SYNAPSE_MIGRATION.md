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
Airtable  ──bridge──▸  Synapse (vault room)  ◂──/sync──▸  SPA (IndexedDB)
                             │
                             ▾ fan-out
                        Portal Rooms (per-user access)
```

---

## What Xano Does Today (and What Must Be Replaced)

| Xano Responsibility | Current Implementation | Replacement in Synapse |
|---------------------|----------------------|----------------------|
| **Event ingestion** | Airtable changes arrive as events (INS/ALT/NUL) via webhook or poll into Xano's database | An Airtable-to-Matrix bridge writes events into the vault room |
| **Event storage** | Ordered event log with auto-increment IDs, timestamps | Vault room timeline — events are inherently ordered, have `origin_server_ts`, and unique `event_id` |
| **Paginated read** | `GET /aminostream?page=N&created_after=T` | Matrix `/messages` API with `from` token for pagination, or `/sync` with `since` token for incremental |
| **Write-back** | `POST /aminostreampost` with event payload | `PUT /_matrix/client/v3/rooms/{vaultRoomId}/send/{eventType}/{txnId}` |
| **Authentication** | API key header | Matrix access token (from Synapse login) |
| **Filtering by table** | `?set=airtable:tblXXXX` query param | Client-side filter on `tableId` field within events (same room, all tables) |
| **Cursor/bookmark** | `lastEventTimestamp` stored in IndexedDB sync store | Matrix `since` / `next_batch` token from `/sync` |

---

## Architecture: Vault Room + Portal Rooms

### Design Principles

1. **All staff are trusted** — every staff member sees all data
2. **Users (clients) see only their own data** — access carved out per-user via portal rooms
3. **One source of truth** — the vault room is the canonical event stream
4. **Portal rooms are projections** — derived views, not independent data stores

### Room Structure

```
Org Space (!orgSpaceId)
│
├── Vault Room (!vault)                    ← ALL data, staff-only
│   ├── State: law.firm.schema.table/tblClients       (table metadata)
│   ├── State: law.firm.schema.table/tblMatters
│   ├── State: law.firm.schema.field/tblClients/fldName   (field defs)
│   ├── State: law.firm.schema.field/tblClients/fldEmail
│   ├── State: law.firm.schema.field/tblMatters/fldTitle
│   ├── State: law.firm.vault.config                  (vault metadata)
│   │
│   ├── Timeline: law.firm.record.mutate  (tblClients, recABC, INS)
│   ├── Timeline: law.firm.record.mutate  (tblMatters, recXYZ, INS)
│   ├── Timeline: law.firm.record.mutate  (tblClients, recABC, ALT)
│   ├── Timeline: law.firm.record.mutate  (tblMatters, recXYZ, ALT)
│   └── ...
│
├── Portal Room: "Jane Doe" (!portalJane)  ← Jane's records only
│   ├── State: law.firm.portal.config     (which client, visible fields)
│   ├── Timeline: law.firm.record.mutate  (only records linked to Jane)
│   └── ...
│
├── Portal Room: "Acme Corp" (!portalAcme) ← Acme's records only
│   ├── State: law.firm.portal.config
│   ├── Timeline: law.firm.record.mutate  (only records linked to Acme)
│   └── ...
│
└── Portal Room: "Bob Smith" (!portalBob)  ← Bob's records only
    └── ...
```

**Staff** join the vault room. One room, one sync cursor, all data.

**Users/clients** join only their portal room. They never see the vault. They see only their own records, only the fields designated as client-visible.

### Why One Vault Room (Not Room-per-Table)

| Concern | One vault room | Room-per-table |
|---------|---------------|----------------|
| **Sync complexity** | One room, one `/sync` cursor, one timeline | N rooms, N cursors, N timelines to merge |
| **Cross-table event ordering** | Naturally ordered (single timeline) | Need `origin_server_ts` to reconstruct global order |
| **Bridge writes** | One target room | Must route each event to the correct room |
| **Staff access** | Join one room = see everything | Must join every table room |
| **Cold start** | One `/messages` pagination stream | N parallel pagination streams |
| **Matches Xano model** | 1:1 — single ordered event log | Requires restructuring the event model |
| **Per-table staff access control** | Not supported (all-or-nothing) | Supported but not needed |

Since all staff are trusted to see everything, the extra room-per-table granularity adds complexity with no benefit.

---

## Event Schemas

### Record Mutation: `law.firm.record.mutate`

The core event — replaces Xano's INS/ALT/NUL operations.

**INSERT (new record):**
```json
{
  "type": "law.firm.record.mutate",
  "content": {
    "tableId": "tblClients",
    "recordId": "recABC123",
    "op": "INS",
    "fields": {
      "fldName": "Jane Doe",
      "fldEmail": "jane@example.com",
      "fldStatus": "Active"
    },
    "source": "airtable",
    "sourceTimestamp": 1705315800000
  }
}
```

**ALTER (update fields):** Only changed fields included.
```json
{
  "type": "law.firm.record.mutate",
  "content": {
    "tableId": "tblClients",
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

**NULLIFY (clear fields):** Nullified fields mapped to `null`.
```json
{
  "type": "law.firm.record.mutate",
  "content": {
    "tableId": "tblClients",
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

### Schema State Events

**Table metadata** (state key = tableId):
```json
{
  "type": "law.firm.schema.table",
  "state_key": "tblClients",
  "content": {
    "tableId": "tblClients",
    "name": "Clients",
    "description": "Client contact information"
  }
}
```

**Field definition** (state key = tableId/fieldId):
```json
{
  "type": "law.firm.schema.field",
  "state_key": "tblClients/fldName",
  "content": {
    "tableId": "tblClients",
    "fieldId": "fldName",
    "name": "Full Name",
    "type": "singleLineText",
    "options": {}
  }
}
```

### Vault Config State Event

```json
{
  "type": "law.firm.vault.config",
  "state_key": "",
  "content": {
    "version": 1,
    "clientTable": "tblClients",
    "clientIdentifierField": "fldName",
    "clientVisibleTables": ["tblClients", "tblMatters"],
    "clientHiddenTables": ["tblBilling", "tblInternal"],
    "clientVisibleFields": {
      "tblClients": ["fldName", "fldEmail", "fldStatus"],
      "tblMatters": ["fldTitle", "fldStatus", "fldDueDate"]
    },
    "linkedRecordTables": {
      "tblMatters": "fldClient"
    }
  }
}
```

### Portal Config State Event

Each portal room carries its own config so the client app knows what it's looking at:

```json
{
  "type": "law.firm.portal.config",
  "state_key": "",
  "content": {
    "clientName": "Jane Doe",
    "clientRecordId": "recABC123",
    "visibleTables": ["tblClients", "tblMatters"],
    "visibleFields": {
      "tblClients": ["fldName", "fldEmail", "fldStatus"],
      "tblMatters": ["fldTitle", "fldStatus", "fldDueDate"]
    }
  }
}
```

---

## Component Design

### Component 1: Airtable-to-Synapse Bridge

Replaces Xano's event ingestion. Writes all events to the single vault room.

**Implementation options:**

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| **n8n workflow** | Airtable webhook → n8n → Matrix send | Reuses existing n8n infra; visual workflow; quick to build | Limited error handling; n8n becomes a dependency |
| **Matrix Application Service** | Registered AS on Synapse; receives Airtable webhooks directly | First-class Matrix citizen; no rate limits; can use virtual users | Requires Synapse admin access; more code |
| **Standalone bridge service** | Small Node.js/Python service alongside Synapse | Full control; proper retry logic; can batch events | Another service to deploy |

**Recommendation:** Start with **n8n workflow** for speed.

**n8n workflow sketch:**

```
Airtable Webhook Trigger
  → Parse change (extract table, record, changed fields)
  → Determine operation type (INS/ALT/NUL)
  → HTTP Request: PUT /_matrix/client/v3/rooms/{vaultRoomId}/send/law.firm.record.mutate/{txnId}
     Headers: Authorization: Bearer {bridge_bot_access_token}
     Body: { tableId, recordId, op, fields, source: "airtable", sourceTimestamp }
```

The bridge bot is a dedicated Matrix user (e.g., `@bridge:app.aminoimmigration.com`) with write access to the vault room. All Airtable-originated events come from this user, making them distinguishable from staff-originated events.

### Component 2: Portal Fan-Out Worker

When data changes in the vault, a worker decides which portal rooms need updates.

**Logic:**

```
Vault event arrives: law.firm.record.mutate
  │
  ├── Read vault config: which table? which linked-record field?
  ├── Look up the record's linked client (e.g., recABC → linked via fldClient → "Jane Doe")
  ├── Look up Jane's portal room from portal registry
  ├── Filter event to only client-visible fields
  └── Send filtered event to !portalJane
```

**Where this runs:**

- **Option A: In the bridge itself** — after writing to the vault, immediately fan out to portals. Simple, but couples ingestion with fan-out.
- **Option B: Separate worker** — listens to vault room via `/sync`, processes new events, fans out. Decoupled, can lag behind without blocking ingestion.
- **Option C: In the SPA** — when a staff user has the app open and the MatrixBridge is active, it fans out during hydration (this is what the current `hydrateToMatrix()` does). Works for manual triggers but not real-time.

**Recommendation:** Option B (separate worker) for production. Option C (SPA-driven) is fine for initial development and testing.

### Component 3: SPA Sync Rewrite

Replace `fetchPage()` / `incrementalSync()` / `postEvent()` with Matrix sync against the vault room.

**Key changes in index.html:**

| Current Function | Replacement | Notes |
|-----------------|------------|-------|
| `fetchPage(page, createdAfter)` | `matrixSync(since)` using `/sync?since=token` | Single room filter, `law.firm.*` event types |
| `incrementalSync()` | Long-poll `/sync` loop | Real-time push; no 15s polling |
| `postEvent(payload)` | `matrixClient.sendEvent(vaultRoomId, type, content)` | Already in matrix.js |
| `SyncHistory` polling class | `VaultSyncLoop` class | Long-poll with exponential backoff |
| `_EP` endpoint array | Gone — single Synapse homeserver URL | `https://app.aminoimmigration.com` |
| `API_KEY` auth | Matrix access token | From Synapse login |

**New sync flow:**

```javascript
class VaultSyncLoop {
    constructor(matrixClient, vaultRoomId) {
        this.client = matrixClient;
        this.vaultRoomId = vaultRoomId;
        this.since = loadSyncToken();  // from IndexedDB sync store
        this.running = false;
    }

    async start() {
        this.running = true;

        // Initial sync: full state + recent timeline
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
                            rooms: [this.vaultRoomId],
                            timeline: {
                                types: ['law.firm.record.mutate'],
                                limit: 100
                            },
                            state: {
                                types: [
                                    'law.firm.schema.table',
                                    'law.firm.schema.field',
                                    'law.firm.vault.config'
                                ]
                            }
                        }
                    }
                });

                await this.processSync(response);
                this.since = response.next_batch;
                await saveSyncToken(this.since);
            } catch (err) {
                await this.backoff();
            }
        }
    }

    async processSync(response) {
        var roomData = response.rooms?.join?.[this.vaultRoomId];
        if (!roomData) return;

        // Process state events (schema changes)
        for (var event of roomData.state?.events || []) {
            if (event.type === 'law.firm.schema.table') {
                await updateTableMetadata(event.content);
            } else if (event.type === 'law.firm.schema.field') {
                await updateFieldMetadata(event.content);
            }
        }

        // Process timeline events (record mutations)
        for (var event of roomData.timeline?.events || []) {
            if (event.type === 'law.firm.record.mutate') {
                await processRecordMutation(event.content, event.event_id, event.origin_server_ts);
            }
        }
    }
}
```

**Xano → Matrix event shape mapping:**

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

// Matrix event (new)
{
  event_id: "$abcdef123456",
  type: "law.firm.record.mutate",
  origin_server_ts: 1705316000000,
  content: {
    tableId: "tblClients",
    recordId: "recABC",
    op: "ALT",
    fields: { fldEmail: "new@example.com" },
    source: "airtable"
  }
}
```

The `tableId` is in the event content (since all tables share the vault room). The field payload is flattened — no nested `{ ALT: {...} }` wrapper since `op` carries the operation type.

### Component 4: Write Path (SPA → Vault)

```javascript
async function postRecordMutation(tableId, recordId, op, fields) {
    var txnId = 'm' + Date.now() + '.' + Math.random().toString(36).slice(2);

    await matrixClient.sendEvent(VAULT_ROOM_ID, 'law.firm.record.mutate', {
        tableId: tableId,
        recordId: recordId,
        op: op,
        fields: fields,
        source: 'app',
        sourceTimestamp: Date.now()
    }, txnId);
}
```

Writes go to the one vault room. The `matrixClient.sendEvent()` in matrix.js already handles this.

### Component 5: Vault Room Discovery

On login, the SPA needs to find the vault room. Two options:

**Option 1: Org space state event (recommended)**

```json
{
  "type": "law.firm.org.config",
  "state_key": "",
  "content": {
    "vaultRoomId": "!vaultABC:app.aminoimmigration.com",
    "orgName": "Immigration Firm"
  }
}
```

The SPA reads the org space state, gets the vault room ID, joins it.

**Option 2: Matrix account data**

Store per-user in account data:
```javascript
await matrixClient.getAccountData('law.firm.user_config');
// → { vaultRoomId: "!vaultABC:..." }
```

Option 1 is better — the vault room ID is org-wide, not per-user.

### Component 6: User Portal Access

When a user (client, not staff) logs in:

1. They are **not** a member of the vault room
2. They are a member of their portal room (invited by staff or the bridge bot)
3. The SPA detects this: no vault room in org config → check for portal rooms
4. The portal room's `law.firm.portal.config` state event tells the SPA what data to expect
5. The SPA syncs from the portal room using the same `VaultSyncLoop` logic (just pointed at a different room)

**Staff vs. user detection:**

```javascript
async function resolveDataRoom(matrixClient, orgSpaceId) {
    // Try to read vault config from org space
    var orgConfig = await matrixClient.getStateEvent(orgSpaceId, 'law.firm.org.config', '');

    if (orgConfig?.vaultRoomId) {
        // Check if user is a member of the vault room
        try {
            await matrixClient.getJoinedMembers(orgConfig.vaultRoomId);
            return { type: 'staff', roomId: orgConfig.vaultRoomId };
        } catch (e) {
            // Not a vault member — fall through to portal check
        }
    }

    // Look for portal rooms the user has been invited to / joined
    var rooms = await matrixClient.getJoinedRooms();
    for (var roomId of rooms) {
        var portalConfig = await matrixClient.getStateEvent(roomId, 'law.firm.portal.config', '');
        if (portalConfig) {
            return { type: 'client', roomId: roomId, config: portalConfig };
        }
    }

    return { type: 'none' };  // No access — show "Contact your administrator"
}
```

### Component 7: Authentication Consolidation

Already designed in `SYNAPSE_LOGIN_ENCRYPTION_DESIGN.md`. Key change: the API key is no longer needed at all. Synapse access tokens replace it.

```
Before:  API_KEY → authenticates to Xano
After:   Matrix access_token → authenticates to Synapse (already implemented)
```

### Component 8: Box Backup Adaptation

`BoxSync.push()` serializes IndexedDB to `.amo` and uploads via n8n. This stays unchanged — the data is still in IndexedDB regardless of where it came from.

With Synapse as source of truth, Box backups are no longer critical for data safety (Synapse's PostgreSQL handles durability), but they're still useful for offline/air-gapped scenarios. Keep as optional.

---

## Migration Phases

### Phase 0: Preparation (No User-Facing Changes)

- [ ] Create the vault room on Synapse
- [ ] Write `law.firm.vault.config` state event with portal/visibility settings
- [ ] Write `law.firm.org.config` state event to org space with vault room ID
- [ ] Write `law.firm.schema.table` state events for each Airtable table
- [ ] Write `law.firm.schema.field` state events for each field
- [ ] Invite all staff users to the vault room
- [ ] Create a bridge bot user (`@bridge:app.aminoimmigration.com`)

### Phase 1: Dual-Write Bridge

Run Airtable changes through **both** Xano and Synapse simultaneously.

- [ ] Build the Airtable→Synapse bridge (n8n workflow writing to vault room)
- [ ] Bridge writes `law.firm.record.mutate` events for every Airtable change
- [ ] Bridge updates schema state events when tables/fields change
- [ ] Verify event parity: same data arrives in both Xano and vault room
- [ ] One-time backfill: replay all historical Xano events into the vault room
- [ ] Duration: run dual-write for 2-4 weeks to build confidence

### Phase 2: SPA Reads from Vault (Xano as Fallback)

- [ ] Implement `VaultSyncLoop` in index.html
- [ ] Implement vault room discovery via `law.firm.org.config`
- [ ] Wire `processSync()` into existing IndexedDB write path
- [ ] Add feature flag: `syncSource: 'xano' | 'synapse'`
- [ ] Default to Synapse, fallback to Xano in settings
- [ ] Replace `postEvent()` with vault room event sends
- [ ] Test: full sync from empty, incremental sync, write-back
- [ ] Verify data parity between Xano-sourced and vault-sourced IndexedDB

### Phase 3: Portal Rooms for Users

- [ ] Build portal fan-out worker (listens to vault, writes to portal rooms)
- [ ] Create portal rooms for each client
- [ ] Write `law.firm.portal.config` state events
- [ ] Implement `resolveDataRoom()` in SPA for staff vs. client detection
- [ ] Invite client users to their portal rooms
- [ ] Test: client logs in, sees only their data

### Phase 4: Consolidate Authentication

- [ ] Implement Synapse-unified login flow (from `SYNAPSE_LOGIN_ENCRYPTION_DESIGN.md`)
- [ ] Remove API key input/storage
- [ ] Remove `_EP` endpoint array and `initSecureEndpoints()`
- [ ] Single login screen: Matrix username + password → everything derived

### Phase 5: Remove Xano

- [ ] Remove `fetchPage()` and Xano pagination logic
- [ ] Remove `XANO_POST_API` and Xano POST logic
- [ ] Remove `API_KEY` variable and all references
- [ ] Remove the Xano endpoint base64 array (`_EP[0]`, `_EP[1]`)
- [ ] Remove `SyncHistory` polling class (replaced by `VaultSyncLoop`)
- [ ] Stop the Airtable→Xano webhook/ingestion
- [ ] Archive or decommission the Xano workspace

### Phase 6: Post-Migration Enhancements

- [ ] **Real-time collaboration**: Staff see changes instantly via `/sync` (sub-second vs 15s polling)
- [ ] **User self-service**: Clients check their own case status via portal room
- [ ] **Offline-first**: Matrix handles event ordering across offline/online transitions
- [ ] **Audit trail**: Immutable Matrix events = full history of every change with attribution
- [ ] **E2EE**: End-to-end encrypt the vault room for zero-knowledge hosting
- [ ] **Federation**: Optionally federate with client-owned Matrix servers

---

## Risk Analysis

| Risk | Impact | Mitigation |
|------|--------|-----------|
| **Matrix /sync slower than Xano for bulk initial sync** | First load could be slow | Snapshot state events for fast bootstrap; IndexedDB caching |
| **Vault room timeline grows unbounded** | PostgreSQL disk usage grows | Synapse purge history admin API for old events; data materialized in IndexedDB |
| **Rate limits on Matrix API** | Bridge throttled during high-volume changes | Use Application Service (exempt) or configure Synapse rate limits for local users |
| **Bridge downtime = missed Airtable changes** | Data gap | Bridge maintains cursor; replays from last position on restart |
| **Single vault room = single point of failure** | If room corrupts, all data affected | Synapse replication / backups; Box snapshots as secondary backup |
| **Portal fan-out lag** | Client sees stale data | Worker processes events near-real-time; acceptable latency for client-facing use |
| **Event size limits (~65KB)** | Large records may not fit | Store blobs in Matrix media repo (`mxc://` URIs); reference from events |

---

## Performance Considerations

### Initial Sync (Cold Start)

**Current (Xano):** Paginate through `/aminostream?page=1,2,...`. ~100 events/page. 50,000 events = 500 requests.

**Proposed (Synapse):** Two options:

1. **Vault room `/messages` pagination:** Single room, paginate forwards from start. Same number of requests but one stream instead of interleaved table queries.

2. **Snapshot state event (recommended for large datasets):** The bridge periodically writes a materialized snapshot as a state event. On cold start, SPA reads snapshot (one request), then syncs incrementally.

```json
{
  "type": "law.firm.snapshot",
  "state_key": "chunk:0",
  "content": {
    "cursor": "$lastEventIdAtSnapshot",
    "tables": {
      "tblClients": {
        "recABC": { "fldName": "Jane", "fldEmail": "jane@example.com" },
        "recDEF": { "fldName": "John", "fldEmail": "john@example.com" }
      }
    },
    "generatedAt": 1705316000000
  }
}
```

For large datasets, chunk across multiple state keys (`chunk:0`, `chunk:1`, etc.) to stay under the ~65KB state event size limit.

### Incremental Sync (Warm)

**Current:** Poll every 15 seconds.

**Proposed:** Long-poll `/sync?since=token&timeout=30000`. Sub-second latency, zero wasted requests.

### Write Path

**Current:** POST to Xano — one HTTP request.
**Proposed:** PUT to Synapse vault room — one HTTP request. Same cost.

---

## Code Changes Summary

### Functions Removed

```
fetchPage()              → replaced by VaultSyncLoop.processSync()
incrementalSync()        → replaced by VaultSyncLoop.start()
postEvent()              → replaced by postRecordMutation() via matrixClient
SyncHistory class        → replaced by VaultSyncLoop class
initSecureEndpoints()    → removed (no Xano URLs to manage)
_EP array                → removed
API_KEY variable         → removed
initAuthScreen()         → merged into Synapse login flow
```

### Functions Modified

```
openDB()                 → sync store: lastEventTimestamp → matrixSyncToken
processEvent()           → adapt to Matrix event shape (content.op, content.tableId)
```

### Functions Added

```
VaultSyncLoop            → new class replacing SyncHistory
resolveDataRoom()        → detects staff (vault) vs client (portal)
postRecordMutation()     → writes law.firm.record.mutate to vault room
readSnapshotState()      → reads law.firm.snapshot for fast cold start
```

### Functions Unchanged

```
BoxSync.push/pull        → reads/writes IndexedDB (format-agnostic)
encryptForStorage()      → same encryption, different key derivation
MatrixClient             → already supports all needed operations
All rendering logic      → unchanged, reads from IndexedDB
```

---

## Open Questions

1. **Airtable ingestion method.** Does the current Xano backend receive Airtable webhooks or poll the API? The bridge needs the same approach.

2. **Synapse hosting.** Is `app.aminoimmigration.com` self-hosted or managed? Becomes critical when it's the sole source of truth — need robust backups.

3. **Historical backfill.** How many events in Xano today? Need a one-time replay into the vault room before cutover.

4. **Multi-tenancy.** One Synapse server per firm, or shared with separate org spaces? Vault room isolation is strong, but separate servers are stronger.

5. **Client portal UX.** Do clients use the same SPA, or a separate lighter app? The SPA can detect portal vs. vault and adjust its UI, but a dedicated client view might be cleaner.

6. **Snapshot frequency.** How often should the bridge write snapshot state events? Every N events? Daily? Driven by cold-start performance requirements.

---

## Summary

| Before | After |
|--------|-------|
| Xano = source of truth | Synapse vault room = source of truth |
| SPA polls Xano every 15s | SPA long-polls Synapse `/sync` (sub-second) |
| API key auth | Matrix access token auth |
| No client access | Portal rooms with filtered data per-user |
| Optional Synapse bridge | Synapse is the primary (and only) backend |
| 3 credentials | 1 credential (Synapse password) |

**Estimated scope:**
- Bridge service (n8n workflow): ~1-2 days
- Portal fan-out worker: ~2-3 days
- SPA sync rewrite (`VaultSyncLoop`): ~3-5 days
- Auth consolidation: aligned with `SYNAPSE_LOGIN_ENCRYPTION_DESIGN.md` (~2 days)
- Xano removal: ~1 day (delete code)
- Testing & dual-write period: 2-4 weeks

The phased approach (dual-write → vault sync → portal rooms → auth consolidation → Xano removal) ensures zero data loss and rollback at every stage.
