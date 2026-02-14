# Data Flow: Interface vs Database View

Both views share the same underlying **data access layer** but diverge significantly in how they organize, filter, and present records.

## Shared Data Layer

Both Interface and Database views read from the same three-tier storage hierarchy:

1. **`IN_MEMORY_DATA`** (window global) — session-only records from CSV import
2. **IndexedDB** (`amino-data-layer`) — encrypted persistent store, hydrated from Postgres via `/amino-records`
3. **Remote API** — fallback when IndexedDB is unavailable

The two core shared functions are:

- **`getRecordIdsForTable(tableId)`** (`index.html:10613`) — merges record IDs from `IN_MEMORY_DATA` and IndexedDB's `by_table` index
- **`getRecordsByIds(tableId, recordIds)`** (`index.html:10730`) — checks an LRU cache (max 2000 records), then falls back to in-memory data, then IndexedDB with AES-GCM decryption

Both views also share formula computation via `_applyFormulaColumns()` (`index.html:24161`).

---

## Database View Data Flow

Entry point: **`showTable(tableId)`** (`index.html:16329`)

```
showTable(tableId)
  │
  ├─ Clean up: delete META_FIELDS[previousTable], reset record IDs, invalidate filter cache
  │
  ├─ Load in parallel:
  │    ├─ getFieldsForTable(tableId) → META_FIELDS[tableId]
  │    ├─ getViewsForTable(tableId) → META_VIEWS[tableId]
  │    └─ getRecordIdsForTable(tableId) → originalRecordIds
  │
  ├─ Apply view config: load filters/sorts/groupBy/colorBy from META_VIEWS
  │
  └─ renderTable()
       │
       ├─ Phase 0: Determine displayRecordIds
       │    └─ If filters/search active → getFilteredSortedRecords()
       │         ├─ Search pre-filter via _localSearchIndex (fast path)
       │         ├─ Filter: matchesFilterGroup() — nested AND/OR tree
       │         └─ Sort: multi-field compareValues()
       │
       ├─ Phase 1: Paginate (slice by PAGE_SIZE, cap at 500 if grouped)
       │
       ├─ Phase 2: getRecordsByIds() → fetch actual record data
       │
       ├─ Phase 3: Build HTML rows with formatCell()
       │    └─ DOM patching: diff cells if same page, full replace otherwise
       │
       └─ Phase 4: Deferred formula computation via requestAnimationFrame
            └─ Surgically update only formula cells after initial paint
```

**Key characteristics:**
- **Single table at a time** — navigating away frees `META_FIELDS` for the old table
- **Full CRUD** — inline editing, bulk operations
- **Complex filtering** — supports nested AND/OR condition groups via `matchesFilterGroup()`
- **Grouping & coloring** — `groupRecordsByField`, `buildColorMap`
- **View-driven** — configuration lives in `META_VIEWS` (from IndexedDB/Airtable view metadata)
- **State is imperative** — globals like `currentTable`, `currentView`, `currentFilters`, `currentSorts`, `currentGroupBy`

---

## Interface Data Flow

Entry point: **`InterfaceApp.init()`** (`index.html:29202`, init at ~33231)

```
InterfaceApp.init()
  │
  ├─ Load schema from Matrix room (law.firm.interface state event)
  │    └─ Falls back to DEFAULT_SCHEMA (index.html:29226)
  │
  ├─ Pre-warm: _preWarmClientData()
  │    └─ Find 'client info' table by name pattern, cache records early
  │
  ├─ Determine active page (filtered by visibleToRoles for user's role)
  │
  └─ renderPage(pageId) (index.html:32355)
       │
       ├─ Flatten blocks from containers/tabs
       │
       ├─ Pre-fetch all block data sources in parallel:
       │    └─ For each block.source:
       │         ├─ _resolveTableId(source) — pattern-match table name
       │         │    └─ Tries: exact → normalized → contains → fallback
       │         ├─ _getTableRecords(tableId) (index.html:29776)
       │         │    ├─ getRecordIdsForTable(tableId)
       │         │    ├─ getRecordsByIds(tableId, ids)
       │         │    ├─ Reload META_FIELDS if empty
       │         │    └─ Translate field IDs → field names on each record
       │         └─ Cache in _tableDataCache[tableId]
       │
       ├─ For each block: _renderBlock(block) (index.html:32463)
       │    ├─ Get records via _getSourceRecords()
       │    ├─ _applySegment() (index.html:29913):
       │    │    ├─ Search filter (tokenized AND via _ifaceSearchTextCache)
       │    │    ├─ Active dropdown filters (block._activeFilters)
       │    │    ├─ Static segment filter (isToday, isFutureOrToday, eq, contains)
       │    │    ├─ Sort (single field, asc/desc)
       │    │    └─ Limit
       │    └─ Render block by type (data-table, card-list, timeline, etc.)
       │
       └─ Register event listeners:
            ├─ amino:record-update → debounce 1000ms → clear cache + re-render
            ├─ amino:record-updated → debounce 400ms → clear cache + re-render
            └─ amino:sync → debounce 1000ms → clear cache + re-render
```

**Key characteristics:**
- **Schema-driven** — a JSON schema (stored in Matrix room) defines pages, blocks, columns, filters declaratively
- **Multi-table** — a single page can display blocks from different tables simultaneously
- **Table resolution by name pattern** — `_resolveTableId` matches `tableNamePattern` against `META_TABLES` names with fuzzy matching
- **Read-mostly** — blocks are primarily for display, not editing
- **Simple filtering** — flat operators (isToday, contains, eq) via segment definitions, no nested AND/OR
- **No grouping/coloring** — not supported in Interface blocks
- **Role-based access** — pages have `visibleToRoles` checked against the user's Matrix role
- **State is declarative** — the schema defines everything; runtime state is minimal (caches, pagination, search per block)

---

## Critical Difference: Field Metadata Handling

The Database view **deletes `META_FIELDS[previousTable]`** when navigating to a new table (`index.html:16342-16343`) to free memory. This means only one table's field metadata is in memory at a time.

The Interface **relies on `META_FIELDS` being populated for multiple tables simultaneously** since a single page can reference several tables. When `META_FIELDS[tableId]` is found empty (e.g., because the Database view cleared it), the Interface reloads it from IndexedDB via `getFieldsForTable(tableId)` (`index.html:29807-29862`). It also translates field IDs to field names on each record so that schema column references (which use human-readable names) work correctly.

---

## Summary

| Aspect | Database View | Interface |
|---|---|---|
| Config source | `META_VIEWS` (IndexedDB) | Schema JSON (Matrix room) |
| Tables shown | One at a time | Multiple per page |
| Table resolution | Direct `tableId` | Pattern matching on name |
| Editing | Full inline CRUD | Read-mostly display |
| Filtering | Nested AND/OR groups | Flat segment operators |
| Grouping/Coloring | Yes | No |
| Access control | App-level | Per-page role visibility |
| META_FIELDS lifecycle | Cleared on table switch | Reloaded on demand, kept for all referenced tables |
| Update handling | Immediate via listeners | Debounced (400-1000ms) cache clear + re-render |
