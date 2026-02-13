# Schema Workbench: GIVEN / MEANT Redesign

## Problem Statement

The current Schema Workbench mixes two fundamentally different concerns into one flat interface:

1. **Forms (FormsApp)** — standalone form builder for data entry, but disconnected from the schema's epistemic model
2. **Interface (InterfaceApp)** — page/block editor for views, but treats everything as one monolithic schema blob

There's no visible concept of **GIVEN** vs **MEANT** in the UI. Users can't see the boundary between "what data are we collecting?" and "what are we trying to report/derive?" The two sides don't connect visually or structurally.

---

## Core Concept: Two-Panel Workbench

Split the Schema Workbench into two co-visible halves that meet in the middle:

```
┌─────────────────────────────┬─────────────────────────────┐
│         GIVEN               │           MEANT             │
│   "What we observe"         │    "What we report"         │
│                             │                             │
│  ┌───────────────────────┐  │  ┌───────────────────────┐  │
│  │ Observation Forms     │  │  │ Reporting Frameworks  │  │
│  │ (data entry schemas)  │  │  │ (derived views)       │  │
│  └───────────────────────┘  │  └───────────────────────┘  │
│                             │                             │
│  Each form defines:         │  Each framework defines:    │
│  - Which table it feeds     │  - Which tables it reads    │
│  - Which fields are asked   │  - Which fields it derives  │
│  - Field labels/help/req    │  - Formulas / rollups       │
│  - Validation rules         │  - Display columns/filters  │
│  - Conditional logic        │  - Aggregations / charts    │
│                             │                             │
├──────────────── ↕ ──────────┤                             │
│         CONNECTION MAP      │                             │
│  "How given feeds meant"    │                             │
│                             │                             │
│  Form Field A ──→ Derived X │                             │
│  Form Field B ──→ Derived Y │                             │
│  Form Field C ─┬→ Derived Z │                             │
│                └→ Derived W │                             │
└─────────────────────────────┴─────────────────────────────┘
```

---

## Proposal A: Unified Workbench View

### Layout: Side-by-side panels with a connection gutter

**Left Panel — GIVEN (Observation Questions)**

Replace the current `FormsApp` list/builder with a structured observation registry:

1. **Form Groups by Table** — Instead of a flat card grid, group forms by their source table. Each table becomes an expandable section showing all forms that feed it.

2. **Field-Level Visibility** — Each form shows its fields inline (not hidden behind a builder click-through). You can see at a glance: "Client Intake Form asks for Name, DOB, A#, Country, Phone."

3. **Epistemic Annotations** — Each field gets a small tag: `GIVEN` (user enters it), `PREFILLED` (auto-populated from linked record), `CONDITIONAL` (shown based on other answers). This makes the data provenance visible.

4. **Collaborative Indicators** — Show who's editing each form, last-modified-by, and a lightweight comment thread per field ("Should we ask for SSN here?" / "No, only on the I-589 form").

**Right Panel — MEANT (Reporting Frameworks)**

Replace the current flat Interface schema editor with a structured reporting registry:

1. **Report Groups by Purpose** — Group derived views by what they're for: "Case Status Dashboard", "Hearing Calendar", "Client Demographics Report".

2. **Column/Metric Definitions** — Each report shows its columns inline. For derived columns, show the formula source: `Age = DATETIME_DIFF({Biometrics Date}, {DOB}, "years")` with the source fields highlighted.

3. **EO Chain Visualization** — For each derived field, show the operator chain: `DES(DOB) → ALT(DATETIME_DIFF) → Age`. This makes the transformation pipeline visible.

4. **Coverage Indicators** — Show which GIVEN fields are actually consumed by reports (green = used, gray = collected but unused, red = report expects field that no form collects).

**Center Gutter — Connection Map**

The gutter between panels shows data flow:

1. **Lines connecting GIVEN → MEANT** — Visual lines from form fields on the left to report columns on the right. Hover a form field to highlight all reports that consume it. Hover a report column to highlight all forms that feed it.

2. **Gap Detection** — If a report column references a field that no active form collects, show a warning: "This report needs `Biometrics Date` but no published form asks for it."

3. **Redundancy Detection** — If two forms collect the same field into the same table, show a note: "Both 'Client Intake' and 'Quick Add' ask for `Phone Number`."

---

## Proposal B: Tabbed Workbench with Linkage View

If side-by-side is too cramped, use three tabs:

### Tab 1: GIVEN — Form Registry

A redesigned form list that foregrounds the epistemic role:

```
┌─────────────────────────────────────────────────────────┐
│ GIVEN: Observation Forms                    [+ New Form]│
├─────────────────────────────────────────────────────────┤
│                                                         │
│ ┌─ Client Info Table ─────────────────────────────────┐ │
│ │                                                     │ │
│ │  📋 Client Intake Form          Published  12 fields│ │
│ │     Name*, DOB*, A#*, Country*, Phone, Email, ...   │ │
│ │     → feeds: Case Dashboard, Demographics Report    │ │
│ │                                                     │ │
│ │  📋 Quick Client Add            Draft      4 fields │ │
│ │     Name*, Phone*, A#                               │ │
│ │     → feeds: Case Dashboard                         │ │
│ │                                                     │ │
│ └─────────────────────────────────────────────────────┘ │
│                                                         │
│ ┌─ Events Table ──────────────────────────────────────┐ │
│ │                                                     │ │
│ │  📋 Hearing Entry Form          Published  8 fields │ │
│ │     Event Title*, Date/Time*, Client*, Court, ...   │ │
│ │     → feeds: Hearing Calendar, Upcoming Hearings    │ │
│ │                                                     │ │
│ └─────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

Key changes from current FormsApp:
- **Grouped by table** instead of a flat grid
- **Fields shown inline** — you see what each form asks without opening the builder
- **Downstream links** — each form shows what reports/views consume its data
- **Required fields marked** with `*`

### Tab 2: MEANT — Report Registry

```
┌─────────────────────────────────────────────────────────┐
│ MEANT: Reporting Frameworks               [+ New Report]│
├─────────────────────────────────────────────────────────┤
│                                                         │
│ ┌─ Case Dashboard ────────────────────────────────────┐ │
│ │  Source: Client Info + Events + Case Master View     │ │
│ │                                                     │ │
│ │  GIVEN columns:                                     │ │
│ │    Client Name, A#, DOB, Phone, Email, Country      │ │
│ │                                                     │ │
│ │  DERIVED columns:                                   │ │
│ │    Age = DATETIME_DIFF(Biometrics Date, DOB, "y")   │ │
│ │      ← sourced from: Client Intake Form             │ │
│ │    File Status = lookup(Case Master View)            │ │
│ │      ← sourced from: (linked record)                │ │
│ │    Next Event = rollup(Events, MIN(Hearing Date))   │ │
│ │      ← sourced from: Hearing Entry Form             │ │
│ │                                                     │ │
│ │  Filters: MCH Atty, ICH Atty, Case Manager, Status │ │
│ └─────────────────────────────────────────────────────┘ │
│                                                         │
│ ┌─ Hearing Calendar ──────────────────────────────────┐ │
│ │  Source: Events                                     │ │
│ │  ...                                                │ │
│ └─────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

Key changes from current InterfaceApp schema editing:
- **Focus on the data contract**, not the visual layout
- **Explicitly split GIVEN vs DERIVED columns** within each report
- **Source attribution** — every column traces back to which form collects its data
- **Formula visibility** — DERIVED columns show their computation inline

### Tab 3: Connections — The Bridge

```
┌─────────────────────────────────────────────────────────┐
│ GIVEN → MEANT: Data Flow Map                            │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  Client Info Table                                      │
│  ├── Name (GIVEN)                                       │
│  │   ├── → Case Dashboard: Client Name column           │
│  │   └── → Demographics Report: Name column             │
│  ├── DOB (GIVEN)                                        │
│  │   ├── → Case Dashboard: DOB & Age (via DATETIME_DIFF)│
│  │   └── → Demographics Report: Age Group (via formula) │
│  ├── Phone (GIVEN)                                      │
│  │   └── → Case Dashboard: Phone column                 │
│  └── SSN (GIVEN)                                        │
│      └── ⚠ Not consumed by any report                   │
│                                                         │
│  Events Table                                           │
│  ├── Hearing Date/Time (GIVEN)                          │
│  │   ├── → Hearing Calendar: time axis                  │
│  │   ├── → Case Dashboard: Next Event (via rollup)      │
│  │   └── → Home: Upcoming Hearings                      │
│  ...                                                    │
│                                                         │
│  ⚠ Gaps:                                                │
│  - Demographics Report expects "Language" but no form   │
│    collects it                                          │
│  - Case Dashboard expects "Biometrics Date" — only      │
│    collected by Client Intake (not Quick Add)           │
└─────────────────────────────────────────────────────────┘
```

---

## Specific Form Builder Improvements

Within the GIVEN side, the form builder itself needs work:

### 1. Inline Editing (no modal hop)

Current: Click card → opens full-page builder → three-panel layout.
Proposed: Expand the form card in-place to show an inline editor. Click a field to configure it right there. Collapse when done.

### 2. Field-Level Collaboration

- Per-field comment threads: "Should DOB be required?" with @mentions
- Per-field change history: "Bob changed DOB from optional to required, 2h ago"
- Conflict indicators when two people edit the same field config simultaneously

### 3. Conditional Field Logic

Add a "Conditions" section to field config:
- "Show this field only if [other field] equals [value]"
- Visual indicator on the form preview: fields with conditions show a small branch icon

### 4. Form Sections / Pages

Allow grouping fields into sections with headers, or multi-step wizard forms:
- "Personal Info" section → "Case Details" section → "Review & Submit"
- Progress bar at top

### 5. Validation Rules

Beyond just "required", allow:
- Pattern validation (A# must match `\d{9}`)
- Date range (DOB must be in the past)
- Cross-field validation (End Date > Start Date)

### 6. Form Response Viewer

Currently there's no way to see submitted responses. Add:
- Response list per form (read-only table of submitted records)
- Response count badge on the form card
- Export responses as CSV

---

## Data Model Changes

### Form View Extension

```javascript
formConfig: {
    // ... existing fields ...

    // NEW: Epistemic annotations
    epistemicRole: 'observation',  // 'observation' | 'assessment' | 'intake'

    // NEW: Sections for multi-step forms
    sections: [
        { id: 'sec1', label: 'Personal Info', fieldIds: ['fld1', 'fld2'] },
        { id: 'sec2', label: 'Case Details', fieldIds: ['fld3', 'fld4'] }
    ],

    // NEW: Conditional logic
    conditions: {
        'fld5': { showWhen: { field: 'fld3', op: 'equals', value: 'Immigration' } }
    },

    // NEW: Validation rules beyond required
    validation: {
        'fld2': { pattern: '\\d{9}', message: 'A# must be 9 digits' }
    },

    // NEW: Downstream linkage metadata (auto-computed)
    _downstream: {
        'fld1': ['clients-table.Client Name', 'demographics.Name'],
        'fld2': ['clients-table.A#']
    }
}
```

### Interface Schema Extension

```javascript
// Each block column gains source attribution
columns: [
    {
        field: 'Client Name',
        label: 'Client Name',
        epistemicStatus: 'GIVEN',
        sourceForms: ['viw_client_intake']  // which forms feed this
    },
    {
        field: 'Age',
        label: 'Age',
        epistemicStatus: 'DERIVED',
        derivation: 'DATETIME_DIFF({Biometrics Date}, {DOB}, "years")',
        sourceFields: ['fld_bio_date', 'fld_dob'],
        sourceForms: ['viw_client_intake']
    }
]
```

---

## Implementation Priority

If we were to build this, suggested order:

1. **Group forms by table in the list view** — Low effort, high clarity gain
2. **Show fields inline on form cards** — Makes GIVEN visible without click-through
3. **Add downstream linkage display** — "this form feeds these reports"
4. **Add GIVEN/DERIVED column split in interface schema** — Makes MEANT explicit
5. **Connection map tab** — The bridge view with gap detection
6. **Field-level collaboration** — Comments, change history
7. **Conditional logic & validation** — Form sophistication
8. **Multi-step forms** — Sections / wizard flow
9. **Form response viewer** — See submitted data
