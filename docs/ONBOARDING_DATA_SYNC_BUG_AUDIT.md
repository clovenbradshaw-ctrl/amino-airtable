# Onboarding, Data Loading, and Data Sync Bug Audit

This audit lists concrete issues observed in the current code and practical bug-fix suggestions.

## 1) Onboarding / Login flow

### Problem A — Session-valid users can still be forced through login if the tab was reloaded
**Evidence**
- Startup restores a session only when `loadSessionKey()` succeeds and can decrypt `verificationToken`; otherwise it falls through to login. This creates friction for users who still have a valid Synapse session token but lost in-memory/sessionStorage encryption key. (`index.html` startup block).  

**Why this hurts onboarding**
- Users perceive this as “random logout” or “app forgot me,” especially after browser restarts.

**Fix suggestions**
- Add a dedicated “Re-enter password to unlock local data” screen when Synapse session is valid but local encryption key is missing.
- Keep login form reserved for truly invalid/expired Synapse sessions.
- Add explicit status copy in UI: “Session is valid, we only need your password to unlock encrypted local cache.”

### Problem B — Old API-key auth controls still exist but are no-op
**Evidence**
- `tryAuth()` and `initAuthScreen()` are now no-op / warning-only, but the legacy auth UI handlers are still wired (`auth-submit`, `api-key-input`, etc.).

**Why this hurts onboarding**
- Confusing first-run UX: users can see controls that do nothing useful.

**Fix suggestions**
- Hide or fully remove legacy API-key controls from first-run flow.
- If retention is required for backward compatibility, gate behind an advanced/legacy toggle and clear explanatory text.

## 2) Data loading / hydration

### Problem C — Webhook hydration success criterion can mark partial loads as “successful”
**Evidence**
- `hydrateFromWebhooks()` returns success when `totalRecords > 0`, even if some tables failed.  
- In `init()`, a successful boolean result skips full Synapse fallback and proceeds with potentially incomplete dataset.

**Why this hurts data loading reliability**
- Users may see missing tables/records with no obvious indicator that hydration was partial.

**Fix suggestions**
- Return richer result object: `{ success, totalTables, succeededTables, failedTables, totalRecords }`.
- Treat failures above a threshold as degraded mode and automatically run table-level fallback from Synapse for failed tables.
- Show a persistent “partial data loaded” banner with retry action.

### Problem D — Full-table hydration does not explicitly remove stale deleted records
**Evidence**
- Table hydration writes current records in batches but does not clear table records before insert/update in `hydrateTable()` in `data-layer.js`.

**Why this hurts data loading correctness**
- If source-side deletions occurred, stale local records can survive a full refresh.

**Fix suggestions**
- Before full table hydration, delete existing local records for that table in a transaction.
- Or use a two-phase reconcile (mark-and-sweep) keyed by record IDs returned by the server.

## 3) Data sync (incremental + real-time)

### Problem E — Incremental cursor is advanced to local wall-clock time, not source cursor
**Evidence**
- `webhookIncrementalSync()` updates `lastWebhookSync` to `new Date().toISOString()` after polling.
- Similar pattern appears in data-layer sync metadata updates.

**Why this can drop updates**
- Updates that happened on the server during request window can be skipped if local time advances beyond source event timestamps.

**Fix suggestions**
- Use server-provided high-water mark (`next_since`, `max_updated_at`, or equivalent) from webhook response.
- If unavailable, set cursor to max `lastSynced/updatedAt` found in payload, not client time.
- Keep small overlap window (e.g., minus 2–5 seconds) and de-dup by record ID + updated_at/event_id.

### Problem F — Consecutive-failure abort logic can skip healthy remaining tables
**Evidence**
- Incremental sync aborts after 2 consecutive failures, potentially leaving remaining tables unprocessed.

**Why this hurts sync completeness**
- A temporary issue on two adjacent tables can block updates for all later tables.

**Fix suggestions**
- Track per-table failures and continue with the rest.
- Add a global timeout budget instead of consecutive-order abort.
- Surface list of failed tables in status feed and retry only those.

### Problem G — Room membership setup may proceed without hard failure signaling
**Evidence**
- `ensureRoomMembership()` and room-join routines log warnings but mostly continue on failures.

**Why this hurts sync troubleshooting**
- Users see stale/missing live updates without clear actionable error state.

**Fix suggestions**
- Persist room join failures in sync status model and UI.
- Add “Retry room join” action with per-room diagnostics.
- Block “realtime connected” indicator unless mandatory table rooms are joined.

## Suggested implementation order (highest impact first)
1. **Cursor correctness** (Problem E) — prevents silent data loss.
2. **Partial hydration handling** (Problem C) — prevents incomplete first-load state.
3. **Stale record cleanup on full hydrate** (Problem D) — prevents ghost records.
4. **Onboarding UX split: login vs unlock** (Problem A).
5. **Failure-isolation in incremental sync** (Problem F) and room diagnostics (Problem G).
6. **Remove/hide legacy auth controls** (Problem B).

## Quick verification checklist after fixes
- Simulate updates during incremental sync request window; verify no dropped records.
- Force webhook failure for subset of tables; verify fallback only for failed tables.
- Delete records upstream, run full hydrate, verify deleted records disappear locally.
- Relaunch app with valid Synapse session + missing local key; verify unlock flow (not full login) appears.
- Break room join for one table room; verify UI displays degraded realtime state and retry action.
