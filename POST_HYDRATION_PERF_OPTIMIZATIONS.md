# Post-Hydration Performance Optimizations

Five targeted optimizations to reduce latency when navigating the app after hydration completes (i.e., after logging back into a local instance and moving between tables/views/pages).

---

## 1. Debounce & Batch Sync-Triggered Re-renders

**Location:** `index.html:20672-20715` — `amino:record-updated` event listener

**Problem:** Every incoming Matrix sync event that touches the current table triggers a full `renderTable()` call (line 20713). This destroys the entire table DOM via `innerHTML`, re-fetches records, re-applies filters, re-evaluates formulas, and rebuilds the HTML string — all while the user is actively navigating. If 10 records update in a 1-second burst, the table re-renders 10 times.

**Fix:** Debounce the re-render. Collect record-update events over a short window (e.g., 300ms), then apply a single batched re-render. For updates to records visible on the current page, do targeted cell DOM updates instead of a full table rebuild — the inline-edit path (lines 20688-20709) already demonstrates this pattern but only activates after local edits.

**Impact:** Eliminates the most jarring runtime disruption — tables flickering/jumping during navigation when background sync is active. Reduces redundant renders from N-per-burst to 1.

---

## 2. Memoize Formula Results by Input Hash

**Location:** `index.html:21249-21376` — `_applyFormulaColumns()`

**Problem:** Every call to `renderTable()` re-evaluates every formula on every displayed record (lines 21350-21374). For a grouped view with 500 records and 10 formula fields, that's 5,000 formula evaluations per render — and the results are never cached. Navigating to the same page again repeats all the work. The compiled formula ASTs are cached (line 21286), but the computed *values* are not.

**Fix:** Add a formula result cache keyed by `recordId + fieldId + hash(input field values)`. Before evaluating a formula, check if the record's input fields have changed since last evaluation. If not, return the cached value. Invalidate per-record entries when `amino:record-updated` fires for that record.

**Impact:** After the first render of a page, subsequent re-renders (pagination back, filter toggles, sync-triggered refreshes where most records didn't change) skip formula evaluation entirely. Reduces O(records x formulas) to O(changed_records x formulas).

---

## 3. LRU Cache Eviction Instead of 50% Purge

**Location:** `index.html:8940-8949` — `getRecordsByIds()` cache eviction

**Problem:** When the in-memory record cache exceeds 2,000 entries, the code evicts the first 50% by insertion order (line 8944: `cacheKeys.slice(0, Math.floor(cacheKeys.length / 2))`). This is not LRU — it evicts based on `Object.keys()` order, which penalizes records from tables the user visited recently. When navigating between 2-3 tables, this causes **cache thrashing**: Table A's records get evicted when loading Table B, then Table B's records get evicted when navigating back to Table A, forcing re-decryption from IndexedDB every time.

**Fix:** Replace with an LRU strategy using access-time tracking. On cache hit, update the record's last-access timestamp. On eviction, remove the least-recently-accessed entries. A simple approach: maintain a parallel array of cache keys ordered by access time (or use a `Map` which preserves insertion order and supports re-insertion on access).

**Impact:** Navigating back to a previously-viewed table serves records from memory instead of re-decrypting from IndexedDB. Eliminates the ~100-200ms decryption overhead on back-navigation for the most common multi-table workflow.

---

## 4. Skip Filter Re-evaluation on Same-Table Pagination

**Location:** `index.html:14446-14454` — `renderTable()` filter path, and `index.html:22553-22639` — `getFilteredSortedRecords()`

**Problem:** The filter cache (`_filterCache`) works when the cache key matches exactly (line 22558), but `renderTable()` is called for pagination changes too — and each call to `renderTable()` invokes `getFilteredSortedRecords()` which must verify the cache key by serializing the entire filter/sort configuration via `JSON.stringify` (line 22546). More critically, the cache is invalidated by `_recordSearchDataVersion` which increments on *every* `amino:record-updated` event (line 20676), meaning a single background sync event invalidates the filter cache and forces a full re-scan of all records on the next page change — even though the page change itself requires only a different `slice()` of the already-computed `currentRecordIds`.

**Fix:** Separate the filter result (`currentRecordIds`) from the page-slice logic. Once `getFilteredSortedRecords()` has produced the filtered ID list, pagination should only call `getRecordsByIds(currentTable, currentRecordIds.slice(page * PAGE_SIZE, ...))` without re-running the filter pipeline. Only re-run filters when the user explicitly changes a filter, sort, search, or when a sync event touches a record in the current table. Use a dirty flag instead of `_recordSearchDataVersion` incrementing on every event.

**Impact:** Pagination goes from ~500ms (re-filter + re-fetch + re-decrypt + re-render) to ~50ms (slice cached IDs + fetch page records from memory cache). This is the single biggest perceived-latency win for table navigation.

---

## 5. Targeted DOM Updates for Visible-Row Sync Events

**Location:** `index.html:14657-14660` — `renderTable()` DOM replacement

**Problem:** The entire table DOM is destroyed and recreated on every render via `tableContainer.innerHTML = '<table>...'` (line 14658) followed by `tableEl.innerHTML = html` (line 14660). For a 100-row page with 20 columns, this creates ~2,000+ DOM nodes from a string, triggers a full layout recalculation, and discards all existing nodes (including any the browser had optimized). The inline-edit code path (lines 20688-20709) already shows that targeted cell updates work — but it's only used for self-initiated edits.

**Fix:** For re-renders where the page hasn't changed (same `currentPage`, same `displayRecordIds`), diff the new data against the currently displayed data and update only changed cells. Build a simple "current state" map from the DOM (`tr[data-record-id]` -> cell values) and compare with new `recordMap`. Only call `cell.innerHTML = formatCell(newValue)` on cells where the value actually changed. Reserve full innerHTML replacement for actual page/table changes.

**Impact:** Sync-triggered re-renders drop from ~200-500ms (full DOM rebuild) to ~5-20ms (update only changed cells). Eliminates the visible table flicker that occurs when background sync events arrive during navigation.

---

## Priority Order for Implementation

| # | Optimization | Effort | Impact | Risk |
|---|---|---|---|---|
| 4 | Skip filter re-eval on pagination | Low | Very High | Low |
| 1 | Debounce sync re-renders | Low | High | Low |
| 5 | Targeted DOM cell updates | Medium | High | Medium |
| 3 | LRU cache eviction | Low | Medium-High | Low |
| 2 | Formula result memoization | Medium | Medium | Medium |

Start with #4 and #1 — they're low-effort, low-risk, and address the two most common user-facing slowdowns (page changes and sync flicker). #5 and #3 follow for compounding gains. #2 is worthwhile for formula-heavy tables but requires careful invalidation logic.
