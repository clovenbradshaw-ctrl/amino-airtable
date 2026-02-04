# Tutorial: Get Current Record State in n8n

This tutorial shows you how to flatten Airtable records with field history into a simple current-state view with last-updated timestamps for each field.

## What You'll Build

Transform this (field history with multiple changes):
```json
[
  { "fieldId": "fldName", "fieldName": "Name", "timestamp": 1705315800000, "newValue": "John Doe", "changeType": "updated" },
  { "fieldId": "fldName", "fieldName": "Name", "timestamp": 1705229400000, "newValue": "John D", "changeType": "created" },
  { "fieldId": "fldEmail", "fieldName": "Email", "timestamp": 1705142000000, "newValue": "john@example.com", "changeType": "created" }
]
```

Into this (current state with timestamps):
```json
{
  "Name": "John Doe",
  "Name_lastUpdated": "2024-01-15T10:30:00.000Z",
  "Email": "john@example.com",
  "Email_lastUpdated": "2024-01-13T12:00:00.000Z"
}
```

---

## Quick Start

### Step 1: Create a Code Node

1. Open your n8n workflow
2. Click **+** to add a new node
3. Search for **Code** and add it
4. Set **Mode** to "Run Once for All Items"

### Step 2: Paste the Code

Copy this code into the Code node:

```javascript
// Get current state of all records with last update times
const results = [];

for (const item of $input.all()) {
  const data = item.json;

  if (!data.fieldHistory || !Array.isArray(data.fieldHistory)) {
    results.push({ json: data });
    continue;
  }

  // Find the latest entry for each field
  const fieldLatest = new Map();
  for (const entry of data.fieldHistory) {
    const existing = fieldLatest.get(entry.fieldId);
    if (!existing || entry.timestamp > existing.timestamp) {
      fieldLatest.set(entry.fieldId, entry);
    }
  }

  // Build flat output
  const output = { tableId: data.tableId, recordId: data.recordId };
  for (const [fieldId, entry] of fieldLatest) {
    if (entry.changeType !== 'deleted') {
      const name = (entry.fieldName || fieldId).replace(/[^a-zA-Z0-9_]/g, '_');
      output[name] = entry.newValue;
      output[`${name}_lastUpdated`] = new Date(entry.timestamp).toISOString();
    }
  }

  results.push({ json: output });
}

return results;
```

### Step 3: Connect Your Data

Connect any node that outputs field history data to your Code node.

---

## Input Format

Your input items should have this structure:

```json
{
  "tableId": "tblXXXXXXXX",
  "recordId": "recXXXXXXXX",
  "fieldHistory": [
    {
      "fieldId": "fldXXXXXXXX",
      "fieldName": "Name",
      "timestamp": 1705315800000,
      "changeType": "created",
      "oldValue": null,
      "newValue": "John Doe"
    },
    {
      "fieldId": "fldXXXXXXXX",
      "fieldName": "Name",
      "timestamp": 1705402200000,
      "changeType": "updated",
      "oldValue": "John Doe",
      "newValue": "Jane Doe"
    }
  ]
}
```

**Required fields:**
- `fieldId` - Unique identifier for the field
- `timestamp` - Unix timestamp in milliseconds
- `changeType` - One of: `created`, `updated`, `deleted`
- `newValue` - The value after this change

**Optional fields:**
- `fieldName` - Human-readable name (falls back to fieldId)
- `oldValue` - The previous value
- `tableId`, `recordId` - Passed through to output

---

## Output Formats

### Option A: Flat Output (Recommended for Spreadsheets)

Use `getRecordCurrentStateFlat.js`

```json
{
  "tableId": "tblXXX",
  "recordId": "recXXX",
  "Name": "Jane Doe",
  "Name_lastUpdated": "2024-01-16T10:30:00.000Z",
  "Email": "jane@example.com",
  "Email_lastUpdated": "2024-01-13T12:00:00.000Z",
  "Status": "Active",
  "Status_lastUpdated": "2024-01-15T09:00:00.000Z"
}
```

### Option B: Structured Output (Recommended for APIs)

Use `getRecordCurrentState.js`

```json
{
  "tableId": "tblXXX",
  "recordId": "recXXX",
  "fields": {
    "Name": "Jane Doe",
    "Email": "jane@example.com",
    "Status": "Active"
  },
  "_fieldMetadata": {
    "Name": {
      "fieldId": "fldName",
      "lastUpdated": "2024-01-16T10:30:00.000Z",
      "lastUpdatedTimestamp": 1705402200000,
      "changeType": "updated"
    },
    "Email": {
      "fieldId": "fldEmail",
      "lastUpdated": "2024-01-13T12:00:00.000Z",
      "lastUpdatedTimestamp": 1705142000000,
      "changeType": "created"
    }
  }
}
```

### Option C: Complete Output (Recommended for Complex Workflows)

Use `getRecordCurrentStateComplete.js`

```json
{
  "tableId": "tblXXX",
  "recordId": "recXXX",
  "fields": {
    "Name": {
      "value": "Jane Doe",
      "lastUpdated": "2024-01-16T10:30:00.000Z",
      "lastUpdatedTimestamp": 1705402200000,
      "fieldId": "fldName",
      "fieldType": "singleLineText"
    }
  },
  "_recordKey": "tblXXX:recXXX",
  "_historyCount": 5,
  "_fieldCount": 3
}
```

---

## Example Workflows

### Example 1: Export to Google Sheets

```
[HTTP Request] → [Code: Flat Output] → [Google Sheets]
     ↓                   ↓                    ↓
 Fetch history    Flatten records      Append rows
```

The flat output works directly with Google Sheets since each field becomes a column.

### Example 2: Sync to Another Database

```
[HTTP Request] → [Code: Structured] → [IF: Has Updates?] → [Postgres]
                                              ↓
                              Check _fieldMetadata for recent changes
```

Use the structured output to check which fields changed recently before syncing.

### Example 3: Build a Change Report

```
[Schedule] → [HTTP Request] → [Code: Complete] → [Filter] → [Send Email]
                                    ↓               ↓
                             Get all records   lastUpdated > yesterday
```

Filter records where any field's `lastUpdated` is within your reporting window.

---

## Handling Edge Cases

### Deleted Fields

Fields with `changeType: 'deleted'` are excluded from output. Only current (non-deleted) fields appear.

### Missing Field Names

If `fieldName` is missing, the code uses `fieldId` as the key:
```json
{ "fldXXXXXXXX": "value", "fldXXXXXXXX_lastUpdated": "..." }
```

### Special Characters in Field Names

Field names are sanitized for the flat output format:
- `First Name` → `First_Name`
- `Email (Work)` → `Email__Work_`

### Records Without History

Records missing `fieldHistory` are passed through unchanged with their existing `fields` object.

---

## Files Reference

| File | Best For | Output Style |
|------|----------|--------------|
| `getRecordCurrentState.js` | API integrations | Separate fields + metadata |
| `getRecordCurrentStateFlat.js` | Spreadsheets, simple use | Flat key-value pairs |
| `getRecordCurrentStateComplete.js` | Complex workflows | Rich field objects with all metadata |

---

## Troubleshooting

**No output?**
- Check that input has `fieldHistory` array
- Verify `timestamp` is a number (milliseconds)

**Wrong field names?**
- Add `fieldName` to your history entries
- Or map fieldIds to names before this node

**Missing recent changes?**
- Ensure timestamps are in milliseconds, not seconds
- Check that `changeType` is not `deleted`
