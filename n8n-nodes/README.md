# n8n Code Nodes for Amino-Airtable

Code nodes for processing Airtable record history in n8n workflows.

## Available Nodes

### 1. `getRecordCurrentState.js`
Basic version with structured output.

**Output format:**
```json
{
  "tableId": "tblXXX",
  "recordId": "recXXX",
  "fields": {
    "Name": "John Doe",
    "Email": "john@example.com"
  },
  "_fieldMetadata": {
    "Name": {
      "fieldId": "fldXXX",
      "lastUpdated": "2024-01-15T10:30:00.000Z",
      "lastUpdatedTimestamp": 1705315800000,
      "changeType": "updated"
    }
  }
}
```

### 2. `getRecordCurrentStateFlat.js`
Completely flat output, ideal for spreadsheets or simple integrations.

**Output format:**
```json
{
  "tableId": "tblXXX",
  "recordId": "recXXX",
  "Name": "John Doe",
  "Name_lastUpdated": "2024-01-15T10:30:00.000Z",
  "Email": "john@example.com",
  "Email_lastUpdated": "2024-01-14T08:00:00.000Z"
}
```

### 3. `getRecordCurrentStateComplete.js`
Full-featured version that handles multiple input formats.

**Supported input formats:**
- Combined records with embedded `fieldHistory`
- Separate `records` and `fieldHistory` arrays
- Just `fieldHistory` entries (reconstructs records)

**Output format:**
```json
{
  "tableId": "tblXXX",
  "recordId": "recXXX",
  "fields": {
    "Name": {
      "value": "John Doe",
      "lastUpdated": "2024-01-15T10:30:00.000Z",
      "lastUpdatedTimestamp": 1705315800000,
      "fieldId": "fldXXX",
      "fieldType": "singleLineText"
    }
  },
  "_recordKey": "tblXXX:recXXX",
  "_historyCount": 15,
  "_fieldCount": 5
}
```

## Expected Input Structure

Field history entries should have this structure:
```json
{
  "tableId": "tblXXX",
  "recordId": "recXXX",
  "fieldId": "fldXXX",
  "fieldName": "Name",
  "timestamp": 1705315800000,
  "changeType": "created|updated|deleted",
  "oldValue": null,
  "newValue": "John Doe"
}
```

## Usage in n8n

1. Add a **Code** node to your workflow
2. Copy the contents of one of these files into the code editor
3. Connect your data source (HTTP Request, database, etc.) as input
4. The node will output flattened records with last update timestamps

## Notes

- Deleted fields are excluded from output (only shows current state)
- If no `fieldName` is provided, `fieldId` is used as the field key
- Timestamps are converted to ISO 8601 format for readability
- Records without field history are passed through with a note
