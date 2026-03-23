# Formula Fields — What's Been Tried

**Date:** 2026-03-23
**Scope:** Complete history of formula field work across PRs #386–#437 and the `src/formulas/` engine.

---

## Summary

Formula fields have been the single most worked-on problem in Amino. Across **12+ PRs** and **1,800+ lines of a purpose-built formula engine**, formula rendering remains unreliable because the project has two independent formula systems that were never connected. Every fix to date has patched the legacy system instead of wiring in the modern replacement.

---

## Timeline of Attempts

### PR #386 — Fix parse errors
- **What:** Fixed formula parse errors logged to console.
- **Result:** Reduced noise but didn't fix rendering.

### PR #402 — Webhook formula values
- **What:** Made webhook hydration include formula field values from Airtable's API response.
- **Result:** Formula values appeared on initial load, but disappeared on table switch or re-render because they were overwritten by local (failed) recomputation.

### PR #408 — Count, lookup, rollup computation
- **What:** Implemented `_computeCountField()`, `_computeLookupField()`, `_computeRollupField()` inline in `index.html`. Added support for resolving linked record IDs across tables.
- **Result:** Count fields worked. Lookups/rollups returned `null` when the linked table hadn't been visited yet (records not in cache).

### PR #415 — Fetch field_registry from Postgres
- **What:** Added `fetchFieldRegistry()` to pull field metadata (formula expressions, result types, link targets) from the `amino.field_registry` Postgres table before rendering.
- **Result:** Formula expressions became available. But rendering still failed because of the ID↔name mismatch (formulas reference `{Field Name}`, records store values under `fldXYZ`).

### PR #420 — Fix refresh + formula computation
- **What:** Ensured formula computation runs after page refresh by calling `_applyFormulaColumns()` in the post-hydration path.
- **Result:** Formulas computed on refresh. Still failed on table switch.

### PR #430 — Compute inline before render
- **What:** Moved `_applyFormulaColumns()` call to run synchronously before DOM render instead of in `requestAnimationFrame`.
- **Result:** Fixed the race condition where formulas computed after the DOM was already built. But formulas that referenced field names still failed because META_FIELDS wasn't fully populated.

### PR #433 — Formula debug panel
- **What:** Added a collapsible debug panel to `renderTable()` showing each formula field's expression, parsed options, and computed values.
- **Result:** Diagnostic only. Revealed that many formulas had `undefined` expressions and `null` computed values.

### PR #434 — Bridge `def:fld*` records into META_FIELDS
- **What:** Detected that field definition records (`def:fldXYZ`) were being stored as regular data records. Added logic to extract them and populate `META_FIELDS[tableId]` options (formula expression, result type, linked table IDs).
- **Result:** META_FIELDS got populated with formula definitions. But the field ID↔name translation still broke because the alias map wasn't built.

### PR #435 — Field alias map for ID↔name resolution
- **What:** Built a bidirectional alias map (`fieldId → fieldName`, `fieldName → fieldId`) so formulas written as `{Field Name}` could resolve to the correct record property key (`fldXYZ`).
- **Result:** Partial fix. Worked for simple formulas. Failed for nested references, lookup targets, and formulas that used field names not yet in the alias map at compile time.

### PR #436 — Reconcile META_FIELDS naming duality
- **What:** Added a multi-layer fix: (1) populate field names from Airtable metadata, (2) try both ID and name when resolving formula references, (3) fall back to raw field ID if name not found.
- **Result:** More formulas rendered. Still failed for: rollups referencing fields in other tables, formulas on large tables (hit the skip threshold), and any formula whose runtime threw an error (silently caught).

### PR #437 — Fix expression loading, field resolution, cell formatting
- **What:** Ensured `fetchFieldRegistry()` completes before render. Fixed cell formatting for formula results (numbers, dates, currency). Added `formula-readonly` CSS class.
- **Result:** Best state yet — most simple formulas render. Remaining failures are architectural.

---

## The Two Formula Engines

### Legacy system (in use) — `index.html:25029–25662`

The currently active system. ~600 lines of inline JavaScript.

| Component | How it works | Problem |
|-----------|-------------|---------|
| `_applyFormulaColumns()` | Iterates fields, parses formulas with regex, evaluates with `new Function()` | Fragile regex parsing, no dependency ordering, no cross-table resolution |
| `_shouldSkipFormulaColumns()` | Skips all formulas when `records × formulas > 500K` (was 50K before PR #437) | Silent skip — no user feedback, no partial computation |
| `_getLinkedRecordFields()` | Looks up linked records in `IN_MEMORY_DATA` and `_recordCache` | Returns `null` if linked table not visited — lookups/rollups fail silently |
| `_preloadLinkedTableRecords()` | Fetches missing linked records before formula eval | Added in PR #408, but async — formula eval often runs before preload completes |
| `_formulaResultCache` | Memoizes results keyed by `tableId\|recordId\|fieldId` | Invalidated too aggressively (entire record cleared on any field change) |
| Error handling | `catch(_e) { /* leave cell empty */ }` | Silent — no console warning, no UI indicator, no way to debug |

### Modern engine (built, not wired in) — `src/formulas/`

A complete, well-tested formula engine. ~1,800 lines across 8 modules with ~1,250 lines of tests.

| Module | What it does | Status |
|--------|-------------|--------|
| `parser.js` (340 lines) | Recursive descent parser: tokenizer → AST. Handles field refs, strings, numbers, operators, function calls. | Complete, tested |
| `compiler.js` (385 lines) | AST → executable JS function. Includes 60+ Airtable formula functions (math, text, date, logical, array). | Complete, tested |
| `registry.js` (380 lines) | `FormulaRegistry` class: loads field definitions, builds dependency graph, topological sort, compiles in order, computes all formula values for a record. | Complete, tested |
| `eo-ir.js` (347 lines) | Epistemic-Ontological Intermediate Representation: provenance tracking for formulas, lookups, rollups. | Complete, tested |
| `relational-compiler.js` (117 lines) | Lookup and rollup compilation with full aggregation support (SUM, MAX, MIN, AVERAGE, COUNT, etc.). | Complete, tested |
| `integration.js` (189 lines) | Application bridge: converts META_FIELDS to registry entries, builds cross-table data context, exposes `initializeFormulas()` and `computeRecordFormulas()`. | Complete, **not called** |
| `ui.js` (181 lines) | Cell formatting, epistemic status dots, formula bar HTML, provenance display. | Complete, **not called** |
| `bridge.js` (17 lines) | Exposes engine to `window._formulaEngine`. Only exports `parseAirtableFormula`, `collectFieldRefs`, `compileFormula`. | **Incomplete** — missing `FormulaRegistry`, `initializeFormulas`, `computeRecordFormulas` |

### Database schema (deployed)

`amino.field_registry` table stores formula definitions, result types, and link targets. Migration `002_add_field_registry_options.sql` deployed. Indexes on `(table_id, is_computed)`.

---

## What Still Fails and Why

### 1. Modern engine not wired into rendering
- `bridge.js` only exposes 3 low-level functions. `FormulaRegistry`, `initializeFormulas()`, and `computeRecordFormulas()` are not accessible from `index.html`.
- The legacy `_applyFormulaColumns()` is still the only formula path called during render.

### 2. Silent skip on large tables
- `_shouldSkipFormulaColumns()` returns `true` when `records × formulas > 500K`.
- No user-facing indication. Cells just show empty/dash.

### 3. Lookups/rollups fail when linked table isn't cached
- `_getLinkedRecordFields()` returns `null` if the linked table's records aren't in `IN_MEMORY_DATA` or `_recordCache`.
- `_preloadLinkedTableRecords()` is async but formula eval doesn't always await it.

### 4. META_FIELDS ID↔name fragility
- Records store values by field ID (`fldXYZ`). Formulas reference by name (`{Client Name}`).
- The alias map built in PR #435 works for most cases but breaks when field names aren't yet loaded or when fields exist in linked tables.

### 5. Errors silently swallowed
- `catch(_e) { /* leave cell empty */ }` in the legacy eval path.
- No console output, no cell indicator, no way for users or developers to know a formula failed.

### 6. Network-blocking field registry fetch
- Every table switch requires a 200–500ms `fetchFieldRegistry()` call.
- Formula rendering is blocked until this completes.

---

## What Would Actually Fix It

Wire the modern `FormulaRegistry` into the rendering pipeline and retire `_applyFormulaColumns()`. Specifically:

1. **Expand `bridge.js`** to expose `FormulaRegistry`, `initializeFormulas()`, `buildDataContext()`, and `computeRecordFormulas()`.
2. **Replace `_applyFormulaColumns()`** with a call to `initializeFormulas()` → `computeRecordFormulas()` for each record.
3. **Remove `_shouldSkipFormulaColumns()`** — the modern engine's dependency graph and caching handle scale correctly.
4. **Use the modern engine's error reporting** instead of silent catch blocks.
5. **Pre-initialize the registry** on table switch (can reuse `fetchFieldRegistry()` data) so formulas are ready before render.

This is one architectural change, not another patch. Every sub-issue traces back to the legacy system being used instead of the modern one.
