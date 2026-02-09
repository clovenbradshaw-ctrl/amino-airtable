# Synapse as Source of Truth

## Architecture

```
Synapse (room-per-table)  ──/sync──▸  SPA (IndexedDB)
                          ◂──send──   SPA (writes)
```

No Xano. No polling. Synapse is the only backend.

Data arrives in two stages:
1. **Hydration** — on first load, pull full state from Synapse rooms into IndexedDB
2. **Event stream** — after hydration, long-poll `/sync` for real-time mutations

---

## Room Structure

Each Airtable table is its own Matrix room inside the org space.

```
Org Space (!orgSpaceId)
│
├── State: law.firm.org.config          (org metadata, view preferences)
│
├── Table Room: "Clients" (!roomClients)
│   ├── State: law.firm.schema.table                    (table metadata)
│   ├── State: law.firm.schema.field/fldName             (field def)
│   ├── State: law.firm.schema.field/fldEmail            (field def)
│   ├── State: law.firm.schema.field/fldStatus           (field def)
│   ├── Timeline: law.firm.record.mutate                 (INS recABC)
│   ├── Timeline: law.firm.record.mutate                 (ALT recABC)
│   └── ...
│
├── Table Room: "Matters" (!roomMatters)
│   ├── State: law.firm.schema.table
│   ├── State: law.firm.schema.field/fldTitle
│   ├── State: law.firm.schema.field/fldClient
│   ├── Timeline: law.firm.record.mutate
│   └── ...
│
├── Table Room: "Notes" (!roomNotes)
│   └── ...
│
└── Portal Room: "Jane Doe" (!portalJane)    ← future: per-user access
    └── ...
```

### Why Room-per-Table

- Table rooms map 1:1 to Airtable tables — clean mental model
- Room membership = table-level access control when needed
- Each room has its own timeline — no cross-table noise
- Schema (state events) and data (timeline events) live together per table
- Portal rooms can later pull filtered subsets from specific table rooms

---

## User Journey

```
App opens
  │
  ├── Check for Synapse session
  │   ├── Valid session → skip to view selection
  │   └── No session → show Synapse login screen
  │
  ├── Synapse Login
  │   ├── Username + password
  │   ├── Authenticate with homeserver
  │   ├── Derive encryption key from password (per SYNAPSE_LOGIN_ENCRYPTION_DESIGN.md)
  │   └── Save session
  │
  └── View Selection
      │
      ├── "View as Database"    → current table/grid UI (what exists today)
      │   └── Full table browser, field history, sorting, filtering
      │
      └── "View as Interface"   → new interface view (to be developed)
          └── Custom layouts, dashboards, client-facing views, forms
```

Both views read from the same IndexedDB. The view selection is a UI concern, not a data concern.

### View Selection Storage

```json
{
  "type": "law.firm.org.config",
  "state_key": "",
  "content": {
    "orgName": "Immigration Firm",
    "defaultView": "database",
    "interfaces": []
  }
}
```

Per-user preference stored in Matrix account data:

```javascript
await matrixClient.setAccountData('law.firm.user_preferences', {
    preferredView: 'database'  // or 'interface'
});
```

---

## Data Flow

### Stage 1: Hydration (Cold Start)

On first load or empty IndexedDB, pull everything from Synapse:

```
For each table room the user has joined:
  1. Read state events → populate tables + fields stores in IndexedDB
  2. Paginate timeline via /messages (forwards from room start) → process all record mutations
  3. Materialize current record state into IndexedDB data store
  4. Save sync token for incremental updates
```

```javascript
async function hydrate(matrixClient, tableRooms) {
    for (var { roomId, tableId } of tableRooms) {
        // 1. Read schema from room state
        var state = await matrixClient.getState(roomId);
        for (var event of state) {
            if (event.type === 'law.firm.schema.table') {
                await saveTableMetadata(event.content);
            } else if (event.type === 'law.firm.schema.field') {
                await saveFieldMetadata(tableId, event.content);
            }
        }

        // 2. Paginate full timeline
        var from = null;
        while (true) {
            var batch = await matrixClient.messages(roomId, {
                dir: 'f',
                from: from,
                limit: 100,
                filter: JSON.stringify({
                    types: ['law.firm.record.mutate']
                })
            });

            for (var event of batch.chunk) {
                await processRecordMutation(event.content, event.event_id, event.origin_server_ts);
            }

            if (!batch.end || batch.chunk.length === 0) break;
            from = batch.end;
        }
    }

    // 3. Save sync position for incremental updates
    var syncResponse = await matrixClient.sync({ timeout: 0 });
    await saveSyncToken(syncResponse.next_batch);
}
```

**Optimization: Snapshot state events**

For large tables, the bridge can periodically write a materialized snapshot as a state event to avoid replaying the entire timeline:

```json
{
  "type": "law.firm.snapshot",
  "state_key": "chunk:0",
  "content": {
    "cursor": "$lastEventIdAtSnapshot",
    "records": {
      "recABC": { "fldName": "Jane", "fldEmail": "jane@example.com" },
      "recDEF": { "fldName": "John", "fldEmail": "john@example.com" }
    },
    "generatedAt": 1705316000000
  }
}
```

If a snapshot exists, hydration reads the snapshot first, then replays only events after the snapshot cursor.

### Stage 2: Event Stream (Warm)

After hydration, long-poll `/sync` for real-time updates:

```javascript
class SynapseSync {
    constructor(matrixClient, tableRooms) {
        this.client = matrixClient;
        this.roomIds = tableRooms.map(r => r.roomId);
        this.roomToTable = Object.fromEntries(tableRooms.map(r => [r.roomId, r.tableId]));
        this.since = loadSyncToken();
        this.running = false;
    }

    async start() {
        this.running = true;

        while (this.running) {
            try {
                var response = await this.client.sync({
                    since: this.since,
                    timeout: 30000,
                    filter: {
                        room: {
                            rooms: this.roomIds,
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
                await backoffRetry(err);
            }
        }
    }

    async processSync(response) {
        for (var [roomId, roomData] of Object.entries(response.rooms?.join || {})) {
            var tableId = this.roomToTable[roomId];

            // Schema changes
            for (var event of roomData.state?.events || []) {
                if (event.type === 'law.firm.schema.table') {
                    await saveTableMetadata(event.content);
                } else if (event.type === 'law.firm.schema.field') {
                    await saveFieldMetadata(tableId, event.content);
                }
            }

            // Record mutations
            for (var event of roomData.timeline?.events || []) {
                if (event.type === 'law.firm.record.mutate') {
                    await processRecordMutation(event.content, event.event_id, event.origin_server_ts);
                }
            }
        }
    }
}
```

---

## Event Schemas

### Record Mutation: `law.firm.record.mutate`

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

- `op`: `"INS"` (insert), `"ALT"` (alter — only changed fields), `"NUL"` (nullify — fields set to `null`)
- `source`: `"airtable"` (from bridge), `"app"` (from SPA), `"migration"` (backfill)
- `recordId`: Airtable record ID
- `fields`: key-value pairs of fieldId → value. For NUL, values are `null`.

No `tableId` in the event — the table is implicit from which room the event is in.

### Schema: `law.firm.schema.table`

State key: `""` (one per room)

```json
{
  "type": "law.firm.schema.table",
  "state_key": "",
  "content": {
    "tableId": "tblClients",
    "name": "Clients",
    "description": "Client contact information"
  }
}
```

### Schema: `law.firm.schema.field`

State key: fieldId

```json
{
  "type": "law.firm.schema.field",
  "state_key": "fldName",
  "content": {
    "fieldId": "fldName",
    "name": "Full Name",
    "type": "singleLineText",
    "options": {}
  }
}
```

---

## Table Room Discovery

On login, the SPA discovers which table rooms exist via org space state:

```json
{
  "type": "law.firm.org.config",
  "state_key": "",
  "content": {
    "orgName": "Immigration Firm",
    "defaultView": "database",
    "tables": {
      "tblClients": { "roomId": "!abc:app.aminoimmigration.com", "name": "Clients" },
      "tblMatters": { "roomId": "!def:app.aminoimmigration.com", "name": "Matters" },
      "tblNotes":   { "roomId": "!ghi:app.aminoimmigration.com", "name": "Notes" }
    }
  }
}
```

```javascript
async function discoverTableRooms(matrixClient, orgSpaceId) {
    var config = await matrixClient.getStateEvent(orgSpaceId, 'law.firm.org.config', '');
    var tableRooms = [];

    for (var [tableId, info] of Object.entries(config.tables)) {
        // Join room if not already joined
        await matrixClient.joinRoom(info.roomId);
        tableRooms.push({ tableId, roomId: info.roomId, name: info.name });
    }

    return tableRooms;
}
```

---

## Write Path

```javascript
async function writeRecord(matrixClient, tableRoomId, recordId, op, fields) {
    var txnId = 'm' + Date.now() + '.' + Math.random().toString(36).slice(2);

    await matrixClient.sendEvent(tableRoomId, 'law.firm.record.mutate', {
        recordId: recordId,
        op: op,
        fields: fields,
        source: 'app',
        sourceTimestamp: Date.now()
    }, txnId);
}
```

---

## Boot Sequence

```javascript
async function boot() {
    // 1. Synapse login (mandatory)
    var session = await requireSynapseLogin();
    var matrixClient = new MatrixClient(session);

    // 2. Derive encryption key from Synapse password
    var encryptionKey = await deriveEncryptionFromSession(session);

    // 3. Discover table rooms from org space
    var tableRooms = await discoverTableRooms(matrixClient, ORG_SPACE_ID);

    // 4. Check local state
    var needsHydration = await isIndexedDBEmpty();

    if (needsHydration) {
        // Stage 1: Full hydration from Synapse rooms
        showHydrationProgress();
        await hydrate(matrixClient, tableRooms);
    }

    // 5. Start event stream (Stage 2)
    var sync = new SynapseSync(matrixClient, tableRooms);
    sync.start();  // runs in background

    // 6. Show view selection
    var preference = await matrixClient.getAccountData('law.firm.user_preferences');
    if (preference?.preferredView === 'interface') {
        showInterfaceView();
    } else {
        showDatabaseView();  // current grid UI
    }
}
```

---

## What Gets Removed from index.html

```
fetchPage()              — Xano pagination
incrementalSync()        — Xano polling loop
postEvent()              — Xano POST
SyncHistory class        — Xano poll timer
initSecureEndpoints()    — Xano URL decryption
_EP[] array              — Xano endpoint URLs (base64)
API_KEY                  — Xano auth
XANO_POST_API            — Xano POST URL
initAuthScreen()         — API key input screen
```

## What Gets Added

```
SynapseSync class        — /sync long-poll loop
hydrate()                — full room timeline replay into IndexedDB
discoverTableRooms()     — org space config → table room mapping
writeRecord()            — send events to table rooms
resolveDataRoom()        — staff (table rooms) vs client (portal room)
boot()                   — new entry point: login → hydrate → sync → view
View selection UI        — database vs interface toggle
```

## What Stays the Same

```
IndexedDB schema         — tables, fields, data, events, fieldHistory stores
All rendering logic      — reads from IndexedDB, unchanged
encryptForStorage()      — same primitives, key derived from Synapse password
BoxSync                  — reads/writes IndexedDB, format-agnostic
MatrixClient             — already supports login, send, state, sync
processRecordMutation()  — same INS/ALT/NUL logic, slightly adapted input shape
```

---

## Interface View (Future)

The "View as Interface" option opens a new UI layer on top of the same IndexedDB data. This is a separate design effort, but the data model supports it:

- Interfaces are stored as Matrix state events: `law.firm.interface/{interfaceId}`
- Each interface defines layout, visible tables/fields, filters, grouping
- Clients could get interface-only access via portal rooms (no raw database view)

```json
{
  "type": "law.firm.interface",
  "state_key": "intake-dashboard",
  "content": {
    "name": "Intake Dashboard",
    "layout": "kanban",
    "table": "tblClients",
    "groupByField": "fldStatus",
    "visibleFields": ["fldName", "fldEmail", "fldStatus", "fldCreatedDate"],
    "filters": [],
    "permissions": "staff"
  }
}
```

This is where the "view as interface" capability will be built out.
