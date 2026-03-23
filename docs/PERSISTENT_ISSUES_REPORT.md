# Persistent Issues Report — Amino

**Date:** 2026-03-23
**Scope:** Issues that have recurred or remained unresolved across multiple development cycles, based on audit documents, git history (PRs #399–#437), and codebase analysis.

---

## Executive Summary

Amino has **17 documented issues** across 5 categories. Despite significant development effort (39+ PRs), several core problems have persisted because they are deeply architectural — surface-level fixes address symptoms without resolving root causes. The three most persistent problem areas are:

1. **Formula rendering** — attempted fixes in 8+ PRs, still fundamentally broken
2. **Interface view reliability** — repeatedly patched, still fails silently
3. **Performance & UX glitches** — cache thrashing, DOM destruction, and blank screens remain

---

## 1. Formula Rendering (PERSISTENT — 8+ fix attempts)

**PRs that attempted fixes:** #408, #415, #420, #430, #434, #435, #436, #437

This is the single most persistent issue in the project. Each PR has addressed a different layer of the failure chain, yet formulas still break because the root architecture is flawed.

### What keeps breaking

| Sub-issue | Status | Details |
|-----------|--------|---------|
| Modern formula engine not wired into rendering | **UNFIXED** | `src/formulas/` has a complete `FormulaRegistry`, `initializeFormulas()`, and `computeRecordFormulas()` — none are exposed through `bridge.js`. The legacy `_applyFormulaColumns()` in `index.html` is still used instead. |
| Silent skip on large tables (>50K ops threshold) | **UNFIXED** | `_shouldSkipFormulaColumns()` at `index.html:24587` silently skips all formulas when `recordCount × formulaCount > 50,000`. Only 4 hardcoded "high-priority" field names are attempted. No user-facing indication. |
| Lookup/rollup returns null when linked table not cached | **PARTIALLY FIXED** | PR #408 added count/lookup/rollup computation, but `_getLinkedRecordFields()` still returns `null` if the linked table hasn't been visited. No proactive pre-loading of linked data. |
| META_FIELDS naming duality (field IDs vs. field names) | **PARTIALLY FIXED** | PRs #435 and #436 added alias maps to bridge the ID↔name gap, but the underlying duality persists — records store values by field ID, formulas reference by field name, and the translation layer is fragile. |
| Formula runtime errors silently swallowed | **UNFIXED** | `catch(_e) { /* leave cell empty */ }` at `index.html:24943`. No console warning, no error indicator, no debugging information. |
| Field registry must be fetched from network before render | **PERSISTS** | Every table switch requires a 200–500ms `fetchFieldRegistry()` call to Postgres. PRs #415 and #437 ensured this happens, but it remains a blocking network dependency that delays first render. |

### Why it persists

The project has two complete formula engines that are not integrated. The legacy inline system in `index.html` has 5 distinct failure modes, and each PR has patched one mode without addressing the others. The modern `src/formulas/` engine handles dependency ordering, cross-table lookups, and caching correctly, but only exposes `parseAirtableFormula`, `collectFieldRefs`, and `compileFormula` through the bridge — missing `FormulaRegistry`, `initializeFormulas()`, `buildDataContext()`, and `computeRecordFormulas()`.

### Recommended resolution

Wire the modern `FormulaRegistry` into the rendering pipeline and retire the legacy `_applyFormulaColumns()`. This is a single architectural change that would resolve all 6 sub-issues simultaneously.

---

## 2. Interface View Reliability (PERSISTENT — multiple fix attempts)

**PRs that attempted fixes:** #409, #418, #421

### What keeps breaking

| Sub-issue | Status | Details |
|-----------|--------|---------|
| Zero error boundaries in `renderPage()` | **UNFIXED** | No try-catch anywhere in the Interface rendering pipeline. Any throw (network error, IDB error, decryption error, missing property) aborts rendering and leaves the skeleton loader visible forever. |
| Table name resolution fails silently | **UNFIXED** | Schema references tables by name; `_resolveTableId()` uses fuzzy matching across 4 strategies. If a table was renamed or uses unexpected formatting, resolution returns `null` and all blocks for that table render empty with no error. |
| META_FIELDS cleared by Database view | **UNFIXED** | `showTable()` at `index.html:16755` deletes field metadata for the previous table. If a user switches from Database → Interface, field ID resolution breaks for tables whose metadata was cleared. |
| Sync events cause full page re-render | **UNFIXED** | Every `amino:record-updated` event clears ALL data caches (`_tableDataCache`, `_ifaceSearchTextCache`, record cache) and schedules a full `renderPage()`. 10 record updates in 2 seconds = multiple full re-renders with full re-decryption. |
| Formula failures cascade into Interface blocks | **UNFIXED** | Interface calls `_applyFormulaColumns()` on its data, inheriting all formula rendering bugs from Section 1. |

### Why it persists

PR #409 unified the Interface data flow with the Database view, which fixed missing records but imported all of the Database view's rendering bugs (DOM destruction, cache thrashing, formula failures). PR #421 fixed layout and profile loading but didn't add error boundaries. The Interface needs its own error handling strategy, not just shared data plumbing.

---

## 3. Data Sync Integrity (PERSISTENT — documented but unfixed)

**Documented in:** `ONBOARDING_DATA_SYNC_BUG_AUDIT.md` (Problems C, D, E, F)

| Sub-issue | Status | Impact |
|-----------|--------|--------|
| Sync cursor uses local clock, not server cursor | **UNFIXED** | `webhookIncrementalSync()` sets cursor to `new Date().toISOString()`. If local time is ahead of server time, updates created during the request window are silently dropped. This causes **silent data loss**. |
| Partial hydration marked as success | **UNFIXED** | `hydrateFromWebhooks()` returns success when `totalRecords > 0`, even if some tables failed. Users see missing tables with no error indicator and no retry option. |
| Deleted records survive full hydration | **UNFIXED** | Table hydration writes current records but never clears stale records. Upstream deletions are invisible locally — ghost records persist indefinitely. |
| Consecutive-failure abort skips healthy tables | **UNFIXED** | Incremental sync aborts after 2 consecutive table failures. A transient issue on 2 adjacent tables blocks sync for all remaining tables in the queue. |

### Why it persists

PR #418 ("Fix 15 data pipeline, rendering, and UX issues") addressed rendering and UX problems but did not touch the sync cursor, partial hydration, stale record cleanup, or failure isolation logic. These are data-layer bugs in `hydration.js` and `data-layer.js` that require changes to the sync protocol, not the UI.

---

## 4. Performance & Loading UX (PARTIALLY ADDRESSED — core issues remain)

**PRs that attempted fixes:** #414, #416, #418, #419

| Sub-issue | Status | Details |
|-----------|--------|---------|
| PBKDF2 600K iterations blocks main thread | **UNFIXED** | `deriveKeyFromPassword()` runs 600,000 PBKDF2 iterations on the main thread, causing a 500–1000ms freeze on login. Should be moved to a Web Worker. |
| LRU cache evicts by insertion order, not access time | **UNFIXED** | When the record cache exceeds 2,000 entries, it evicts the first 50% by `Object.keys()` order. Switching between two large tables causes constant cache thrashing and re-decryption (100–200ms per switch). |
| Full DOM destruction on sync events | **UNFIXED** | `_flushSyncRenderUpdates()` falls through to full `renderTable()` (innerHTML replacement) when updated records aren't on the current page. Causes visual flicker, scroll position reset, and interaction interruption. |
| Filter cache invalidated on every sync event | **UNFIXED** | `_recordSearchDataVersion` increments on every `amino:record-updated`, even for unrelated records. Paginating during active sync takes ~500ms per page instead of ~50ms. |
| Formula result cache cleared too aggressively | **UNFIXED** | `invalidateFormulaResultCache()` clears all results on every record update, even when the updated record's formula inputs haven't changed. |
| Loading overlay hides before hydration on first load | **PARTIALLY FIXED** | PR #414 added a loading overlay during initial load, and PR #419 added pre-sync DB stats. But the overlay still hides before hydration completes on the new-device path, showing an empty app shell for 5–60s. |

### Why it persists

The performance fixes so far have been additive (adding loading indicators, showing stats) rather than structural (fixing the cache, moving crypto off-thread, implementing targeted DOM updates). The underlying architectural choices — insertion-order eviction, main-thread PBKDF2, innerHTML-based rendering, global cache invalidation — remain unchanged.

---

## 5. Login & Session UX (PARTIALLY FIXED)

**PRs that attempted fixes:** #417, #422, #427

| Sub-issue | Status | Details |
|-----------|--------|---------|
| Session-valid users shown full login screen | **PARTIALLY FIXED** | PR #417 added offline unlock, but only when there is no internet connection. Users who restart their browser while online still see the full login screen instead of a simpler "unlock" prompt, even though their Synapse session is valid. |
| Legacy API-key auth controls still visible | **UNFIXED** | `tryAuth()` and `initAuthScreen()` are no-op/warning-only, but legacy UI handlers (`auth-submit`, `api-key-input`) are still wired. First-run users can see controls that do nothing. |
| Room membership failures not surfaced | **UNFIXED** | `ensureRoomMembership()` logs warnings but continues on failure. Users see stale/missing live updates with no actionable error state or retry option. |

---

## Issue Severity Summary

| Severity | Count | Fully Fixed | Partially Fixed | Unfixed |
|----------|-------|-------------|-----------------|---------|
| **Critical** (breaks core functionality) | 6 | 0 | 2 | 4 |
| **High** (severe UX degradation) | 7 | 0 | 2 | 5 |
| **Medium** (degraded experience) | 7 | 0 | 1 | 6 |
| **Total** | **20** | **0** | **5** | **15** |

---

## Recommended Priority Actions

### Tier 1 — Architectural fixes (resolve multiple issues each)

1. **Wire modern FormulaRegistry into rendering pipeline** — Resolves 6 formula sub-issues simultaneously. Replace `_applyFormulaColumns()` with `FormulaRegistry.computeRecordFormulas()`. Export missing methods from `bridge.js`.

2. **Fix sync cursor to use server timestamp** — Prevents silent data loss. Use `max(updated_at)` from webhook response instead of `new Date().toISOString()`.

3. **Add error boundaries to Interface renderPage()** — Wrap rendering in try-catch, replace skeleton with error message + retry button on failure. Prevents infinite skeleton loader.

### Tier 2 — Targeted fixes (high impact, moderate effort)

4. **Fix LRU cache to use access-time eviction** — Use a `Map` with re-insertion on access. Eliminates cache thrashing between tables.

5. **Scope cache invalidation to affected table only** — Stop clearing ALL caches on every `amino:record-updated`. Only invalidate entries for the updated table.

6. **Move PBKDF2 to Web Worker** — Eliminates 500–1000ms main-thread freeze on login.

7. **Show unlock screen (not login) when session is valid** — Extend offline unlock to work when online too.

### Tier 3 — Correctness fixes

8. **Clean stale records on full hydration** — Delete existing records before writing fresh batch.
9. **Return per-table hydration status** — Show "partial data" banner with per-table retry.
10. **Remove consecutive-failure abort** — Use per-table failure tracking instead.

---

## Pattern Analysis

The persistent issues share common patterns:

1. **Silent failures** — Errors are swallowed (`catch(_e) {}`) or return `null` without logging. Users see empty cells/blocks with no indication of what went wrong. This makes debugging nearly impossible without reading source code.

2. **Global invalidation** — Cache clearing, DOM rebuilding, and filter re-evaluation happen globally when they should be scoped to the affected table/record. This turns O(1) operations into O(n) operations.

3. **Two systems, one job** — The formula engine has a modern and legacy version. Login has auth and unlock paths that aren't properly separated. Hydration has webhook and Synapse paths with inconsistent error handling. In each case, the better system exists but isn't fully connected.

4. **Surface-level fixes** — The git history shows 8+ formula fix PRs that each address one failure mode. The pattern repeats: fix one symptom → discover the next failure layer → new PR. The architectural root cause (legacy engine doing the work, modern engine sitting idle) remains unaddressed.
