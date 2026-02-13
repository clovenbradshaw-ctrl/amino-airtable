# Evaluation: Does Storing Data in Matrix Rooms Add Real Benefit?

> **Verdict: Matrix adds genuine value as a real-time event transport and audit trail, but using it as a *storage* layer is a net negative. The system already treats PostgreSQL + IndexedDB as the actual stores — Matrix is redundant for storage and introduces significant complexity.**

---

## What Matrix Actually Does Today

Matrix rooms serve three distinct roles in Amino:

1. **Real-time event transport** — `law.firm.record.mutate` events push changes to connected clients via `/sync` long-polling (~1-2s latency)
2. **Schema/config distribution** — State events (`law.firm.schema.table`, `law.firm.schema.field`, `law.firm.org.config`) propagate org structure and field definitions
3. **Audit trail** — The immutable timeline preserves every mutation as a historical event
4. **Access control** — Room membership and power levels gate who can see/modify which data

The question is whether these roles justify the architectural cost, and whether Matrix is the right tool for each.

---

## Where Matrix Adds Real Benefit

### 1. Real-time push (genuine advantage)

The HTTP polling fallback runs at 15-second intervals. Matrix long-poll sync delivers events in ~1-2 seconds. For a multi-user case management tool, this latency difference matters — staff see each other's edits near-instantly instead of waiting up to 15s.

**However:** This is a *transport* benefit, not a *storage* benefit. Any WebSocket or SSE push layer (Postgres LISTEN/NOTIFY, a thin WebSocket server, Supabase Realtime, etc.) could deliver the same latency without Matrix's complexity.

### 2. Access control via room membership (partial advantage)

Matrix power levels (Admin=100, Staff=50, Client=10) provide per-room access control, and the client portal rooms enforce visibility boundaries. This is a real feature.

**However:** The access control model is extremely simple — three fixed roles. This doesn't require a federated chat protocol. A row-level security policy in PostgreSQL or a simple RBAC middleware would be equivalent and far easier to reason about.

### 3. Immutable audit trail (partial advantage)

Matrix timelines are append-only. Every `law.firm.record.mutate` event is preserved with sender, timestamp, and content. For a legal case management system, auditability has compliance value.

**However:** The audit trail is only as good as its consistency. The current system has no test coverage for sync correctness, and the gap analysis identifies multiple paths where events are silently dropped (decrypt failures, un-awaited `applyMutateEvent` calls, clock-skew cursors). A purpose-built audit log in PostgreSQL (a simple `mutations` table with `INSERT`-only permissions) would be more reliable and queryable.

---

## Where Matrix Adds Complexity Without Proportional Benefit

### 1. Redundant data path that requires deduplication

The same record change can arrive via:
- Matrix sync (`law.firm.record.mutate`)
- HTTP polling (`/amino-records-since`)
- Optimistic echo (from the client's own write)

This requires three separate deduplication mechanisms (`_processedEventIds`, `_isOptimisticEcho`, full-table clears on hydration). The dedup logic accounts for a significant chunk of `data-layer.js` complexity. Without Matrix as a parallel data channel, there would be one sync path (HTTP or WebSocket) and dedup would be trivial.

### 2. Matrix sync is the *fallback* target, not the primary hydration path

The three-tier hydration strategy is:
1. Box bulk download (Airtable export)
2. PostgreSQL via `/amino-records` webhook
3. Matrix room replay (last resort)

Matrix room replay is tier 3 — used only when the first two fail. In practice, the system already depends on PostgreSQL for initial data load. Matrix stores the *same data* in a less efficient, less queryable format (JSON events in an append-only DAG vs. rows in a relational database).

### 3. Sync loop complexity and fragile failure modes

The Matrix sync implementation in `data-layer.js:1340-1430` handles:
- Rate limiting (429 backoff)
- Consecutive error counting with exponential backoff
- Abort controller management
- Automatic fallback to HTTP polling after 10 consecutive errors
- Race conditions between Matrix sync and HTTP polling (B-4 fix)

This is ~120 lines of careful error handling for a single sync channel. The HTTP polling path requires its own ~70 lines. A single WebSocket or SSE channel would eliminate the dual-path problem entirely.

### 4. Room-per-table mapping overhead

Every Airtable table maps to a Matrix room. This mapping is stored in:
- `law.firm.vault.metadata` (Matrix state event)
- `amino.table_registry` (PostgreSQL)
- `_tableRoomMap` / `_roomTableMap` (client-side memory)

Three locations for the same mapping, with no reconciliation mechanism if they diverge. Adding or removing tables requires coordinating across all three.

### 5. Schema distribution is over-engineered

Table schemas are distributed as Matrix state events (`law.firm.schema.table`, `law.firm.schema.field`). But they're also in `amino.field_registry` in PostgreSQL. The client currently skips schema-type mutate events (`payloadSet === 'table' || payloadSet === 'field'` at `data-layer.js:1019`). The Matrix schema events exist but aren't consumed for data sync — they're only used for initial room setup.

### 6. Encryption double-duty

The system encrypts data at rest in IndexedDB (AES-GCM-256, PBKDF2 key derivation). It *also* optionally encrypts Matrix event payloads. This means encryption-related code exists in two places with two different failure modes. Decrypt failures on Matrix events silently skip mutations (identified as a critical bug in the gap analysis, CB-3).

---

## Quantifying the Cost

| Cost Area | Impact |
|---|---|
| Dual sync channels (Matrix + HTTP) | ~200 lines of sync loop + fallback logic |
| Triple deduplication | ~80 lines of dedup across 3 mechanisms |
| Room-table mapping maintenance | Stored in 3 locations, no reconciliation |
| Matrix client module | 1,778 lines (`matrix.js`) — login, sync, state events, power levels, room management |
| Event payload encryption | Parallel to IndexedDB encryption, separate failure mode |
| Hydration tier 3 (room replay) | Used only as last resort; duplicates data already in Postgres |
| Mental model overhead | Developers must understand Matrix CS API, room state, power levels, event types, sync tokens |

Total: **~2,000+ lines of code** and a second protocol to understand, for a system that already has a working PostgreSQL + HTTP path.

---

## What Would Be Lost if Matrix Were Removed

1. **~1-2s push latency** → Would need replacement (WebSocket, SSE, Supabase Realtime, Postgres LISTEN/NOTIFY)
2. **Room-based access control** → Would need replacement (RBAC middleware or Postgres RLS)
3. **Append-only audit trail** → Would need replacement (audit log table in Postgres)
4. **Federation potential** → Theoretical benefit; no current use case for cross-homeserver sync
5. **Client portal messaging** → `law.firm.client.message` and `law.firm.note.internal` use Matrix as a chat transport

Items 1-3 are generic infrastructure concerns solvable with simpler tools. Item 4 is unused. Item 5 is the strongest argument for keeping Matrix — it's genuinely useful as a *messaging* protocol for the client portal feature.

---

## Recommendation

**Keep Matrix for what it's good at:** real-time messaging (client portal, internal notes), user presence, and room-based access control for the *messaging* features.

**Stop using Matrix as a data storage/sync layer for records.** Instead:

1. Make PostgreSQL the sole authoritative store (Phase 2 of the existing decoupling roadmap already plans this)
2. Replace Matrix record sync with a single push channel (WebSocket or SSE from a thin API server, or Supabase Realtime on the Postgres tables)
3. Move the audit trail to a Postgres `mutations` table — simpler, queryable, and doesn't depend on Matrix timeline consistency
4. Eliminate the dual-sync deduplication problem entirely

This aligns with the project's own Airtable Decoupling Roadmap (Phase 4), which envisions "Client writes become the only write path — Postgres is populated exclusively by Matrix events (via an application service) or direct API writes." The logical next step of that thinking is: if Postgres is the authority, why route writes through Matrix at all?

---

## Summary

| Role | Matrix Value | Better Alternative |
|---|---|---|
| Record data storage | Redundant (Postgres is already the actual store) | Postgres only |
| Real-time record sync | Genuine (~1-2s vs 15s) but replaceable | WebSocket/SSE from Postgres |
| Schema distribution | Not consumed by data sync; redundant with `field_registry` | Postgres + HTTP API |
| Audit trail | Fragile (silent drops, no tests) | Postgres append-only table |
| Access control (records) | Over-engineered for 3 fixed roles | Postgres RLS or RBAC middleware |
| Client portal messaging | Genuine, hard to replace | **Keep Matrix for this** |
| Internal notes | Genuine, works well | **Keep Matrix for this** |

**Bottom line:** Matrix adds real value as a messaging protocol. As a record storage and sync layer, it duplicates what PostgreSQL already does while adding ~2,000 lines of complexity, three deduplication mechanisms, and multiple identified correctness bugs. The project would be simpler and more reliable by consolidating record storage in PostgreSQL and using Matrix only for its chat/messaging strengths.
