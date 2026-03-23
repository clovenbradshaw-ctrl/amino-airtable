# Database UX & Interface: Development Report

**Date:** 2026-03-23
**Scope:** Full analysis of the Amino Airtable database user experience, interface layer development, and outstanding issues across 120+ commits and 60+ merged PRs.

---

## Executive Summary

Amino Airtable is an encrypted, offline-capable immigration case management client that reads from IndexedDB (AES-GCM-256 at rest), syncs via n8n webhooks and Matrix real-time events, and is designed to fully decouple from Airtable. The application provides three distinct interfaces — **Database View** (grid/table CRUD), **Interface App** (multi-table dashboard/page builder), and **Forms App** (data entry builder) — all served from a single 38,000-line `index.html`.

Despite significant investment (120 commits, 60+ PRs, 7 architecture documents, and 1,800+ lines of purpose-built formula engine code), **the database UX remains unstable**. Of 20 documented persistent issues, **0 are fully resolved**, 5 are partially fixed, and 15 remain unfixed. The root causes are architectural — not surface-level — and repeated patch-level fixes have failed to address them.

---

## 1. Architecture Overview

### Data Flow

```
Airtable (periodic) → n8n Workflows → PostgreSQL (amino.current_state)
                                              ↓
                    ┌─────────────────────────┼─────────────────────┐
                    ↓                         ↓                     ↓
            Box Bulk Export        n8n HTTP APIs          Matrix Events
            (box-download)       (/amino-records)        (real-time sync)
                    ↓                         ↓                     ↓
                    └─────────────────────────┼─────────────────────┘
                                              ↓
                              Client Browser (data-layer.js)
                                              ↓
                    Hydration │ Matrix Sync │ HTTP Polling (15s)
                                              ↓
                    AES-GCM Encrypt → IndexedDB → In-Memory Cache
```

### Three-Tier Storage Hierarchy

| Tier | Source | Purpose |
|------|--------|---------|
| 1. `IN_MEMORY_DATA` | CSV import | Session-only records |
| 2. IndexedDB (`amino-data-layer`) | Postgres via webhooks | Encrypted persistent store (records, tables, sync cursors, pending mutations) |
| 3. Remote API | `/amino-records` endpoints | Fallback when IndexedDB unavailable |

### Two Distinct View Architectures

| Aspect | Database View | Interface App |
|--------|---------------|---------------|
| Entry point | `showTable(tableId)` | `InterfaceApp.init()` |
| Config source | META_VIEWS (IndexedDB) | Schema JSON (Matrix room) |
| Tables shown | One at a time | Multiple per page |
| Table resolution | Direct tableId | Fuzzy name pattern matching |
| Editing | Full CRUD, inline editing | Read-mostly |
| Filtering | Nested AND/OR groups | Flat segment operators |
| Grouping/Coloring | Yes | No |
| Access control | App-level | Per-page role visibility |
| META_FIELDS lifecycle | **Cleared on table switch** | Reloaded on demand, kept for all |

The critical architectural tension: **Database View deletes `META_FIELDS` for the previous table on navigation** (memory efficiency for single-table use), while **Interface App relies on `META_FIELDS` for multiple tables simultaneously**. This causes cascading failures when users switch between views.

---

## 2. Development History & Evolution

### Major Development Phases

**Phase 1: Foundation (PRs #381–#390)**
Established core database grid with IndexedDB instant-load, loading/sync state indicators, online-only mode, lookup/rollup field highlighting, date field formatting, forms sub-app, Airtable sync webhooks, and 5 Airtable-style UX improvements.

**Phase 2: Data Pipeline Hardening (PRs #391–#410)**
Migrated data sources — removed Matrix as record storage layer, moved to exclusive Postgres hydration, added hydration source picker (CSV, Postgres, Box, URL), extracted hydration into standalone module. Fixed Postgres hydration (0-record bug, auth flow, display issues, schema metadata filtering). Added record history via Postgres events API.

**Phase 3: Interface & UX (PRs #411–#425)**
Built Interface App with multi-table dashboard support. Fixed data flow unification between Database and Interface views. Added CRM interface preferences. Addressed login/session issues (syntax errors, try/catch fixes, Phosphor icon migration). Fixed client profile display, auto-refresh polling.

**Phase 4: Formula Field Saga (PRs #426–#439)**
12+ PRs attempting to make formula fields render correctly. Built modern formula engine (parser, compiler, registry, EO-IR translator — 1,800+ lines) but never fully wired it in. Each PR fixed one failure mode while leaving the architectural root cause untouched.

### Key Metrics

| Metric | Value |
|--------|-------|
| Total commits | 120+ |
| Merged PRs | 60+ |
| Architecture documents | 7 |
| Formula fix attempts | 12+ PRs |
| Persistent issues documented | 20 |
| Issues fully resolved | 0 |
| Issues partially resolved | 5 |
| Issues still unfixed | 15 |

---

## 3. Critical Issues Analysis

### 3.1 Formula Rendering (8+ fix attempts — UNFIXED)

**The Problem:** Two independent formula engines exist but were never connected.

**Legacy System** (in use, ~600 lines in `index.html`):
- Regex-based parsing, `new Function()` evaluation
- No dependency ordering, no cross-table resolution
- Silently skips computation when `records × formulas > 500K` (no user feedback)
- `_getLinkedRecordFields()` returns null if linked table not visited
- All errors silently swallowed: `catch(_e) { /* leave cell empty */ }`

**Modern Engine** (built but not wired, ~1,800 lines in `src/formulas/`):
- Complete tokenizer → AST parser (340 lines)
- Full compiler with 60+ Airtable functions (385 lines)
- `FormulaRegistry` with dependency graph and topological sort (380 lines)
- EO-IR provenance tracking (347 lines)
- Cross-table lookup/rollup resolution (117 lines)
- Integration and UI layers (370 lines)
- **Bridge file is incomplete** — only exports 3 low-level functions, missing `FormulaRegistry`, `initializeFormulas`, `computeRecordFormulas`

**PR History:**

| PR | Attempt | Result |
|----|---------|--------|
| #386 | Fix parse errors | Reduced noise, didn't fix rendering |
| #402 | Include formula values from Airtable API | Appeared initially, disappeared on table switch |
| #408 | Count/lookup/rollup computation | Count worked; lookups null when linked table not visited |
| #415 | Fetch field_registry from Postgres | Expressions available but ID↔name mismatch |
| #420 | Formula computation after refresh | Worked on refresh, failed on table switch |
| #430 | Compute inline before render | Race condition fixed, META_FIELDS incomplete |
| #433 | Formula debug panel | Diagnostic only |
| #434 | Bridge def:fld* into META_FIELDS | Definitions populated, ID↔name translation broken |
| #435 | Field alias map for ID↔name | Partial fix, broke on nested references |
| #436 | Reconcile META_FIELDS naming duality | More formulas rendered, rollups and large tables still fail |
| #437 | Fix expression loading, field resolution | Best state yet, architectural limits remain |

**Root Cause:** Every fix patched the legacy system instead of wiring in the modern replacement. This is one architectural change, not another incremental patch.

### 3.2 Interface View Reliability (UNFIXED)

Six independent failure modes:

1. **Schema table name resolution fails** — fuzzy matching across 4 strategies; if a table is renamed, all blocks return empty with no error
2. **Zero error boundaries** — any throw (network, IDB, decryption, missing property) aborts rendering; skeleton loader stays forever
3. **META_FIELDS cleared by Database View** — switching from Interface to Database and back breaks field ID resolution for multi-table pages
4. **Data cache 10-second TTL** — cache expires mid-render causing inconsistent data across blocks on the same page
5. **Sync events trigger full page re-render** — every `amino:record-updated` event clears ALL caches and schedules complete `renderPage()`
6. **Formula failures cascade** — Interface calls `_applyFormulaColumns()`, inheriting every formula bug

### 3.3 Data Sync Integrity (UNFIXED)

| Issue | Impact |
|-------|--------|
| Sync cursor uses local clock | Silent data loss if local time is ahead of server |
| Partial hydration marked as success | Missing tables with no indicator to the user |
| Deleted records survive full hydration | Ghost records appear in grids |
| Consecutive-failure abort | Skips healthy tables after N failures |

### 3.4 Performance & Blank Screens (PARTIALLY FIXED)

| Scenario | Duration | Root Cause |
|----------|----------|------------|
| PBKDF2 key derivation | 500–1000ms freeze | 600K iterations on main thread |
| After overlay hides (first login) | 5–60s blank | Overlay dismissed before hydration completes |
| During hydration | 5–60s | `onProgress` fires per-table, not per-record |
| Browser restart | 200–800ms | SessionKey lost → falls through to full login |
| Table switch field registry fetch | 200–500ms block | Network-blocking `fetchFieldRegistry()` |
| Record decryption cache miss | 100–500ms | LRU eviction forces IDB re-reads |
| Interface failed fetch | **Indefinite** | No error handling, skeleton never replaced |

**LRU Cache Bug:** The 2,000-record cache uses insertion order, not access time. Switching between two large tables causes constant re-decryption (100–200ms per switch).

### 3.5 Login & Session (PARTIALLY FIXED)

- Session-valid users shown full login screen instead of unlock (SessionKey lost on browser restart)
- Legacy API-key auth controls still visible
- Room membership failures not surfaced to user

### 3.6 UX & Rendering Glitches (PARTIALLY FIXED)

- **Full DOM destruction on sync** — `innerHTML` replacement causes flicker, scroll reset, loss of hover/focus state
- **Filter cache thrashing** — `_recordSearchDataVersion` increments on every record update, even unrelated ones
- **Formula result cache over-invalidation** — entire table cleared on any record update, even when formula inputs are unchanged
- **Aggressive filter cache invalidation** — filters recomputed unnecessarily

---

## 4. Domain-Specific UX Gaps

### Immigration Casework Misalignment

The current UI is **table-first** when immigration caseworkers think **matter-first**. Key gaps identified in the CRM UI Replacement Gap Analysis:

| Gap | Impact |
|-----|--------|
| No matter-centric workspace | Users must manually navigate across tabs to reconstruct case context |
| No at-a-glance legal triage | Missing visibility into next hearing, SLA-risk deadlines, case stage, document completeness |
| Non-actionable error/empty states | Generic "Something went wrong" with no operational recovery path |
| Navigation overload | Too many primary actions at equal visual weight creates decision friction |
| Fragmented timeline | Activities, hearings, case notes, communications split across separate panels |
| Low visibility for legal-specific data | Dependents/family graph, filing checklists, court milestones, venue transitions under-surfaced |

### Proposed IA Restructuring

**Current:** Table-driven navigation (sidebar of database tables)

**Target:**
- Global Nav: Home, Clients, Matters, Calendar, Communications, Tasks
- Client Workspace Tabs: Overview (risk-focused), Matters, Timeline (unified), Documents, Deadlines, Contacts/Family, Applications & Filings

**Priority new components:**
1. Critical Date Stack — today/7-day/30-day grouped cards with severity colors
2. Case Health Score — derived from deadline proximity, stale communications, missing documents
3. Unified Timeline — notes + events + communications in one filterable stream
4. Related Individuals Graph — family relationships visualized

---

## 5. Engineering Debt

### Structural Issues

| Issue | Severity | Notes |
|-------|----------|-------|
| Monolithic 38,000-line `index.html` | High | All three apps (Database, Interface, Forms) in one file |
| Inline event handlers | Medium | Blocks CSP adoption |
| Direct webhook URL exposure | Medium | Client-side code contains webhook endpoints |
| No structured logging | Medium | `console.log` throughout; no levels, no redaction |
| No build pipeline | Medium | No bundler, linter, or module system |
| Two formula engines | High | Parallel systems doing the same job |
| Global mutable state | High | `META_TABLES`, `META_FIELDS`, `META_VIEWS`, `_recordCache` as globals |
| Browser `alert()`/`confirm()`/`prompt()` | Medium | Accessibility blocker; no custom modals |
| Zoom lock enabled | Low | Accessibility violation |

### Accessibility Blockers

1. Zoom lock prevents text scaling (WCAG 1.4.4 violation)
2. Browser dialogs (`alert`/`confirm`/`prompt`) not keyboard-accessible or screen-reader-compatible
3. Inline editing relies on mouse interactions without keyboard alternatives in some cases

---

## 6. What Has Worked Well

Despite the issues, several things were executed effectively:

1. **Encryption at rest** — AES-GCM-256 with PBKDF2 (600K iterations) properly implemented
2. **Offline write queue** — mutations queued in IndexedDB and flushed when online
3. **Hydration architecture** — modular, configurable (Postgres/CSV/Box/URL), with deduplication
4. **Postgres migration** — successful removal of Matrix as record storage (PRs #400–#401)
5. **IndexedDB instant-load** — returning users see data in <1s on page refresh
6. **Formula engine design** — the modern `src/formulas/` engine is well-architected with parser, compiler, registry, and dependency resolution; it just needs to be connected
7. **View system** — filters, sorts, grouping, and coloring all implemented in Database View
8. **Real-time sync** — Matrix events provide live updates (even if re-rendering is too aggressive)

---

## 7. Recommended Fix Priorities

### Tier 1: Architectural Fixes (Resolve Cascading Failures)

| # | Fix | Issues Resolved | Effort |
|---|-----|----------------|--------|
| 1 | **Wire modern FormulaRegistry into rendering pipeline** | 6 formula sub-issues, Interface formula cascade | Medium |
| 2 | **Fix sync cursor to use server timestamp** | Silent data loss on clock skew | Low |
| 3 | **Add error boundaries to Interface `renderPage()`** | Indefinite skeleton, cascading failures | Low |
| 4 | **Stop clearing META_FIELDS on table switch** (scope to Database View only) | Interface multi-table breakage | Low |

### Tier 2: Targeted Fixes (User-Facing Impact)

| # | Fix | Issues Resolved | Effort |
|---|-----|----------------|--------|
| 5 | Fix LRU cache to use access-time eviction | 100–200ms table switch penalty | Low |
| 6 | Scope cache invalidation to affected table only | Filter thrashing, formula over-invalidation, sync flicker | Medium |
| 7 | Move PBKDF2 to Web Worker | 500–1000ms main thread freeze | Low |
| 8 | Show unlock screen when session valid but key lost | False "logged out" perception | Low |
| 9 | Keep loading overlay until first render completes | 5–60s blank screen on first login | Low |

### Tier 3: UX & Domain Alignment

| # | Fix | Impact | Effort |
|---|-----|--------|--------|
| 10 | Replace browser dialogs with accessible modals | Accessibility compliance | Medium |
| 11 | Remove zoom lock | WCAG 1.4.4 compliance | Trivial |
| 12 | Add actionable error/empty states | User recovery from failures | Medium |
| 13 | Implement Client Overview with risk-first layout | Casework efficiency | High |
| 14 | Unify timeline across notes/events/communications | Chronology reconstruction | High |

### Tier 4: Engineering Quality

| # | Fix | Impact | Effort |
|---|-----|--------|--------|
| 15 | Modularize `index.html` into separate files | Maintainability, testability | High |
| 16 | Add structured logging with levels and redaction | Debuggability, security | Medium |
| 17 | Move webhook URLs behind server-managed routes | Security hardening | Medium |
| 18 | Remove inline event handlers for CSP | Security | Medium |

---

## 8. Conclusion

The Amino Airtable database UX has significant investment behind it — a well-designed encryption layer, a complete modern formula engine, configurable hydration, and working offline support. However, the user experience is undermined by **architectural disconnects** rather than missing features. The most impactful issues — formula rendering, Interface view reliability, and data sync integrity — all trace back to the same patterns: two parallel systems not integrated, silent error handling, and global state invalidation.

The highest-leverage fix is **completing the bridge between the modern formula engine and the rendering pipeline** — a single architectural change that resolves 6+ documented issues across both Database and Interface views. Combined with error boundaries, scoped cache invalidation, and the sync cursor fix, these 4 changes would address the majority of the 20 persistent issues.

The domain-specific UX gaps (matter-first navigation, risk-first triage, unified timeline) represent the next horizon of investment once the stability foundation is in place.
