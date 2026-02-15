# Data Pipeline & UX Audit Report

Complete analysis of the data pipeline, rendering flow, and UX issues across both new-device onboarding and returning-user login scenarios.

---

## Executive Summary

The application has **17 distinct issues** across 5 categories that collectively produce the "glitchy" experience. The root causes are:

1. **Formula fields don't compute** because the modern formula registry (`src/formulas/`) is fully built but never wired into the rendering pipeline. The legacy inline system that IS wired in silently skips formulas on large tables and swallows all errors.
2. **The Interface view is broken** because it fails silently at every level — schema loading, table name resolution, data fetching, and block rendering all return empty results with zero user feedback on failure.
3. **Long blank-screen periods** are caused by sequential encryption/decryption during hydration (600K PBKDF2 iterations per record), an insertion-order cache eviction bug that forces re-decryption on back-navigation, and hydration that blocks the UI thread without yielding.
4. **Glitchy rendering** stems from full DOM destruction on every sync event, aggressive filter cache invalidation, and formula re-evaluation on every render cycle.

---

## Table of Contents

1. [Data Flow: New Device (First Login)](#1-data-flow-new-device-first-login)
2. [Data Flow: Returning User (Re-Login)](#2-data-flow-returning-user-re-login)
3. [Formula Fields: Why They Don't Render](#3-formula-fields-why-they-dont-render)
4. [Interface View: Why It's Broken](#4-interface-view-why-its-broken)
5. [Blank Screen Periods & Loading UX](#5-blank-screen-periods--loading-ux)
6. [Glitchy Rendering During Use](#6-glitchy-rendering-during-use)
7. [Data Integrity Issues](#7-data-integrity-issues)
8. [Complete Issue Catalog](#8-complete-issue-catalog)
9. [Recommended Fix Order](#9-recommended-fix-order)

---

## 1. Data Flow: New Device (First Login)

### Sequence

```
Page load
  │
  ├─ IndexedDB opens in parallel (window._earlyDbPromise)     [~50ms]
  ├─ _loadSynapseSession() returns null (no localStorage)
  └─ Login screen visible (default state)
       │
       User enters credentials
       │
  trySynapseLogin()                                            [~500-2000ms]
  ├─ POST /_matrix/client/v3/login                             [~200-800ms network]
  ├─ _saveSynapseSession() to localStorage
  ├─ deriveKeyFromPassword(password, salt)                     [~500-1000ms] ◄── BLOCKING
  │   └─ PBKDF2: 600,000 iterations on main thread
  ├─ saveSessionKey(encryptionKey)
  ├─ AminoData.prepareKey(password, userId)
  └─ showLoadingOverlay() → hideSynapseLoginScreen()
       │
  init()                                                       [~50-100ms before overlay hides]
  ├─ openDB() (from early promise)
  ├─ getAllTables() → empty (first load)
  ├─ hideLoadingOverlay()                                      ◄── APP VISIBLE, EMPTY
  ├─ showHydrationPicker() or auto-pick 'postgres'
  └─ _startBackgroundHydration()
       │
  hydrateFromWebhooks()                                        [~5-60s depending on data size]
  ├─ GET /amino-tables                                         [~200-500ms]
  ├─ For each table (3 concurrent):
  │   ├─ GET /amino-records?tableId=...                        [~500-5000ms per table]
  │   ├─ encrypt() each record                                 [~1-5ms per record × N records]
  │   └─ Batch write to IndexedDB (200 records/batch)
  ├─ Mark amino_hydration_complete in localStorage
  └─ Reload metadata → renderSidebar() → showTable(first)
       │
  showTable(firstTable)
  ├─ fetchFieldRegistry(tableId) from Postgres                 [~200-500ms]
  ├─ getRecordIdsForTable(tableId) from IndexedDB
  ├─ getRecordsByIds() → decrypt from IndexedDB               [~50-200ms]
  └─ renderTable()
       ├─ Build HTML → innerHTML
       └─ requestAnimationFrame → _applyFormulaColumns()       ◄── FORMULAS ATTEMPT HERE
```

### Problems in This Flow

| Step | Issue | Impact |
|------|-------|--------|
| `deriveKeyFromPassword()` | 600K PBKDF2 iterations on main thread | **500-1000ms freeze** — user clicks login, nothing happens |
| `hideLoadingOverlay()` before hydration | App shows empty shell immediately | User sees blank app with no data for 5-60s |
| `hydrateFromWebhooks()` batching | Records encrypted one-by-one in a loop | Hydration is 2-10x slower than necessary |
| No progress during encryption | `onProgress` fires per-table, not per-record | User sees "Loading..." with no percentage |
| `fetchFieldRegistry()` | Separate network call per table | Adds 200-500ms latency before first table renders |
| Partial hydration marked as success | If 3/10 tables fail, still "success" | User sees missing tables with no error |

---

## 2. Data Flow: Returning User (Re-Login)

### Scenario A: Session + SessionKey Intact (Page Refresh)

```
Page load
  ├─ _loadSynapseSession() → valid session from localStorage
  ├─ loadSessionKey() → CryptoKey from sessionStorage           [~5ms]
  ├─ showLoadingOverlay('local-memory')
  ├─ verifySynapseSession() in background (non-blocking)
  └─ init()
       │
  init() — Path A (IDB has data + hydration_complete flag)
  ├─ getAllTables(), getAllFields(), getAllViews() in parallel   [~50-100ms from IDB]
  ├─ Pre-warm first table: getRecordIdsForTable()              [~20-50ms]
  ├─ renderSidebar()                                            [~20-50ms]
  ├─ showTable(firstTable)
  │   ├─ fetchFieldRegistry() from Postgres                    [~200-500ms] ◄── NETWORK REQUIRED
  │   ├─ getRecordsByIds() from LRU cache or IDB               [~20-200ms]
  │   └─ renderTable() + deferred formulas
  ├─ hideLoadingOverlay()                                       [~400ms fade]
  └─ Background: deferred Box refresh, webhook polling, sync
```

**Total time to interactive: ~400-800ms** — This is the fast path and works well.

### Scenario B: Session Valid but SessionKey Lost (Browser Restart)

```
Page load
  ├─ _loadSynapseSession() → valid session
  ├─ loadSessionKey() → null (sessionStorage cleared)
  ├─ verifySynapseSession() → awaited synchronously             [~200-800ms]
  │
  │  If online:
  │  ├─ Session valid → need password to derive key
  │  └─ FALLS THROUGH TO LOGIN SCREEN                          ◄── PROBLEM: Looks like logout
  │
  │  If offline + cached data:
  │  └─ showOfflineUnlockScreen() → password → deriveKey()
```

**Problem (documented as Bug Audit Problem A):** Users perceive this as "random logout." They have a valid Synapse session — they just need to re-derive the encryption key. But the app shows a full login screen instead of a "re-enter password to unlock" screen.

### Scenario C: Session Expired

```
Page load
  ├─ _loadSynapseSession() → token exists
  ├─ verifySynapseSession() → 401 response                     [~200-500ms]
  └─ Clear session → show login screen
       │
  User logs in (same as new device from here)
  BUT: IndexedDB still has encrypted data from previous session
  ├─ If same password: data is retained (fast re-login)
  ├─ If different password: clearAllData() → full re-hydration  ◄── SLOW PATH
```

### Key Differences Between Flows

| Aspect | New Device | Returning (Refresh) | Returning (Restart) |
|--------|-----------|--------------------|--------------------|
| Session restore | Full login required | Instant (localStorage) | Session OK, key lost |
| Encryption key | Derived from password (~1s) | From sessionStorage (~5ms) | **Must re-login to derive** |
| Data hydration | Full download (5-60s) | Skip (IDB cached) | Skip if same password |
| First render | After hydration completes | ~400-800ms | After re-login + ~400-800ms |
| Field registry | Network fetch required | Network fetch required | Network fetch required |
| UX perception | Expected wait | Fast, good | **"App forgot me"** |

---

## 3. Formula Fields: Why They Don't Render

### The Two Formula Systems

The codebase contains **two completely separate formula engines**:

| System | Location | Status |
|--------|----------|--------|
| **Modern ES Module** | `src/formulas/` (parser, compiler, registry, integration, bridge) | Built correctly, **NOT USED for rendering** |
| **Legacy Inline** | `index.html:24783-24948` (`_applyFormulaColumns`) | Actually used, **critically flawed** |

### Why the Modern System Isn't Used

`src/formulas/bridge.js` (loaded as ES module at line 36426) exposes only 3 methods to `window._formulaEngine`:

```javascript
window._formulaEngine = {
    parseAirtableFormula,   // ✅ Used by legacy system
    collectFieldRefs,       // ✅ Used by legacy system
    compileFormula          // ✅ Used by legacy system
};
```

**Missing from the bridge:**
- `FormulaRegistry` — handles dependency ordering, lookup/rollup resolution, cached compilation
- `initializeFormulas()` — creates and compiles a registry for a table
- `computeRecordFormulas()` — applies all computed fields to a record
- `buildDataContext()` — provides cross-table data for lookups

The legacy `_applyFormulaColumns()` at `index.html:24783` uses the bridge's parse/compile, but reinvents dependency ordering and relational field resolution with critical gaps.

### Five Specific Reasons Formulas Fail

#### Reason 1: Silent Skip on Large Tables

`index.html:24587-24591`:
```javascript
function _shouldSkipFormulaColumns(recordCount, formulaCount) {
    if (_disableFormulaEvaluation) return true;
    return (recordCount * formulaCount) > 50000;
}
```

A table with **200 records and 250 formula fields** (or 500 records and 100 formulas) silently skips ALL formula computation. Only 4 hardcoded "high-priority" field names are attempted:

```javascript
var highPriorityFormulaFields = {
    'Client Name': true,
    'Full Name Client': true,
    'Display Name': true,
    'Name': true
};
```

**User sees:** Empty formula cells with no error, no indication formulas were skipped.

#### Reason 2: Lookup/Rollup Depends on Pre-Loaded Cross-Table Data

`index.html:24599-24607` (`_getLinkedRecordFields`):
```javascript
function _getLinkedRecordFields(linkedTableId, recordId) {
    if (window.IN_MEMORY_DATA && window.IN_MEMORY_DATA[linkedTableId] &&
        window.IN_MEMORY_DATA[linkedTableId][recordId]) {
        return window.IN_MEMORY_DATA[linkedTableId][recordId];
    }
    var cacheKey = linkedTableId + '|' + recordId;
    var cached = _recordCache.get(cacheKey);
    if (cached && cached.fields) return cached.fields;
    return null;  // ◄── Returns null if linked table not in memory
}
```

Lookups and rollups only work if the linked table's records are **already in `IN_MEMORY_DATA` or `_recordCache`**. If the user hasn't visited the linked table, or if the LRU cache evicted those records, lookups return `null` and rollups return `null`.

**User sees:** Empty lookup/rollup cells that magically populate only after visiting the linked table.

#### Reason 3: Formula Runtime Errors Are Silently Swallowed

`index.html:24943-24945`:
```javascript
} catch (_e) {
    // Formula runtime error — leave cell empty
}
```

No console warning, no error indicator, no debugging information. If a formula fails (undefined field reference, type mismatch, division by zero), the cell simply stays empty.

#### Reason 4: Field Reference Resolution Can Fail

`index.html:24836`: `resolveFormulaFieldNames(formulaExpr, tableId)` converts `{fldXYZ}` to `{Field Name}` so the compiled formula can find values in the record object.

This depends on `META_FIELDS[tableId]` being fully populated. If field metadata is incomplete (partial hydration, failed fetch), the formula expression keeps raw field IDs like `{fldXYZ}`, which don't match any key in the record object, so the formula returns `null` or `undefined`.

#### Reason 5: Deferred Formula Computation Can Be Stale

`index.html:16965-16969`:
```javascript
var _deferFormulas = !paginationOnly && displayRecordIds.length > 0;
if (!_deferFormulas) {
    _applyFormulaColumns(currentTable, fields, recordMap);
}
```

Formulas are deferred to `requestAnimationFrame` (line 17209-17211) to paint the table grid faster. The DOM is rendered with **empty formula cells first**, then formula values are computed and injected. If the user navigates away before the rAF fires, formulas never compute. If a sync event triggers a re-render during the rAF delay, the formula update targets stale DOM.

### Formula Pipeline Diagram

```
Record data in IDB (encrypted)
  │
  ├─ getRecordsByIds() → decrypt → recordMap {recordId: {fieldId: value}}
  │
  ├─ _applyRelationalColumns()
  │   ├─ Count fields: count linked record IDs in link field
  │   ├─ Lookup fields: _getLinkedRecordFields() → linked table data
  │   │   └─ Returns null if linked table not in memory  ◄── FAILS SILENTLY
  │   └─ Rollup fields: aggregate lookup values
  │
  ├─ _applyFormulaColumns()
  │   ├─ _shouldSkipFormulaColumns() → skip if > 50K ops  ◄── FAILS SILENTLY
  │   ├─ resolveFormulaFieldNames() → convert IDs to names
  │   │   └─ Depends on META_FIELDS being complete        ◄── CAN FAIL SILENTLY
  │   ├─ Parse → AST → Compile → executable function
  │   ├─ Topological sort (circular deps silently skipped)
  │   └─ Execute fn(row) for each record
  │       └─ catch(_e) { /* leave cell empty */ }          ◄── SWALLOWED
  │
  └─ DOM updated via innerHTML or rAF cell injection
```

---

## 4. Interface View: Why It's Broken

### The Interface Rendering Pipeline

```
InterfaceApp.init()  (index.html ~line 33875)
  │
  ├─ _preWarmClientData()          → fetch client records into cache
  ├─ loadSchema()                  → Matrix state event or DEFAULT_SCHEMA
  ├─ _getVisiblePages()            → filter by user role
  └─ renderPage(_activePage)
       │
       ├─ container = getElementById('iface-page-container')
       │   └─ if (!container || !_schema) return;      ◄── SILENT FAILURE #1
       │
       ├─ visiblePages = _getVisiblePages()
       │   └─ if (!visiblePages.length) show "No pages" ◄── SILENT FAILURE #2
       │
       ├─ Render skeleton loader into container
       │
       ├─ Pre-fetch all block data sources in parallel:
       │   Promise.all(fetchPromises)                   ◄── NO TRY-CATCH
       │
       ├─ For each block:
       │   html += _renderBlock(block)                  ◄── NO TRY-CATCH
       │   │
       │   └─ _getSourceRecords(block.source)
       │       ├─ _resolveTableId(source.tableName)
       │       │   └─ Returns null if no match          ◄── SILENT FAILURE #3
       │       └─ _getTableRecords(tableId)
       │           ├─ getRecordIdsForTable() from IDB
       │           ├─ getRecordsByIds() → decrypt
       │           ├─ _applyFormulaColumns()            ◄── Formulas may fail
       │           └─ Translate field IDs → field names
       │               └─ Depends on META_FIELDS        ◄── SILENT FAILURE #4
       │
       └─ container.innerHTML = html                    ◄── Replaces skeleton
```

### Six Reasons the Interface Breaks

#### Reason 1: Schema Table Name Resolution Fails

The Interface schema references tables by **name** (e.g., `"client info"`), not by ID. `_resolveTableId()` tries fuzzy matching across 4 strategies:

1. Exact case-sensitive match
2. Normalized match (strip punctuation, singularize)
3. Case-insensitive contains
4. Normalized contains

If table names change, get renamed, or use different formatting than the schema expects, resolution returns `null`. All blocks that reference that table render empty.

**No error shown to user.**

#### Reason 2: No Error Boundaries

The `renderPage()` function has **zero try-catch blocks**. If any of these throw:
- `_getSourceRecords()` — network error, IDB error, decryption error
- `_renderBlock()` — missing property access, undefined data
- `Promise.all(fetchPromises)` — any single fetch rejection

The entire page rendering aborts. The skeleton loader that was placed in the container is **never replaced**. User sees a loading spinner forever.

#### Reason 3: META_FIELDS Cleared by Database View

`index.html:16755-16757` (inside `showTable()`):
```javascript
if (currentTable && currentTable !== tableId) {
    delete META_FIELDS[currentTable];
}
```

The Database view **deletes** field metadata for the previous table when switching. If the user was in Database view → switches to Interface view, the Interface tries to load field metadata for multiple tables simultaneously. If any of those tables had their metadata cleared and the reload from IDB fails, field ID → field name translation fails. Blocks render with raw field IDs or empty data.

#### Reason 4: Data Cache Has 10-Second TTL

Interface block data is cached with a 10-second TTL (`_tableDataCache`). If a page has 5 blocks referencing 3 different tables, and the cache expires mid-render, some blocks show stale data while others show fresh data. On sync events, the cache is cleared entirely and the full page re-renders — with a 400ms debounce for `amino:record-updated` and a 1000ms debounce for `amino:sync`.

#### Reason 5: Sync Events Cause Full Page Re-Render

`index.html:33921-33938`:
```javascript
window.addEventListener('amino:record-updated', function() {
    _tableDataCache = {};
    _ifaceSearchTextCache = {};
    clearRecordCache();
    if (_currentApp === 'interface' && _activePage) {
        clearTimeout(init._refreshTimer);
        init._refreshTimer = setTimeout(function() { renderPage(_activePage); }, 400);
    }
});
```

Every `amino:record-updated` event:
1. **Clears ALL data caches** (even for unrelated tables)
2. **Clears the entire record cache** (`clearRecordCache()`)
3. Schedules a **full page re-render** in 400ms

If 10 records update in a 2-second window, the page re-renders multiple times. Each re-render refetches all data from IDB (requiring decryption) because the cache was cleared.

#### Reason 6: Formula Computation Failures Cascade

The Interface calls `_applyFormulaColumns()` on its data (line 30483). All the formula issues from Section 3 apply here. If a block displays a "Client Name" formula field and that formula fails to compute, the column shows empty for every row.

---

## 5. Blank Screen Periods & Loading UX

### Inventory of Blank/Empty Periods

| Scenario | Duration | What User Sees | Root Cause |
|----------|----------|---------------|------------|
| First login: PBKDF2 key derivation | 500-1000ms | Login button appears stuck | 600K iterations on main thread |
| First login: between overlay hide and hydration | 5-60s | Empty app shell (sidebar + empty table area) | Overlay hides before data exists |
| First login: during hydration | 5-60s | Loading overlay with incomplete progress | `onProgress` only fires per-table, not per-record |
| Returning user: browser restart | 200-800ms | Login screen (should be unlock screen) | SessionKey lost, falls through to full login |
| Table switch: field registry fetch | 200-500ms | Table headers visible, rows empty | `fetchFieldRegistry()` awaited before `renderTable()` |
| Table switch: record decryption (cache miss) | 100-500ms | Table headers visible, rows loading | LRU cache eviction forces IDB re-reads |
| Interface load: schema from Matrix | 200-1000ms | Interface container empty | `loadSchema()` awaited with no skeleton |
| Interface load: data fetch | 200-2000ms | Skeleton loader | `Promise.all(fetchPromises)` with no timeout |
| Interface: failed fetch | Indefinite | Skeleton loader forever | No error handling, skeleton never replaced |
| Formula computation (deferred) | 100-500ms | Formula cells empty after table appears | rAF callback hasn't fired yet |

### Loading Overlay Analysis

The loading overlay (`index.html:16501-16619`) covers well for the initial load path. However:

1. **Overlay hides too early on first load** — `hideLoadingOverlay()` is called before hydration starts (`init()` Path B, line 19494). The user sees an empty app.
2. **No skeleton for table content** — `renderTableHeaders()` shows column headers, but the table body is empty until `renderTable()` completes.
3. **No loading indicator for Interface** — The Interface shows a skeleton loader during data fetch, but if the fetch fails, the skeleton stays forever.
4. **No progress for record encryption/decryption** — The PBKDF2 + AES-GCM operations are invisible to the user.

---

## 6. Glitchy Rendering During Use

### Problem: Full DOM Destruction on Every Sync Event

**Database view:** When background sync fires `amino:record-updated`, `_flushSyncRenderUpdates()` (line 23623) tries targeted cell updates for visible records. But if the updated record is NOT on the current page, it falls through to a full `renderTable()` call (line 23654). This destroys the entire table DOM via `innerHTML`, causing:

- Visual flicker (entire table disappears and reappears)
- Scroll position reset
- Loss of any active hover/focus states
- Interruption of user interactions (typing, selecting)

**Interface view:** Every `amino:record-updated` clears ALL caches and schedules a full `renderPage()` (line 33927), which rebuilds every block from scratch.

### Problem: Filter Cache Thrashing

`_recordSearchDataVersion` increments on **every** `amino:record-updated` event (line 23672), even if the update is for a record not in the current filter results. This invalidates `_filterCache`, forcing a full re-scan of all records on the next pagination click.

**Effect:** Paginating through a 1000-record table during active sync takes ~500ms per page (re-filter + re-decrypt + re-render) instead of ~50ms (slice cached IDs + fetch page records).

### Problem: LRU Cache Uses Insertion Order, Not Access Order

`POST_HYDRATION_PERF_OPTIMIZATIONS.md:35`:
> When the in-memory record cache exceeds 2,000 entries, the code evicts the first 50% by insertion order... This is not LRU — it evicts based on `Object.keys()` order.

**Effect:** Switching between 2 tables with 1000+ records each causes constant cache thrashing. Table A records evicted when viewing Table B, Table B records evicted when switching back. Each switch requires re-reading and re-decrypting from IndexedDB.

### Problem: Formula Results Not Memoized Across Renders

Every call to `renderTable()` re-evaluates every formula on every displayed record. The code has a formula result cache (`_formulaResultCache`), but it's invalidated on every `amino:record-updated` event via `invalidateFormulaResultCache()` (line 23676), even if the updated record's inputs haven't changed.

---

## 7. Data Integrity Issues

### Issue: Sync Cursor Uses Local Clock

`ONBOARDING_DATA_SYNC_BUG_AUDIT.md:Problem E`: `webhookIncrementalSync()` sets the cursor to `new Date().toISOString()` (local time). If local time is ahead of server time, updates created during the request window are silently dropped.

### Issue: Partial Hydration Marked as Success

`ONBOARDING_DATA_SYNC_BUG_AUDIT.md:Problem C`: `hydrateFromWebhooks()` returns success if `totalRecords > 0`, even if some tables failed. Users see missing tables with no error indicator.

### Issue: Stale Deleted Records Survive Full Hydration

`ONBOARDING_DATA_SYNC_BUG_AUDIT.md:Problem D`: Table hydration writes current records but doesn't clear stale records. If a record was deleted upstream, the local copy persists.

### Issue: Consecutive-Failure Abort Skips Healthy Tables

`ONBOARDING_DATA_SYNC_BUG_AUDIT.md:Problem F`: Incremental sync aborts after 2 consecutive table failures. A transient issue on 2 adjacent tables blocks sync for all remaining tables.

---

## 8. Complete Issue Catalog

### CRITICAL (Breaks Core Functionality)

| # | Issue | Location | Impact |
|---|-------|----------|--------|
| C1 | Formulas silently skipped on large tables (>50K threshold) | `index.html:24587-24591` | Formula cells empty with no error |
| C2 | Lookup/rollup returns null when linked table not in memory | `index.html:24599-24607` | Empty relational fields |
| C3 | Interface has zero error boundaries | `index.html:33002, 33042, 33107` | Skeleton loader forever on any failure |
| C4 | Interface table name resolution silently fails | `index.html:30318-30360` | All blocks render empty |
| C5 | Formula runtime errors silently swallowed | `index.html:24943-24945` | Empty cells, no debugging info |
| C6 | Modern formula registry never wired into rendering | `src/formulas/bridge.js` | Best formula code unused |

### HIGH (Severe UX Degradation)

| # | Issue | Location | Impact |
|---|-------|----------|--------|
| H1 | LRU cache evicts by insertion order, not access time | `index.html:~8944` (per docs) | Cache thrashing on table switch |
| H2 | Every sync event triggers full DOM rebuild | `index.html:23654, 33927` | Visual flicker, scroll reset |
| H3 | Filter cache invalidated on every sync event | `index.html:23672` | 500ms pagination during sync |
| H4 | Overlay hides before hydration on first load | `index.html:19494` | Empty app shell for 5-60s |
| H5 | PBKDF2 600K iterations blocks main thread | `data-layer.js:75` | 500-1000ms freeze on login |
| H6 | Interface clears ALL caches on any record update | `index.html:33922-33924` | Full re-fetch + re-decrypt on sync |
| H7 | SessionKey loss shows login instead of unlock | `index.html:36300-36414` | "Random logout" perception |

### MEDIUM (Degraded Experience)

| # | Issue | Location | Impact |
|---|-------|----------|--------|
| M1 | Partial hydration marked as success | `hydration.js:750-797` | Missing tables, no indicator |
| M2 | Sync cursor uses local clock, not server cursor | `ONBOARDING_DATA_SYNC_BUG_AUDIT.md:E` | Silent data loss |
| M3 | META_FIELDS cleared by Database view | `index.html:16755-16757` | Interface field resolution breaks |
| M4 | Formula result cache cleared too aggressively | `index.html:23676` | Redundant formula re-evaluation |
| M5 | Stale deleted records survive hydration | `ONBOARDING_DATA_SYNC_BUG_AUDIT.md:D` | Ghost records |
| M6 | Consecutive sync failures skip healthy tables | `ONBOARDING_DATA_SYNC_BUG_AUDIT.md:F` | Tables fall behind on sync |
| M7 | Search index built lazily on first search | `data-layer.js:711-732` | Freeze on first search |

---

## 9. Recommended Fix Order

### Phase 1: Make Formulas Actually Work

**Goal:** Formula cells show computed values instead of being empty.

1. **Remove the 50K threshold guard** (`C1`). Replace with a per-formula timeout or compute formulas only for the visible page (currently computing for all records in the batch, but only displaying PAGE_SIZE). This alone will fix the majority of empty formula cells.

2. **Pre-load linked table data for lookups** (`C2`). Before `_applyRelationalColumns()`, scan the table's lookup/rollup fields, identify which linked tables are needed, and batch-load their records into `_recordCache`. Currently it only checks what's already cached — it should proactively fetch what's needed.

3. **Log formula errors to console** (`C5`). Replace the empty `catch(_e)` with `console.warn('[Formula]', c.fieldName, 'on record', rid, ':', _e.message)`. This gives developers visibility without breaking the UI.

4. **Wire the FormulaRegistry into the bridge** (`C6`). Export `FormulaRegistry`, `initializeFormulas()`, and `buildDataContext()` from `bridge.js`. Then replace `_applyFormulaColumns` with a call to the registry's `computeRecord()` method, which handles dependency ordering, cross-table lookups, and caching correctly.

### Phase 2: Fix the Interface View

**Goal:** Interface pages render with data instead of empty blocks or infinite skeleton.

5. **Add try-catch around renderPage** (`C3`). Wrap the entire rendering pipeline in error handling. On failure, replace skeleton with an error message and retry button.

6. **Fix table name resolution** (`C4`). When `_resolveTableId()` returns null, log a warning with the attempted name and available table names. Show a "Table not found" placeholder in the block instead of empty space.

7. **Don't clear META_FIELDS on table switch** (`M3`). The Database view's `delete META_FIELDS[currentTable]` at line 16757 breaks the Interface. Instead, let field metadata accumulate in memory (it's small — a few KB per table). Both views benefit from having complete field metadata.

8. **Don't clear ALL caches on sync** (`H6`). Only clear cache entries for the table that was updated, not every table.

### Phase 3: Fix Loading & Blank Screens

**Goal:** User always sees either content or a loading indicator, never a blank screen.

9. **Keep loading overlay visible until first table renders** (`H4`). On the new-device path, don't call `hideLoadingOverlay()` until `showTable(firstTable)` completes.

10. **Show unlock screen instead of login** (`H7`). When session is valid but sessionKey is lost, show a password-only unlock form instead of the full login screen.

11. **Move PBKDF2 to a Web Worker** (`H5`). The 600K iteration key derivation should happen off the main thread to avoid the login freeze.

### Phase 4: Fix Glitchy Rendering

**Goal:** Smooth, non-flickering UI during normal use.

12. **Fix LRU cache eviction** (`H1`). Use access-time tracking instead of insertion order. Use a `Map` (preserves insertion order + supports re-insertion on access) or maintain a parallel access-time list.

13. **Debounce sync re-renders properly** (`H2`). The 300ms debounce for cell updates exists but falls through to full `renderTable()` too often. Only do full re-render if new records appeared/disappeared; for existing records, always do targeted cell updates.

14. **Separate filter results from pagination** (`H3`). Once `getFilteredSortedRecords()` produces `currentRecordIds`, pagination should only `slice()` the cached array. Don't re-run filters on page change. Only invalidate when the user explicitly changes a filter/sort or a sync event touches a record in the current filter results.

15. **Scope formula cache invalidation** (`M4`). Only invalidate formula results for the specific record that was updated, not the entire table.

### Phase 5: Data Integrity

16. **Use server cursor for sync** (`M2`). Extract the max `updated_at` from the webhook response instead of using local clock.

17. **Return richer hydration result** (`M1`). Track per-table success/failure and show a "partial data" banner with retry.

18. **Clear stale records on full hydration** (`M5`). Delete existing records for a table before writing the fresh hydration batch.

---

## Appendix: Architecture Quick Reference

| Component | File | Lines | Role |
|-----------|------|-------|------|
| App shell + UI | `index.html` | 36,428 | Monolithic app (Database + Interface + Schema) |
| Data layer | `data-layer.js` | 2,380 | IndexedDB, encryption, caching, polling |
| Hydration | `hydration.js` | 1,366 | Multi-tier data download orchestration |
| Matrix client | `matrix.js` | 1,778 | Real-time sync via Matrix protocol |
| Formula parser | `src/formulas/parser.js` | ~400 | Tokenizer + recursive descent parser |
| Formula compiler | `src/formulas/compiler.js` | ~500 | AST → executable JS function |
| Formula registry | `src/formulas/registry.js` | ~350 | Per-table compilation + dependency ordering |
| Formula bridge | `src/formulas/bridge.js` | ~50 | Exposes formula engine to window scope |

### Global State Map

| Variable | Type | Location | Purpose |
|----------|------|----------|---------|
| `META_TABLES` | `{tableId: table}` | index.html | Table metadata |
| `META_FIELDS` | `{tableId: {fieldId: field}}` | index.html | Field metadata (cleared on table switch!) |
| `META_VIEWS` | `{tableId: {viewId: view}}` | index.html | View configurations |
| `IN_MEMORY_DATA` | `{tableId: {recordId: fields}}` | index.html | Session-only records (Box source) |
| `_recordCache` | `Map<key, record>` | index.html | LRU cache (2000 max, insertion-order eviction) |
| `_filterCache` | `{tableId: {key: ids}}` | index.html | Filtered record ID cache |
| `_compiledFormulaCache` | `{tableId: compiled}` | index.html | Compiled formula functions |
| `_formulaResultCache` | `{key: {inputHash, value}}` | index.html | Formula result memoization |
| `_tableDataCache` | `{tableId: records}` | index.html | Interface data cache (10s TTL) |
| `encryptionKey` | `CryptoKey` | index.html | AES-GCM key (in-memory only) |
| `_cryptoKey` | `CryptoKey` | data-layer.js | Same key, data-layer copy |
