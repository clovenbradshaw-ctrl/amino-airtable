/**
 * n8n Code Node: Get Current State of All Records (Complete)
 *
 * This comprehensive node handles multiple input formats:
 *
 * FORMAT 1: Combined records with embedded fieldHistory
 * Input items: [{ tableId, recordId, fieldHistory: [...] }]
 *
 * FORMAT 2: Separate records and history (typical IndexedDB export)
 * First item: { records: [{ tableId, recordId, fields: {...} }] }
 * Second item: { fieldHistory: [{ tableId, recordId, fieldId, timestamp, ... }] }
 *
 * FORMAT 3: Just field history entries (will reconstruct records)
 * Input items: [{ fieldHistory: [...] }]
 *
 * Output per record:
 * {
 *   tableId: string,
 *   recordId: string,
 *   fields: {
 *     fieldName: {
 *       value: any,
 *       lastUpdated: ISO string,
 *       lastUpdatedTimestamp: number
 *     }
 *   }
 * }
 */

// Collect all data from inputs
let allRecords = [];
let allHistory = [];
let fieldMeta = {}; // fieldId -> { fieldName, fieldType }

for (const item of $input.all()) {
  const data = item.json;

  // Collect records
  if (data.records && Array.isArray(data.records)) {
    allRecords = allRecords.concat(data.records);
  }

  // Collect field history
  if (data.fieldHistory && Array.isArray(data.fieldHistory)) {
    allHistory = allHistory.concat(data.fieldHistory);
  }

  // Collect field metadata if present
  if (data.fields && typeof data.fields === 'object' && !Array.isArray(data.fields)) {
    // This might be a fields metadata object
    for (const [key, meta] of Object.entries(data.fields)) {
      if (meta.fieldId && meta.fieldName) {
        fieldMeta[meta.fieldId] = meta;
      }
    }
  }

  // Handle combined format (record with embedded history)
  if (data.tableId && data.recordId && data.fieldHistory) {
    allHistory = allHistory.concat(
      data.fieldHistory.map(h => ({
        ...h,
        tableId: h.tableId || data.tableId,
        recordId: h.recordId || data.recordId
      }))
    );
  }
}

// Group history by table+record
const historyByRecord = new Map();

for (const entry of allHistory) {
  const key = `${entry.tableId}:${entry.recordId}`;

  if (!historyByRecord.has(key)) {
    historyByRecord.set(key, {
      tableId: entry.tableId,
      recordId: entry.recordId,
      history: []
    });
  }

  historyByRecord.get(key).history.push(entry);

  // Capture field name metadata from history entries
  if (entry.fieldId && entry.fieldName) {
    fieldMeta[entry.fieldId] = {
      fieldId: entry.fieldId,
      fieldName: entry.fieldName,
      fieldType: entry.fieldType
    };
  }
}

// Process each record
const results = [];

for (const [key, recordData] of historyByRecord) {
  const { tableId, recordId, history } = recordData;

  // Find latest entry for each field
  const fieldLatest = new Map();

  for (const entry of history) {
    const existing = fieldLatest.get(entry.fieldId);

    // Use timestamp first, fall back to eventId for ordering
    const entryTime = entry.timestamp || entry.eventId || 0;
    const existingTime = existing ? (existing.timestamp || existing.eventId || 0) : -1;

    if (entryTime > existingTime) {
      fieldLatest.set(entry.fieldId, entry);
    }
  }

  // Build output
  const fields = {};

  for (const [fieldId, entry] of fieldLatest) {
    // Get field name from metadata or entry or use fieldId
    const fieldName = (fieldMeta[fieldId]?.fieldName) ||
                     entry.fieldName ||
                     fieldId;

    // Only include fields that weren't deleted
    if (entry.changeType !== 'deleted') {
      fields[fieldName] = {
        value: entry.newValue,
        lastUpdated: entry.timestamp
          ? new Date(entry.timestamp).toISOString()
          : null,
        lastUpdatedTimestamp: entry.timestamp || null,
        fieldId: fieldId,
        fieldType: fieldMeta[fieldId]?.fieldType || entry.fieldType || null
      };
    }
  }

  results.push({
    json: {
      tableId,
      recordId,
      fields,
      _recordKey: key,
      _historyCount: history.length,
      _fieldCount: Object.keys(fields).length
    }
  });
}

// If no history found but we have records, pass them through
if (results.length === 0 && allRecords.length > 0) {
  for (const record of allRecords) {
    const fields = {};

    if (record.fields) {
      for (const [fieldId, value] of Object.entries(record.fields)) {
        const fieldName = fieldMeta[fieldId]?.fieldName || fieldId;
        fields[fieldName] = {
          value: value,
          lastUpdated: null,
          lastUpdatedTimestamp: null,
          fieldId: fieldId
        };
      }
    }

    results.push({
      json: {
        tableId: record.tableId,
        recordId: record.recordId,
        fields,
        _note: 'No history found, using current record values'
      }
    });
  }
}

return results;
