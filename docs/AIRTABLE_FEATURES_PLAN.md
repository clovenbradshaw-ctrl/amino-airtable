# Airtable Features Implementation Plan

A comprehensive plan to implement core Airtable functionality: grouping, filtering, sorting, hiding fields, and colors.

---

## Current State

The application is a vanilla JavaScript SPA with:
- IndexedDB for persistent data storage
- Single `index.html` file (~1000 lines)
- Airtable-style UI (dark sidebar, light content)
- Basic table viewing with pagination
- Smart cell formatting (arrays, booleans, links, etc.)
- Sync with external Amino event stream API

**What exists:**
- Table rendering with dynamic columns
- Field metadata storage (fieldId, fieldName, fieldType)
- Pagination (100 records per page)

**What's missing:**
- Sorting, filtering, grouping
- Column visibility controls
- Color support for cells
- View state persistence

---

## Architecture Overview

### State Management

All view state (sorts, filters, groups, hidden fields) will be stored in a new IndexedDB object store called `viewState` keyed by tableId:

```javascript
// ViewState schema
{
  tableId: string,
  sort: { fieldId: string, direction: 'asc' | 'desc' } | null,
  filters: Filter[],
  groupBy: string | null,  // fieldId
  hiddenFields: string[],  // array of fieldIds
  fieldColors: { [fieldId]: { [value]: color } }
}
```

### Filter Schema

```javascript
// Filter object
{
  id: string,          // unique filter ID
  fieldId: string,     // which field to filter on
  operator: string,    // 'equals', 'contains', 'isEmpty', etc.
  value: any           // the value to compare against
}
```

---

## Phase 1: Sorting

**Goal:** Click column headers to sort ascending/descending

### 1.1 Data Layer Changes
- [ ] Add `viewState` IndexedDB store with schema: `{ tableId, sort, filters, groupBy, hiddenFields }`
- [ ] Add functions: `getViewState(tableId)`, `setViewState(tableId, state)`
- [ ] Initialize default viewState when viewing a new table

### 1.2 UI Changes
- [ ] Add sort indicator icons to column headers (▲ ▼)
- [ ] Add click handler to `<th>` elements
- [ ] Add CSS for sort indicators and clickable headers

### 1.3 Sort Logic
- [ ] Implement `sortRecords(records, fieldId, direction)` function
- [ ] Handle different data types: strings, numbers, booleans, dates, arrays
- [ ] Apply sort before pagination in `renderTable()`

### 1.4 Visual Design
```
┌─────────────────────────────────────────────────────┐
│ ID      │ Name ▼     │ Status    │ Created       │
├─────────────────────────────────────────────────────┤
│ rec001  │ Alpha      │ Active    │ 2024-01-01    │
│ rec002  │ Beta       │ Pending   │ 2024-01-02    │
└─────────────────────────────────────────────────────┘
```

**Estimated complexity:** Low
**Files to modify:** `index.html` (JS section)

---

## Phase 2: Filtering

**Goal:** Filter records by field values using a filter bar

### 2.1 Filter UI Components
- [ ] Add "Filter" button to toolbar
- [ ] Create filter dropdown/popover component
- [ ] Create filter row component with: field selector, operator selector, value input
- [ ] Add "Add filter" button for multiple filters
- [ ] Add filter pills showing active filters

### 2.2 Filter Operators by Field Type

| Field Type | Operators |
|------------|-----------|
| Text | equals, contains, does not contain, is empty, is not empty, starts with, ends with |
| Number | =, ≠, >, <, ≥, ≤, is empty, is not empty |
| Single Select | is, is not, is empty, is not empty |
| Multiple Select | has any of, has all of, is exactly, is empty, is not empty |
| Checkbox | is checked, is not checked |
| Date | is, is before, is after, is on or before, is on or after, is empty |
| Link | contains, does not contain, is empty, is not empty |

### 2.3 Filter Logic
- [ ] Implement `applyFilters(records, filters)` function
- [ ] Implement operator functions for each field type
- [ ] Combine multiple filters with AND logic
- [ ] Apply filters before sorting and pagination

### 2.4 Filter UI Design
```
┌─────────────────────────────────────────────────────────────────┐
│ ☰ Filter  │ + Add filter                                        │
├─────────────────────────────────────────────────────────────────┤
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ [Status ▼] [is ▼] [Active ▼]                        [✕]    │ │
│ └─────────────────────────────────────────────────────────────┘ │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ [Name ▼] [contains ▼] [_______]                     [✕]    │ │
│ └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘

Active filters shown as pills:
┌──────────────────────────────────────────────────────────────────┐
│ [Status is Active ✕] [Name contains "test" ✕]  Clear all        │
└──────────────────────────────────────────────────────────────────┘
```

**Estimated complexity:** Medium-High
**Files to modify:** `index.html` (HTML, CSS, JS sections)

---

## Phase 3: Hiding Fields (Column Visibility)

**Goal:** Toggle column visibility, reorder columns

### 3.1 UI Components
- [ ] Add "Hide fields" button to toolbar
- [ ] Create field visibility popover with checkboxes for each field
- [ ] Add drag handles for column reordering (optional, phase 2)
- [ ] Show count of hidden fields on button

### 3.2 Logic
- [ ] Store `hiddenFields` array in viewState
- [ ] Filter out hidden columns in `renderTable()`
- [ ] Store `fieldOrder` array for custom column ordering (optional)

### 3.3 UI Design
```
┌───────────────────────────────────┐
│ Hide fields (2 hidden)          │
├───────────────────────────────────┤
│ Find a field...                   │
├───────────────────────────────────┤
│ ☑ ID                              │
│ ☑ Name                            │
│ ☐ Internal Notes    (hidden)      │
│ ☑ Status                          │
│ ☐ Created By        (hidden)      │
│ ☑ Created Date                    │
├───────────────────────────────────┤
│ Show all │ Hide all               │
└───────────────────────────────────┘
```

**Estimated complexity:** Low-Medium
**Files to modify:** `index.html` (HTML, CSS, JS sections)

---

## Phase 4: Grouping

**Goal:** Group records by a field value with collapsible sections

### 4.1 UI Components
- [ ] Add "Group" button to toolbar
- [ ] Create group-by field selector dropdown
- [ ] Create collapsible group headers with record count
- [ ] Add expand/collapse all functionality

### 4.2 Group Logic
- [ ] Implement `groupRecords(records, fieldId)` function
- [ ] Handle grouping for different field types:
  - Single select: group by option value
  - Multi-select: group by each selected value (record appears in multiple groups)
  - Text: group by exact value
  - Checkbox: group by true/false
  - Date: group by day/week/month (with options)
  - Empty values: "(Empty)" group
- [ ] Maintain sort within groups

### 4.3 Group Rendering
- [ ] Render group headers with expand/collapse toggle
- [ ] Track expanded/collapsed state per group
- [ ] Apply pagination per group or globally (decide on UX)

### 4.4 UI Design
```
┌──────────────────────────────────────────────────────────────────┐
│ ▼ Active (12 records)                                            │
├──────────────────────────────────────────────────────────────────┤
│ ID       │ Name          │ Status    │ Created                   │
│ rec001   │ Alpha         │ Active    │ 2024-01-01                │
│ rec002   │ Beta          │ Active    │ 2024-01-02                │
├──────────────────────────────────────────────────────────────────┤
│ ▶ Pending (5 records)                      [collapsed]           │
├──────────────────────────────────────────────────────────────────┤
│ ▼ Closed (8 records)                                             │
├──────────────────────────────────────────────────────────────────┤
│ ID       │ Name          │ Status    │ Created                   │
│ rec010   │ Gamma         │ Closed    │ 2024-01-10                │
└──────────────────────────────────────────────────────────────────┘
```

**Estimated complexity:** Medium-High
**Files to modify:** `index.html` (HTML, CSS, JS sections)

---

## Phase 5: Colors

**Goal:** Color cells based on field values (like Airtable's single/multi-select colors)

### 5.1 Field Type Colors (Single/Multi-Select)
- [ ] Parse `options.choices` from field metadata (already in payload)
- [ ] Extract color information: `{ id, name, color }`
- [ ] Map Airtable color names to CSS colors
- [ ] Apply colors to select field cells

### 5.2 Airtable Color Palette

```javascript
const AIRTABLE_COLORS = {
  // Light colors (for backgrounds)
  blueLight: '#D0E0FC',
  cyanLight: '#D0F0FD',
  tealLight: '#C2F5E9',
  greenLight: '#D1F7C4',
  yellowLight: '#FFEAB6',
  orangeLight: '#FEE2D5',
  redLight: '#FFDCE5',
  pinkLight: '#FFDAF6',
  purpleLight: '#EDE2FE',
  grayLight: '#EEEEEE',

  // Dark colors (for text/borders)
  blueDark: '#2D7FF9',
  cyanDark: '#18BFFF',
  tealDark: '#20D9D2',
  greenDark: '#20C933',
  yellowDark: '#FCB400',
  orangeDark: '#FF6F2C',
  redDark: '#F82B60',
  pinkDark: '#FF08C2',
  purpleDark: '#8B46FF',
  grayDark: '#666666'
};
```

### 5.3 Conditional Colors (Row/Cell Highlighting)
- [ ] Add color rules interface (optional advanced feature)
- [ ] Allow rules like: "If Status = Urgent, highlight row red"
- [ ] Store color rules in viewState

### 5.4 UI Design
```
┌──────────────────────────────────────────────────────────────────┐
│ ID       │ Name          │ Status           │ Priority          │
├──────────────────────────────────────────────────────────────────┤
│ rec001   │ Alpha         │ [■ Active]       │ [■ High]          │
│          │               │  (green bg)      │  (red bg)         │
├──────────────────────────────────────────────────────────────────┤
│ rec002   │ Beta          │ [■ Pending]      │ [■ Medium]        │
│          │               │  (yellow bg)     │  (yellow bg)      │
└──────────────────────────────────────────────────────────────────┘
```

**Estimated complexity:** Medium
**Files to modify:** `index.html` (CSS, JS sections)

---

## Implementation Order & Dependencies

```
Phase 1: Sorting (no dependencies)
    │
    ├──► Phase 2: Filtering (depends on viewState from Phase 1)
    │
    ├──► Phase 3: Hiding Fields (depends on viewState from Phase 1)
    │
    └──► Phase 5: Colors (no dependencies, can be parallel)
            │
            └──► Phase 4: Grouping (benefits from colors, depends on sort/filter)
```

**Recommended order:**
1. **Phase 1: Sorting** - Foundation for viewState, simple to implement
2. **Phase 5: Colors** - Improves visual appeal, independent
3. **Phase 3: Hiding Fields** - Quick win, simple UI
4. **Phase 2: Filtering** - Most complex, critical feature
5. **Phase 4: Grouping** - Builds on everything, most complex rendering

---

## Database Schema Changes

### New IndexedDB Store: `viewState`

```javascript
// In openDB() onupgradeneeded:
db.createObjectStore('viewState', { keyPath: 'tableId' });
```

### ViewState Object Structure

```javascript
{
  tableId: 'tbl123',
  sort: {
    fieldId: 'fld456',
    direction: 'asc'  // or 'desc'
  },
  filters: [
    {
      id: 'filter_1',
      fieldId: 'fldStatus',
      operator: 'is',
      value: 'Active'
    }
  ],
  groupBy: 'fldStatus',  // or null
  expandedGroups: ['Active', 'Pending'],  // which groups are expanded
  hiddenFields: ['fldInternalNotes', 'fldCreatedBy'],
  fieldOrder: ['fldName', 'fldStatus', 'fldDate']  // optional custom order
}
```

---

## CSS Components Needed

### Toolbar Buttons
```css
.toolbar-btn { ... }
.toolbar-btn.active { ... }
.toolbar-dropdown { ... }
```

### Sort Indicators
```css
th.sortable { cursor: pointer; }
th.sortable:hover { background: #eee; }
th .sort-icon { ... }
th .sort-icon.asc { ... }
th .sort-icon.desc { ... }
```

### Filter Components
```css
.filter-bar { ... }
.filter-row { ... }
.filter-field-select { ... }
.filter-operator-select { ... }
.filter-value-input { ... }
.filter-pill { ... }
```

### Group Headers
```css
.group-header { ... }
.group-header.collapsed { ... }
.group-toggle { ... }
.group-count { ... }
```

### Color Badges
```css
.color-badge { ... }
.color-badge.blue { background: #D0E0FC; color: #2D7FF9; }
.color-badge.green { background: #D1F7C4; color: #20C933; }
/* ... etc for all colors */
```

---

## Testing Checklist

### Sorting
- [ ] Sort ascending on text field
- [ ] Sort descending on text field
- [ ] Sort on number field
- [ ] Sort on date field
- [ ] Sort on boolean field
- [ ] Sort persists after page refresh
- [ ] Sort indicator shows correctly
- [ ] Click same column toggles direction

### Filtering
- [ ] Filter text field with "contains"
- [ ] Filter text field with "equals"
- [ ] Filter number field with operators
- [ ] Filter select field with "is"
- [ ] Multiple filters combine correctly (AND)
- [ ] Remove individual filter
- [ ] Clear all filters
- [ ] Filters persist after page refresh
- [ ] Empty results show appropriate message

### Hiding Fields
- [ ] Hide single field
- [ ] Hide multiple fields
- [ ] Show hidden field
- [ ] Show all / Hide all buttons
- [ ] Hidden field count shows in button
- [ ] Hidden state persists after refresh

### Grouping
- [ ] Group by single select field
- [ ] Group by text field
- [ ] Collapse/expand groups
- [ ] Collapse/expand all
- [ ] Record counts accurate per group
- [ ] Empty values group correctly
- [ ] Grouping with sort works
- [ ] Grouping with filters works

### Colors
- [ ] Single select shows correct colors
- [ ] Multi-select shows correct colors
- [ ] All Airtable colors map correctly
- [ ] Colors visible in both light/dark modes

---

## File Structure Recommendation

While the current single-file approach works, consider splitting as complexity grows:

```
/home/user/amino-airtable/
├── index.html              # Main HTML structure
├── css/
│   ├── main.css            # Base styles
│   └── components.css      # Component-specific styles
├── js/
│   ├── db.js               # IndexedDB operations
│   ├── api.js              # API communication
│   ├── ui.js               # UI rendering
│   ├── sort.js             # Sorting logic
│   ├── filter.js           # Filtering logic
│   ├── group.js            # Grouping logic
│   └── app.js              # Main app initialization
└── docs/
    ├── STYLE_GUIDE.md
    └── AIRTABLE_FEATURES_PLAN.md
```

**For now:** Keep single file but organize with clear comment sections.

---

## Performance Considerations

1. **Large datasets:** Apply filters/sorts in IndexedDB queries where possible
2. **Virtual scrolling:** Consider for tables with 1000+ visible rows
3. **Debounce:** Filter input changes should be debounced (300ms)
4. **Memoization:** Cache sorted/filtered record sets when viewState unchanged
5. **Web Workers:** Consider for heavy sorting/filtering operations (optional)

---

## Next Steps

1. **Start with Phase 1 (Sorting)** - Creates foundation
2. Add viewState store to IndexedDB
3. Implement sort UI and logic
4. Test thoroughly
5. Proceed to Phase 5 (Colors) or Phase 3 (Hiding Fields)

---

*Plan created: January 2026*
*Last updated: January 2026*
