# Amino Data Sync — Formal Specification

> **Status:** Living document — describes the intended design, current implementation state, known gaps, and path to Airtable-independent operation.
>
> **Last updated:** 2026-02-13

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Architecture](#2-architecture)
3. [Modules & Responsibilities](#3-modules--responsibilities)
4. [Hydration (Initial Data Load)](#4-hydration-initial-data-load)
5. [Continuing Sync (Incremental Updates)](#5-continuing-sync-incremental-updates)
6. [Outbound Writes (Client → Server)](#6-outbound-writes-client--server)
7. [Deduplication & Echo Suppression](#7-deduplication--echo-suppression)
8. [Offline Support & Mutation Queue](#8-offline-support--mutation-queue)
9. [Encryption at Rest](#9-encryption-at-rest)
10. [Event Schema & Field Operations](#10-event-schema--field-operations)
11. [Sync State Machine (Intended)](#11-sync-state-machine-intended)
12. [Gap Analysis & Bug Audit](#12-gap-analysis--bug-audit)
13. [Distance from "Perfect Sync"](#13-distance-from-perfect-sync)
14. [Airtable Decoupling Roadmap](#14-airtable-decoupling-roadmap)

---

## 1. System Overview

Amino is a distributed, encrypted, offline-capable client for immigration case management data. It keeps a local mirror of all records in IndexedDB, encrypted at rest with AES-GCM-256, and synchronizes with a server-side PostgreSQL state database (`amino.current_state`) that is currently fed by Airtable.

**Design goals:**

- Airtable is the **current** source of truth but the system is designed to eventually cut loose from it entirely.
- The client reads exclusively from its **local IndexedDB** — never from the network at render time.
- Network calls exist only to **backfill and keep the local mirror current**.
- All data in transit flows through either **n8n webhook APIs** or **Matrix real-time events**.
- End-to-end encryption ensures data is unreadable at rest on the device and (optionally) in Matrix event payloads.

**Key invariant:** The client should never make a network call to serve a user-initiated read. All reads are local. The network is only for writes and sync.

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        EXTERNAL SOURCES                             │
│                                                                     │
│   Airtable ──(periodic import)──▶ n8n Workflows                    │
│                                       │                             │
│                                       ▼                             │
│                              ┌─────────────────┐                    │
│                              │   PostgreSQL     │                    │
│                              │ amino.current_   │                    │
│                              │    state         │                    │
│                              └────────┬────────┘                    │
│                                       │                             │
│              ┌────────────────────────┼──────────────────────┐      │
│              │                        │                      │      │
│              ▼                        ▼                      ▼      │
│    ┌──────────────────┐   ┌───────────────────┐   ┌──────────────┐ │
│    │  Box Bulk Export  │   │  n8n HTTP APIs    │   │ Matrix Events│ │
│    │  (box-download)   │   │  /amino-records   │   │ (Synapse)    │ │
│    │                   │   │  /amino-records-  │   │              │ │
│    │                   │   │   since           │   │              │ │
│    └────────┬─────────┘   └────────┬──────────┘   └──────┬───────┘ │
│             │                      │                     │          │
└─────────────┼──────────────────────┼─────────────────────┼──────────┘
              │                      │                     │
              ▼                      ▼                     ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         CLIENT (Browser)                            │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                    data-layer.js                              │   │
│  │  ┌────────────┐  ┌──────────────┐  ┌──────────────────────┐  │   │
│  │  │ Hydration   │  │ Matrix Sync  │  │ HTTP Polling         │  │   │
│  │  │ (one-time)  │  │ (real-time)  │  │ (fallback, 15s)      │  │   │
│  │  └──────┬─────┘  └──────┬───────┘  └──────────┬───────────┘  │   │
│  │         │               │                     │               │   │
│  │         ▼               ▼                     ▼               │   │
│  │  ┌───────────────────────────────────────────────────────┐    │   │
│  │  │          prepareEncryptedRecords()                     │    │   │
│  │  │     AES-GCM-256 encrypt → IndexedDB batch write       │    │   │
│  │  └──────────────────────┬────────────────────────────────┘    │   │
│  │                         │                                     │   │
│  │                         ▼                                     │   │
│  │  ┌───────────────────────────────────────────────────────┐    │   │
│  │  │  IndexedDB (amino-data-layer)                          │    │   │
│  │  │  ├── records     (id, tableId, fields [encrypted])     │    │   │
│  │  │  ├── tables      (table metadata cache)                │    │   │
│  │  │  ├── sync        (per-table lastSynced cursor)         │    │   │
│  │  │  ├── crypto      (salt, verification token)            │    │   │
│  │  │  └── pending_mutations (offline write queue)           │    │   │
│  │  └──────────────────────┬────────────────────────────────┘    │   │
│  │                         │                                     │   │
│  │                         ▼                                     │   │
│  │  ┌───────────────────────────────────────────────────────┐    │   │
│  │  │  In-Memory Cache                                       │    │   │
│  │  │  _recordCacheById    (decrypted records)               │    │   │
│  │  │  _tableRecordIdIndex (table → record ID sets)          │    │   │
│  │  │  _searchIndex        (recordId → searchable text)      │    │   │
│  │  └───────────────────────────────────────────────────────┘    │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌──────────────────────┐  ┌───────────────────────────────────┐   │
│  │  matrix.js            │  │  index.html (UI layer)            │   │
│  │  Matrix CS API client │  │  Renders from cache, listens for  │   │
│  │  Room join, event TX  │  │  amino:sync / amino:record-update │   │
│  └──────────────────────┘  └───────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 3. Modules & Responsibilities

### 3.1 `data-layer.js` (3,385 lines) — Core sync & persistence engine

The single most critical module. Owns all of: encryption, IndexedDB access, hydration, polling, Matrix sync loop, caching, search index, offline mutation queue, and the public API surface.

| Category | Key Functions | Lines (approx) |
|---|---|---|
| **Initialization** | `init()`, `initWithKey()`, `initAndHydrate()`, `restoreSession()` | 2200–2420 |
| **Hydration** | `hydrateFromBoxDownload()`, `hydrateTable()`, `hydrateAll()`, `hydrateAllFromPostgres()`, `rebuildTableFromRoom()` | 1039–2374 |
| **Sync (HTTP)** | `syncTable()`, `startPolling()`, `stopPolling()`, `apiFetch()` | 470–2073 |
| **Sync (Matrix)** | `startMatrixSync()`, `_runSyncLoop()`, `stopMatrixSync()`, `processMatrixSyncResponse()` | 1593–1680 |
| **Event Processing** | `applyMutateEvent()`, `normalizeFieldOps()` | 1374–1543 |
| **Encryption** | `deriveKey()`, `encrypt()`, `decrypt()`, `deriveSynapseKey()` | 73–300 |
| **Caching** | `cacheRecord()`, `cacheFullTable()`, `clearRecordCache()`, `clearTableCache()` | 700–780 |
| **Search** | `_buildSearchText()`, `searchRecords()`, `searchRecordsFast()` | 782–2157 |
| **Data Access** | `getTableRecords()`, `getRecord()`, `getTableRecordsCached()` | 2077–2185 |
| **Airtable Trigger** | `triggerAirtableSync()`, `getAirtableSyncStatus()` | 1949–2004 |
| **Offline** | `queueOfflineMutation()`, `flushPendingMutations()`, `offlineUnlock()` | 2830–3233 |
| **Deduplication** | `_markEventProcessed()`, `_isOptimisticEcho()`, `_pruneOptimisticWrites()` | 390–466 |

### 3.2 `matrix.js` (1,778 lines) — Matrix Client-Server API

Direct HTTP wrapper for the Matrix CS API. No SDK dependency.

| Responsibility | Details |
|---|---|
| Authentication | `login()`, `logout()`, `/whoami` validation |
| Room management | `joinRoom()`, room timeline pagination |
| Event I/O | `sendStateEvent()` for outbound writes, event extraction from `/sync` |
| Rate limiting | Request queue serialization, 429 backoff |
| Custom event types | `law.firm.record.mutate`, `law.firm.schema.object`, `law.firm.view.delete` |

### 3.3 `index.html` (33,397 lines) — UI layer & edit orchestration

The monolithic SPA. Relevant sync surface area:

| Area | What it does |
|---|---|
| `editRecord()` | Orchestrates outbound writes: optimistic cache update → POST to `/write` webhook → Matrix event |
| `amino:sync` listener | Triggers `renderTable()` when sync delivers new data |
| `amino:record-updated` listener | Targeted cell DOM updates for single-record changes |
| `renderTable()` | Full table rebuild from in-memory cache — the only read path |
| Filter/sort pipeline | `getFilteredSortedRecords()` — operates on cached data, never network |

### 3.4 `n8n-nodes/` — Webhook API definitions & utilities

| File | Purpose |
|---|---|
| `webhook-workflow.json` | n8n workflow definition for all `/amino-*` endpoints |
| `getRecordCurrentState.js` | SQL helper to read latest field values from `amino.current_state` |
| `getRecordCurrentStateFlat.js` | Same, flat key-value output |
| `getRecordCurrentStateComplete.js` | Same, with full metadata (last_write_source, timestamps) |

### 3.5 `migrations/` — PostgreSQL schema

| Migration | What it creates |
|---|---|
| `001_create_table_registry.sql` | `amino.table_registry` — table ↔ Matrix room mapping |
| `002_add_field_registry_options.sql` | `amino.field_registry` — field definitions, formula/rollup/lookup metadata |
| `003_add_last_write_source.sql` | `amino.current_state.last_write_source` column — tracks `'client'` vs `'airtable_sync'` origin |

### 3.6 `sw.js` — Service worker

Caches the app shell (HTML, JS, CSS) for offline-first startup. Network-first for API/Matrix calls, cache-first for static assets.

### 3.7 `src/formulas/` — Formula engine

Not directly part of sync, but **sync events trigger formula re-evaluation** via `renderTable()` → `_applyFormulaColumns()`. Computed fields (formulas, rollups, lookups) are evaluated client-side from synced field data — they are not synced as stored values.

---

## 4. Hydration (Initial Data Load)

Hydration is the process of populating the local IndexedDB when it's empty (first login, data wipe, or re-login after logout). It uses a tiered fallback strategy.

### 4.1 Tiered Fallback

```
initAndHydrate()
  │
  ├─ init()
  │   ├─ Derive encryption key from Synapse password
  │   ├─ Open IndexedDB (amino-data-layer, version 2)
  │   ├─ Fetch table metadata via /amino-tables
  │   ├─ Build table ↔ room map
  │   └─ Join Matrix rooms for each table
  │
  ├─ hydrateAll()
  │   │
  │   ├─ Tier 1: hydrateFromBoxDownload()         ◄── PREFERRED
  │   │   POST https://n8n.intelechia.com/webhook/box-download
  │   │   • Bulk download of all ~70k records in one request
  │   │   • Response: { records: [...] } or { tables: { tableId: [...] } }
  │   │   • Clears existing table records before insert
  │   │   • Writes in 200-record batches via prepareEncryptedRecords()
  │   │   • On success → done, skip remaining tiers
  │   │
  │   ├─ Tier 2: hydrateAllFromPostgres()          ◄── FALLBACK
  │   │   For each table:
  │   │     POST /amino-records?tableId=X
  │   │     • Fetches full record set from amino.current_state
  │   │     • Same encrypt + batch-write pipeline
  │   │   On per-table failure → Tier 3 for that table
  │   │
  │   └─ Tier 3: rebuildTableFromRoom(tableId)     ◄── LAST RESORT
  │       • Paginates the Matrix room's /messages timeline
  │       • Reconstructs current state by replaying all
  │         law.firm.record.mutate events in order (ALT/INS/NUL)
  │       • Used only when the HTTP API is unreachable
  │
  ├─ startMatrixSync()     (if Matrix is available)
  └─ startPolling()        (if Matrix sync fails to start)
```

### 4.2 Record Processing Pipeline (shared across all tiers)

```
Raw API record
  │
  ├─ Normalize: extract { id, tableId, tableName, fields }
  ├─ Validate: require id, tableId, fields
  ├─ Encrypt: AES-GCM-256(JSON.stringify(fields), _cryptoKey)
  │   └─ 12-byte random IV prepended to ciphertext
  ├─ Write to IndexedDB: { id, tableId, tableName, fields: ArrayBuffer, lastSynced }
  ├─ Cache in memory: _recordCacheById[id] = { ...record, fields: plaintext_obj }
  ├─ Index: _tableRecordIdIndex[tableId][id] = true
  └─ Update sync cursor: sync store { tableId, lastSynced: now }
```

### 4.3 Hydration Configuration

| Constant | Value | Purpose |
|---|---|---|
| `BOX_DOWNLOAD_WEBHOOK` | `https://n8n.intelechia.com/webhook/box-download` | Tier 1 endpoint |
| `WEBHOOK_BASE_URL` | `https://n8n.intelechia.com/webhook` | Base for Tiers 2/3 |
| Batch size | 200 records | IDB write batch size |
| Encryption | AES-GCM-256 | At-rest encryption in IDB |

---

## 5. Continuing Sync (Incremental Updates)

After hydration, two channels keep the local mirror current. They can run simultaneously, with deduplication preventing double-application.

### 5.1 Channel A: Matrix Real-Time Sync (Primary)

**Entry point:** `startMatrixSync()` → `_runSyncLoop()`

```
_runSyncLoop():
  │
  ├─ Build filter: only table rooms, only law.firm.record.mutate
  │   and law.firm.schema.object events, limit 100 per batch
  │
  └─ LOOP (while _matrixSyncRunning):
      │
      ├─ GET /_matrix/client/v3/sync?filter=...&since=TOKEN&timeout=30000
      │
      ├─ On 429 (rate limited):
      │   └─ Wait retry_after_ms (default 5s), continue loop
      │
      ├─ On success:
      │   ├─ Update syncToken = data.next_batch
      │   ├─ processMatrixSyncResponse(data):
      │   │   For each room in rooms.join:
      │   │     For each timeline event:
      │   │       applyMutateEvent(event, roomId)    ◄── see §5.3
      │   └─ If any updates: emit amino:sync event
      │
      ├─ On network error:
      │   └─ Wait 5s, continue loop
      │
      └─ On AbortError (stopMatrixSync called):
          └─ Break loop
```

**Characteristics:**
- Long-poll, 30-second timeout per request
- Near-real-time latency (~1-2s for new events)
- Uses Matrix sync token for exactly-once cursor semantics
- Scoped filter prevents processing irrelevant room events

### 5.2 Channel B: HTTP Polling (Fallback)

**Entry point:** `startPolling()` → setInterval at `DEFAULT_POLL_INTERVAL` (15s)

```
startPolling():
  │
  └─ Every 15 seconds (paused when tab hidden):
      │
      For each table in _tableIds:
      │
      ├─ syncTable(tableId):
      │   │
      │   ├─ Read lastSynced cursor from IndexedDB sync store
      │   │
      │   ├─ If cursor exists:
      │   │   POST /amino-records-since?tableId=X&since=CURSOR
      │   │   → Returns only records modified after cursor
      │   │
      │   ├─ If no cursor:
      │   │   hydrateTable(tableId)   (full table re-fetch)
      │   │
      │   ├─ prepareEncryptedRecords() → batch write to IDB
      │   ├─ Update sync cursor to now
      │   └─ Return count of updated records
      │
      └─ If any table had updates: emit amino:sync
```

**Characteristics:**
- 15-second fixed interval (not configurable at runtime)
- Pauses automatically on `visibilitychange` (tab hidden)
- Resumes on tab focus
- Per-table sequential processing
- Higher latency than Matrix (up to 15s delay)

### 5.3 Event Application (`applyMutateEvent`)

This is the core function that applies a single mutation to a local record, used by both sync channels.

```
applyMutateEvent(event, roomId):
  │
  ├─ DEDUP: Check _processedEventIds[event_id]
  │   └─ If already seen → return (skip)
  │
  ├─ FILTER: Skip metadata events (table/field/view/viewConfig/tableSettings)
  │
  ├─ DECRYPT: If event payload is encrypted:
  │   ├─ Try decryptEventPayload(content)
  │   └─ On failure → console.warn, return (skip silently)
  │
  ├─ RESOLVE TABLE: tableId from _roomTableMap[roomId] or content.set
  │
  ├─ READ EXISTING: Get record from IndexedDB, decrypt fields
  │   └─ If not found → start with empty fields {}
  │
  ├─ NORMALIZE: normalizeFieldOps(content) → { ALT, INS, NUL }
  │
  ├─ ECHO CHECK: _isOptimisticEcho(recordId, fieldOps)
  │   └─ If echo → emit amino:record-mutate (for history), return
  │
  ├─ MERGE:
  │   ├─ ALT fields: overwrite existing field values
  │   ├─ INS fields: insert new field values
  │   └─ NUL fields: delete field keys
  │
  ├─ WRITE: Encrypt merged fields → IndexedDB put
  │
  ├─ CACHE: Update _recordCacheById, _tableRecordIdIndex, _searchIndex
  │
  └─ EMIT:
      ├─ amino:record-update (table-level notification)
      └─ amino:record-mutate (detailed mutation for field history)
```

---

## 6. Outbound Writes (Client → Server)

### 6.1 Write Flow

```
User edits cell in UI
  │
  ├─ editRecord(recordId, fieldUpdates):
  │
  ├─ 1. OPTIMISTIC UPDATE:
  │   ├─ _trackOptimisticWrite(recordId, fieldUpdates)
  │   ├─ Update _recordCacheById immediately
  │   ├─ Update IndexedDB immediately
  │   └─ Emit amino:record-updated → UI re-renders cell
  │
  ├─ 2. SERVER WRITE (async, non-blocking):
  │   ├─ POST /write?tableId=X&recordId=Y
  │   │   Body: { access_token, recordId, fields: { fieldName: value } }
  │   │   n8n webhook → Airtable API update → Postgres update
  │   │   Postgres sets: last_write_source = 'client'
  │   │
  │   ├─ On success → done (sync echo will be suppressed by dedup)
  │   │
  │   └─ On failure:
  │       ├─ If offline → queueOfflineMutation()
  │       └─ If server error → retry or queue
  │
  └─ 3. MATRIX EVENT (optional, parallel):
      └─ Send law.firm.record.mutate event to table room
          Content: { recordId, tableId, op: 'ALT', fields: {...} }
```

### 6.2 Write Path Through the Stack

```
Client (index.html editRecord)
  → POST /write (n8n webhook)
    → n8n workflow validates auth, calls Airtable API
      → Airtable updates record
      → n8n updates amino.current_state (last_write_source = 'client')
      → n8n posts law.firm.record.mutate event to Matrix room
        → Matrix distributes to all syncing clients
          → Client receives via /sync, suppresses echo via _isOptimisticEcho
```

---

## 7. Deduplication & Echo Suppression

Two independent deduplication mechanisms prevent double-processing:

### 7.1 Event ID Deduplication

```javascript
_processedEventIds = {};           // event_id → timestamp
PROCESSED_EVENT_TTL  = 300000;     // 5-minute window
MAX_PROCESSED_EVENTS = 5000;       // prune threshold
```

Every event processed by `applyMutateEvent()` records its `event_id`. If the same event arrives via a different channel (Matrix sync + HTTP polling overlap), it's skipped.

**Pruning:** When the map exceeds 5000 entries, entries older than 5 minutes are purged.

### 7.2 Optimistic Write Echo Suppression

```javascript
_optimisticWrites = {};            // recordId → { fields, ts }
OPTIMISTIC_WRITE_TTL = 30000;      // 30-second window
```

When a client writes a field, the write is tracked. When the server echoes the same mutation back via `/sync`, `_isOptimisticEcho()` compares the incoming ALT fields against the tracked write. If all fields match (via `JSON.stringify` comparison), the redundant decrypt→merge→encrypt→write cycle is skipped.

---

## 8. Offline Support & Mutation Queue

### 8.1 Offline Detection

```
Three detection mechanisms:
  ├─ Browser 'offline' event
  ├─ Matrix sync loop network errors (not 429, not 401)
  └─ Periodic connectivity check (every 30s via checkConnectivity())
      └─ GET /_matrix/client/versions with 5-second timeout
```

### 8.2 Offline Mode Behavior

| Capability | Available? |
|---|---|
| Read cached records | Yes |
| Search cached records | Yes |
| View cached views | Yes |
| Edit records | Yes (queued locally) |
| Sync with server | No |
| Render formulas | Yes (from cached inputs) |

### 8.3 Offline Mutation Queue

```
IndexedDB store: pending_mutations
  Schema: { id, tableId, recordId, op, fields, timestamp, status }
  Indices: byTable, byStatus, byTimestamp

queueOfflineMutation():
  ├─ Store mutation in pending_mutations (status: 'pending')
  ├─ Apply to local IndexedDB immediately (optimistic)
  └─ Emit amino:offline-mutation-queued

flushPendingMutations() [called on reconnect]:
  ├─ Sort pending by timestamp (oldest first)
  ├─ For each: POST to /write endpoint
  │   ├─ Success → delete from queue
  │   └─ Failure → leave in queue, increment failed count
  └─ Emit amino:offline-mutations-flushed
```

### 8.4 Online/Offline Transition

```
Offline → Online:
  1. amino:connectivity-restored event fires
  2. Verify access token with /whoami
     ├─ Valid → flush pending mutations → resume sync
     └─ Invalid (401) → show login, then flush on re-auth
  3. Run incremental sync for all tables
  4. Resume Matrix sync loop
  5. Clear offline mode flag

Online → Offline:
  1. Stop Matrix sync loop
  2. Stop HTTP polling
  3. Set _offlineMode = true
  4. Start connectivity monitor
  5. Route all writes to pending_mutations queue
```

---

## 9. Encryption at Rest

### 9.1 Key Derivation

```
PBKDF2(
  password:   Synapse login password,
  salt:       "amino-local-encrypt:" + userId,
  iterations: 600,000  (OWASP 2023),
  hash:       SHA-256,
  output:     AES-GCM 256-bit key
)
```

The derived key is held **in memory only** during the session, and optionally in `sessionStorage` (survives page refresh, cleared on tab close). It is **never** written to persistent storage.

### 9.2 Record Encryption

```
encrypt(key, plaintext):
  iv = random 12 bytes
  ciphertext = AES-GCM(key, iv, plaintext)
  return iv || ciphertext    // concatenated ArrayBuffer

decrypt(key, data):
  iv = data[0..11]
  ciphertext = data[12..]
  return AES-GCM.decrypt(key, iv, ciphertext)
```

### 9.3 Deferred Encryption Mode

When `_deferEncryption = true`, records are stored as plaintext JSON strings in IndexedDB during the active session. On `logout()`, all records are encrypted in a batch pass before the session ends. This trades security-at-rest during the session for faster write performance.

### 9.4 Verification Token

A known plaintext (`'amino-encryption-verify'`) encrypted with the derived key is stored in the `crypto` store. This enables:
- **Password verification without the server** (offline unlock)
- **Password change detection** (re-login with new password produces different key → verification fails → trigger migration)

---

## 10. Event Schema & Field Operations

### 10.1 Matrix Event Types

| Event Type | Purpose | Power Level |
|---|---|---|
| `law.firm.record.mutate` | Field-level record changes | 50 (Staff) |
| `law.firm.schema.object` | Schema changes (table/field defs) | 100 (Admin) |
| `law.firm.record.create` | Record creation | 50 (Staff) |
| `law.firm.record.update` | Record update | 50 (Staff) |
| `law.firm.record.delete` | Record deletion | 50 (Staff) |
| `law.firm.view.delete` | View deletion/restore | 50 (Staff) |

### 10.2 Field Operation Semantics

Mutations use three operations, applied in order:

```
ALT (Alter):  Overwrite existing field values
  { ALT: { "Field Name": "new value", "Status": "Active" } }

INS (Insert): Insert new fields (semantically same as ALT, signals intent)
  { INS: { "New Field": "value" } }

NUL (Nullify): Remove fields entirely
  { NUL: ["Field To Remove", "Another Field"] }
  // or: { NUL: { "Field To Remove": true } }
```

### 10.3 Normalized Event Format

`normalizeFieldOps(content)` converts all incoming formats to a canonical structure:

```javascript
// Structured format (from Matrix events):
{ payload: { fields: { ALT: {...}, INS: {...}, NUL: [...] } } }

// Flat format (from HTTP API / n8n):
{ op: 'ALT', fields: { "Field Name": "value" } }

// Both normalize to:
{ ALT: { "Field Name": "value" }, INS: null, NUL: null }
```

---

## 11. Sync State Machine (Intended)

The system **does not currently implement a formal state machine**. State is tracked via independent boolean flags (`_matrixSyncRunning`, `_offlineMode`, `_initialized`, etc.) with no transition validation. The intended lifecycle is:

```
                    ┌─────────────┐
                    │  UNINITIALIZED│
                    └──────┬──────┘
                           │ init()
                           ▼
                    ┌─────────────┐
                    │  HYDRATING   │
                    └──────┬──────┘
                           │ hydrateAll() complete
                           ▼
              ┌────────────────────────┐
              │     SYNCING_ONLINE     │
              │  ┌──────────────────┐  │
              │  │ Matrix sync loop │  │
              │  │   OR              │  │
              │  │ HTTP polling      │  │
              │  └──────────────────┘  │
              └───────────┬────────────┘
                 network  │  │ network
                 lost     │  │ restored
                          ▼  ▲
              ┌────────────────────────┐
              │    SYNCING_OFFLINE     │
              │  Reads: local IDB      │
              │  Writes: mutation queue │
              │  Monitor: connectivity  │
              └────────────────────────┘
                          │
                          │ logout()
                          ▼
              ┌────────────────────────┐
              │       DESTROYED        │
              │  Clear keys, caches    │
              │  Encrypt deferred data │
              └────────────────────────┘
```

---

## 12. Gap Analysis & Bug Audit

### 12.1 Critical Bugs (data loss or corruption possible)

#### CB-1: `applyMutateEvent` calls are not awaited in `processMatrixSyncResponse`

**File:** `data-layer.js:1565`

```javascript
applyMutateEvent(event, roomId);  // ← NO AWAIT
```

`applyMutateEvent` is `async` — it reads from IndexedDB, merges fields, encrypts, and writes back. Without `await`, multiple mutations to the **same record** in the same sync batch interleave: both read the old state, both merge independently, and the last write wins — losing the first mutation's changes.

**Impact:** Field-level data loss when a sync batch contains multiple mutations to the same record.

**Fix:** `await applyMutateEvent(event, roomId);` — or batch by recordId and apply sequentially per-record.

---

#### CB-2: Sync cursor uses client wall-clock time, not server cursor

**File:** `data-layer.js:1504` (applyMutateEvent), `data-layer.js:1235–1274` (syncTable)

The `lastSynced` cursor is set to `new Date().toISOString()` — the client's local clock. If the client's clock is ahead of the server, future server-side updates with timestamps between "real now" and "client's now" will be skipped on the next poll because the cursor is already past them.

**Impact:** Silent data loss — records updated on the server during the clock-skew window are never synced to the client.

**Fix:** Use the server-provided `max(last_synced)` from the response payload, or a `next_since` cursor returned by the API.

---

#### CB-3: Decryption failures silently skip mutations

**File:** `data-layer.js:1402–1405`

```javascript
} catch (err) {
    console.warn('Could not decrypt event payload:', err.message);
    return;  // ← Silently drops the mutation
}
```

If the encryption key becomes inconsistent (password change, key derivation bug, corrupted payload), all incoming mutations are silently dropped. The user sees no error; their data simply stops updating.

**Impact:** Complete sync stall with no user-visible indication.

**Fix:** Emit an `amino:sync-error` event. After N consecutive decrypt failures, show a banner: "Sync is failing — you may need to re-login."

---

#### CB-4: Partial hydration can be marked as successful

**File:** `data-layer.js:1039–1164` (hydrateFromBoxDownload)

`hydrateFromBoxDownload()` returns success when `totalRecords > 0`, even if some tables had zero records or failed entirely. The caller treats any truthy result as "hydration complete" and skips fallback tiers.

**Impact:** User starts working with an incomplete dataset — missing tables appear empty.

**Fix:** Return `{ success, totalTables, succeededTables, failedTables }`. Treat partial success as degraded mode and run per-table fallback for failed tables.

---

#### CB-5: Full hydration doesn't clear stale deleted records

**File:** `data-layer.js` (hydrateTable, hydrateFromBoxDownload)

When a record is deleted in Airtable, the deletion propagates to `amino.current_state` (the record is removed or marked deleted). But `hydrateTable()` only **inserts/updates** records returned by the API — it does not delete local records that are absent from the response.

**Impact:** Ghost records — deleted records persist locally forever after full hydration.

**Fix:** Before writing the hydration batch, delete all existing records for that table in a transaction. Or use a mark-and-sweep: after hydration, delete any local record whose ID wasn't in the server response.

---

### 12.2 Bugs (incorrect behavior)

#### B-1: Optimistic echo detection too strict (type coercion)

**File:** `data-layer.js:447`

```javascript
if (JSON.stringify(alt[key]) !== JSON.stringify(optimistic[key])) {
```

If the server normalizes a value (e.g., `"123"` → `123`, or `"true"` → `true`), the stringified comparison fails. The echo is not suppressed, and the mutation is applied redundantly — creating a duplicate entry in field history.

**Fix:** Use a loose comparison that handles type coercion, or normalize values before comparison.

---

#### B-2: Flat-format mutations bypass optimistic echo check

**File:** `data-layer.js:1440–1445`

When a mutation arrives in flat format (`{ op: 'ALT', fields: {...} }` rather than `{ payload: { fields: { ALT: {...} } } }`), `normalizeFieldOps()` converts it. But `_isOptimisticEcho()` is called with the normalized ops — while `_trackOptimisticWrite()` stores the raw field values. The shapes may differ depending on the format of the echo.

**Impact:** Flat-format echoes may not be suppressed, causing double-processing.

---

#### B-3: Deduplication map pruning can allow replays

**File:** `data-layer.js:398–416`

When `_processedEventIds` exceeds `MAX_PROCESSED_EVENTS` (5000), old entries are dropped. If a Matrix sync response delivers events older than 5 minutes (due to server lag, long-poll timeout, or initial sync catching up), those events will be re-applied after their dedup entry was pruned.

**Fix:** Use the Matrix sync token as the authoritative cursor, not event ID dedup. Events before the sync token should never be re-delivered by the server.

---

#### B-4: HTTP polling and Matrix sync can race on the same record

**File:** `data-layer.js` (syncTable + applyMutateEvent)

Both channels can write to the same record concurrently. Event ID dedup prevents exact duplicates, but a record updated by polling (from `/amino-records-since`) doesn't generate an event ID — it writes the full record state. If Matrix sync is also applying a mutation to the same record, they can interleave.

**Fix:** Disable HTTP polling entirely when Matrix sync is active and healthy. Only fall back to polling when Matrix sync fails.

---

#### B-5: Consecutive-failure abort in polling skips healthy tables

**File:** `data-layer.js` (startPolling loop)

Incremental sync aborts after 2 consecutive per-table failures, leaving remaining tables unprocessed even if they would succeed.

**Fix:** Track failures per-table, not consecutively. Continue attempting all tables; only skip tables that have individually failed N times.

---

### 12.3 Gaps (missing functionality)

#### G-1: No conflict resolution for concurrent edits

There is no merge strategy when a local edit and a remote mutation both affect the same field simultaneously. The system is pure last-write-wins with no detection, notification, or user choice.

**Needed:** At minimum, detect the conflict (compare timestamps) and surface it to the user. Field-level last-writer-wins is acceptable for most fields, but high-value fields (status, assigned attorney) should warn.

---

#### G-2: No sync state machine

State is tracked with independent boolean flags (`_matrixSyncRunning`, `_offlineMode`, `_initialized`, `_airtableSyncInFlight`). There is no validation that transitions are legal — it's possible to enter impossible states (e.g., online + offline simultaneously if transition handlers race).

**Needed:** A formal state machine with defined transitions and guards.

---

#### G-3: No record deletion propagation

Airtable record deletions update `amino.current_state` (the record is removed), but neither the HTTP polling path nor the Matrix sync path explicitly handles deletion events. The client never removes records — they accumulate forever.

**Needed:** A `law.firm.record.delete` event type processed by `applyMutateEvent` that removes the record from IndexedDB and cache.

---

#### G-4: No schema sync

Table and field schema changes (new fields, renamed fields, deleted fields, type changes) are not synced to the client in real time. The client fetches schema once during `init()` and never updates it.

**Needed:** Process `law.firm.schema.object` events to update the local field registry. Currently these events are explicitly filtered out at `data-layer.js:1387`.

---

#### G-5: In-memory cache has no eviction policy

`_recordCacheById` grows unbounded. On a mobile device with limited RAM, accessing records across many tables for hours will eventually cause memory pressure or OOM.

**Needed:** LRU eviction with a configurable max size (see `POST_HYDRATION_PERF_OPTIMIZATIONS.md` §3).

---

#### G-6: No server-provided sync cursor

The `/amino-records-since` API returns records but no `next_since` cursor. The client must fabricate its own cursor from `new Date().toISOString()`, which is vulnerable to clock skew (see CB-2).

**Needed:** The API should return `{ records: [...], next_since: "2026-02-13T10:30:00.000Z" }` based on the server's max timestamp.

---

#### G-7: No partial offline flush / no permanent failure handling

`flushPendingMutations()` retries all queued mutations on reconnect. If a mutation is permanently invalid (400 Bad Request — e.g., the record was deleted upstream), it stays in the queue forever and fails on every flush attempt. There is no backoff per-mutation and no mechanism to discard permanently-failed mutations.

**Needed:** Classify errors as transient (5xx, network) vs permanent (4xx). Discard permanent failures after N retries with user notification.

---

#### G-8: No key rotation / password change recovery

If the Synapse password changes while the app is offline, the client's derived key becomes invalid on reconnect. The current flow detects this via verification token mismatch but requires the user to provide their old password or wipe local data.

**Needed:** Automatic re-hydration path when key mismatch is detected and old password is unavailable.

---

#### G-9: Event listeners never cleaned up on re-initialization

**File:** `data-layer.js:2942–2948, 3288–3296`

Module-level `window.addEventListener('online', ...)` and `window.addEventListener('visibilitychange', ...)` calls are never removed. If the data layer is re-initialized (logout → login), listeners duplicate.

**Needed:** Store listener references and remove them in `destroy()` / `logout()`.

---

#### G-10: Portal room field filtering is incomplete

**File:** `matrix.js` — `enablePortalAccess()` copies full record data to portal rooms with a `// TODO: filter fields` comment. Client-visible field filtering is not applied.

**Impact:** Client users in portal rooms may see staff-only fields.

---

### 12.4 Tech Debt

| Item | Location | Issue |
|---|---|---|
| Hardcoded webhook URLs | `data-layer.js:15,21,22` | Can't change without redeploying code |
| Hardcoded admin list | `matrix.js:63` | `ADMIN_USERNAMES = ['admin']` — no runtime config |
| Hardcoded timeouts | `data-layer.js:18,23,24,25` | Poll interval, cooldown, offline max days — not configurable |
| No sync tests | `tests/` | Formula tests exist; zero test coverage for sync, hydration, dedup, offline |
| Monolithic index.html | `index.html` | 33k lines; edit/sync logic embedded in UI code, not extractable |
| `_deferEncryption` security risk | `data-layer.js:51` | Plaintext at rest during active session if enabled |
| Access token in query params | `data-layer.js:498` | Token in URL visible in server logs, proxy logs, referrer headers |
| No pending_mutations migration | `migrations/` | IDB store created in code, not documented in SQL migrations |

---

## 13. Distance from "Perfect Sync"

A scorecard of sync capabilities rated against what "perfect sync with Airtable as source of truth" requires:

| Capability | Status | Gap |
|---|---|---|
| **Full initial hydration** | 🟢 Working | Tier 1 (Box) works; fallbacks work. Missing: stale record cleanup (CB-5) |
| **Incremental field updates** | 🟡 Mostly working | Works via both channels. Missing: `await` in event processing (CB-1), clock-skew cursor (CB-2) |
| **Record creation sync** | 🟡 Mostly working | New records sync via incremental pull. No dedicated create event processing |
| **Record deletion sync** | 🔴 Not implemented | Deleted records persist locally forever (G-3) |
| **Schema changes sync** | 🔴 Not implemented | Schema events explicitly filtered out (G-4) |
| **Real-time latency** | 🟢 Working | Matrix sync delivers ~1-2s latency when healthy |
| **Fallback when Matrix down** | 🟢 Working | HTTP polling at 15s intervals takes over |
| **Deduplication** | 🟡 Mostly working | Event ID dedup works; echo suppression has type-coercion bug (B-1) and flat-format gap (B-2) |
| **Optimistic writes** | 🟡 Mostly working | Local-first update works; echo suppression works most of the time |
| **Conflict detection** | 🔴 Not implemented | Pure last-write-wins with no detection (G-1) |
| **Offline read** | 🟢 Working | Full offline read from encrypted IndexedDB |
| **Offline write queue** | 🟡 Partial | Queue works; flush has no rollback (CB-5 in prior audit), no permanent failure handling (G-7) |
| **Encryption at rest** | 🟢 Working | AES-GCM-256 with PBKDF2 key derivation |
| **Error recovery** | 🟡 Partial | Retries work; silent decrypt failures (CB-3), no user-visible sync health |
| **Sync health visibility** | 🔴 Not implemented | No UI indicator of sync status, lag, or errors |
| **Test coverage** | 🔴 Not implemented | Zero sync/hydration/dedup tests |

### Overall Assessment

**The system is approximately 60-65% of the way to "perfect sync."**

The core pipeline works: data flows from Airtable → Postgres → n8n APIs → client IndexedDB with encryption. Real-time updates via Matrix work. Offline read access works. The fundamental architecture is sound and well-designed.

The remaining 35-40% consists of:
- **Critical correctness bugs** (un-awaited event processing, clock-skew cursors, silent decrypt failures) that can cause data loss under load — ~10% of the gap
- **Missing deletion and schema sync** — major functional gaps that will produce stale/wrong data over time — ~10% of the gap
- **Conflict resolution and error visibility** — operational blindness when things go wrong — ~8% of the gap
- **Offline write robustness** — partial flush, no permanent failure handling — ~5% of the gap
- **Test coverage and observability** — can't prove correctness or detect regressions — ~7% of the gap

---

## 14. Airtable Decoupling Roadmap

The system was designed from the start to eventually stop depending on Airtable. Here is the path:

### Phase 1: Fix sync correctness (Airtable still source of truth)

Priority fixes while Airtable remains the upstream:

1. **`await` all `applyMutateEvent` calls** (CB-1) — prevents field loss in batches
2. **Server-side sync cursor** (CB-2 + G-6) — add `next_since` to API responses
3. **Record deletion propagation** (G-3) — process delete events or add stale-record cleanup
4. **Decrypt failure visibility** (CB-3) — emit errors instead of silent skip
5. **Stale record cleanup on hydration** (CB-5) — clear-before-write or mark-and-sweep

### Phase 2: Make Postgres authoritative (reduce Airtable to one-way import)

1. **Client writes go directly to Postgres** — bypass Airtable for writes. The `/write` webhook writes to `amino.current_state` first, then optionally mirrors to Airtable.
2. **`last_write_source` tracking** (already exists via migration 003) — use it to distinguish client-originated vs Airtable-originated data.
3. **Schema sync** (G-4) — process `law.firm.schema.object` events so the client can reflect schema changes from Postgres without Airtable.
4. **Conflict detection** (G-1) — add version vectors or timestamps to `amino.current_state` rows for optimistic concurrency.

### Phase 3: Airtable becomes optional read-only mirror

1. **Airtable sync becomes one-way export** — data flows Postgres → Airtable for legacy users, not the reverse.
2. **Remove `triggerAirtableSync()`** — no longer needed; Postgres is authoritative.
3. **Remove Airtable-specific field normalization** — the `airtable:` prefix stripping, Airtable record ID formats, etc.

### Phase 4: Cut loose

1. **Remove all Airtable references** — webhooks, sync triggers, ID normalization.
2. **Replace Box download hydration** with a direct Postgres bulk export endpoint.
3. **Remove n8n as middleware** (optional) — the n8n layer exists partly because Airtable's API needed orchestration. Direct Postgres API (or a thin REST layer) can replace it.
4. **Client writes become the only write path** — Postgres is populated exclusively by Matrix events (via an application service) or direct API writes.

### Dependencies for Decoupling

| Dependency | Current State | Needed |
|---|---|---|
| Postgres has all record data | ✅ `amino.current_state` is populated | Keep current |
| Postgres has schema data | ✅ `amino.field_registry` exists | Need real-time sync to clients |
| Client can write without Airtable | 🟡 Writes go through n8n → Airtable → Postgres | Route writes directly to Postgres |
| Record deletions tracked | 🔴 Only in Airtable | Add soft-delete column to `amino.current_state` |
| Schema changes tracked | 🔴 Only in Airtable field config | Add schema versioning to `amino.field_registry` |
| Audit trail independent of Airtable | ✅ Matrix room history preserves all mutations | Keep current |
| Hydration independent of Box/Airtable | 🔴 Tier 1 uses Box (Airtable export) | Add direct Postgres bulk endpoint |

---

## Appendix A: Configuration Reference

| Constant | Value | File | Purpose |
|---|---|---|---|
| `WEBHOOK_BASE_URL` | `https://n8n.intelechia.com/webhook` | data-layer.js:15 | n8n API base URL |
| `AIRTABLE_SYNC_WEBHOOK` | `...webhook/c875f674-...` | data-layer.js:21 | Manual Airtable sync trigger |
| `BOX_DOWNLOAD_WEBHOOK` | `...webhook/box-download` | data-layer.js:22 | Bulk hydration endpoint |
| `DB_NAME` | `amino-data-layer` | data-layer.js:16 | IndexedDB database name |
| `DB_VERSION` | `2` | data-layer.js:17 | IndexedDB schema version |
| `DEFAULT_POLL_INTERVAL` | `15000` (15s) | data-layer.js:18 | HTTP polling interval |
| `AIRTABLE_SYNC_COOLDOWN` | `60000` (60s) | data-layer.js:23 | Rate limit on manual sync trigger |
| `CONNECTIVITY_CHECK_INTERVAL` | `30000` (30s) | data-layer.js:24 | Offline detection polling |
| `DEFAULT_OFFLINE_ACCESS_MAX_DAYS` | `30` | data-layer.js:25 | Max days offline before re-auth required |
| `PROCESSED_EVENT_TTL` | `300000` (5m) | data-layer.js:57 | Event dedup window |
| `MAX_PROCESSED_EVENTS` | `5000` | data-layer.js:58 | Dedup map prune threshold |
| `OPTIMISTIC_WRITE_TTL` | `30000` (30s) | data-layer.js:64 | Echo suppression window |
| `SYNAPSE_SALT_PREFIX` | `amino-local-encrypt:` | data-layer.js:19 | PBKDF2 salt prefix |
| `PBKDF2 iterations` | `600,000` | data-layer.js:88 | Key derivation cost factor |
| `AES-GCM IV size` | `12 bytes` | data-layer.js:100 | Encryption IV length |

## Appendix B: Custom DOM Events

| Event | Payload | Emitted By | Consumed By |
|---|---|---|---|
| `amino:sync` | `{ source, updatedCount }` | Matrix sync, HTTP polling | UI (renderTable) |
| `amino:record-update` | `{ recordId, tableId, source }` | applyMutateEvent | UI (targeted cell update) |
| `amino:record-mutate` | `{ recordId, tableId, eventId, sender, timestamp, fieldOps, ... }` | applyMutateEvent | Field history tracker |
| `amino:record-updated` | `{ recordId, tableId }` | editRecord (optimistic) | UI (cell re-render) |
| `amino:auth-expired` | `{}` | polling on 401 | UI (show login) |
| `amino:connectivity-restored` | `{}` | connectivity monitor | UI (show reconnect prompt) |
| `amino:offline-mutation-queued` | `{ tableId, recordId, op, queueDepth }` | queueOfflineMutation | UI (badge) |
| `amino:offline-mutations-flushed` | `{ flushed, failed, remaining }` | flushPendingMutations | UI (badge clear) |
| `amino:view-delete` | `{ tableId, viewId, sender, ... }` | processViewDeleteEvent | UI (remove view) |
| `amino:view-restore` | `{ tableId, viewId, sender, ... }` | processViewDeleteEvent | UI (restore view) |

## Appendix C: IndexedDB Schema

```
Database: amino-data-layer (version 2)

Store: records
  keyPath: id
  Indexes:
    byTable:      tableId      (non-unique)
    byLastSynced: lastSynced   (non-unique)
  Record shape: {
    id:        string,           // Airtable record ID (e.g., "recXYZ123")
    tableId:   string,           // Airtable table ID (e.g., "tblABC456")
    tableName: string,           // Human-readable table name
    fields:    ArrayBuffer|string, // AES-GCM encrypted (or JSON string if deferred)
    lastSynced: string           // ISO 8601 timestamp
  }

Store: tables
  keyPath: table_id
  Record shape: {
    table_id:       string,
    table_name:     string,
    matrix_room_id: string,
    record_count:   number,
    primary_field:  string|null,
    field_count:    number|null
  }

Store: sync
  keyPath: tableId
  Record shape: {
    tableId:    string,
    lastSynced: string   // ISO 8601 — high-water mark for incremental sync
  }

Store: crypto
  keyPath: id
  Records:
    { id: 'salt',   value: Uint8Array }         // PBKDF2 salt
    { id: 'verify', value: ArrayBuffer }         // Encrypted verification token
    { id: 'lastOnlineAuth', value: number }      // Epoch ms of last online auth

Store: pending_mutations
  keyPath: id
  Indexes:
    byTable:     tableId    (non-unique)
    byStatus:    status     (non-unique)
    byTimestamp: timestamp  (non-unique)
  Record shape: {
    id:        string,    // "mut_" + timestamp + "_" + random
    tableId:   string,
    recordId:  string,
    op:        string,    // "ALT" | "INS" | "NUL"
    fields:    object,    // Plaintext field changes
    timestamp: number,    // Date.now() when queued
    status:    string     // "pending" | "failed"
  }
```

## Appendix D: PostgreSQL Schema (Server-Side)

```sql
-- Source of truth for record state (fed by Airtable, queried by n8n APIs)
amino.current_state (
  -- (schema inferred from migrations and n8n query patterns)
  record_id         TEXT,
  table_id          TEXT,
  table_name        TEXT,
  fields            JSONB,
  last_synced       TIMESTAMP,
  last_write_source TEXT    -- 'client' | 'airtable_sync' | NULL
)

-- Table ↔ Matrix room mapping
amino.table_registry (
  table_id        TEXT PRIMARY KEY,
  table_name      TEXT,
  matrix_room_id  TEXT,
  primary_field   TEXT,
  field_count     INTEGER
)

-- Field definitions with formula/rollup/lookup metadata
amino.field_registry (
  field_id    TEXT PRIMARY KEY,
  table_id    TEXT,
  field_name  TEXT,
  field_type  TEXT,
  is_computed BOOLEAN DEFAULT FALSE,
  options     JSONB    -- formula defs, rollup configs, lookup refs
)
```
