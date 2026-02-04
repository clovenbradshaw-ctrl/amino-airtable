/**
 * n8n Code Node: Get Current State of Records
 *
 * This node takes records with field history and flattens them to show:
 * - Current value of each field
 * - Last update timestamp for each field
 * - No history data
 *
 * Input: Array of items with fieldHistory entries
 * Expected input structure per item:
 * {
 *   tableId: string,
 *   recordId: string,
 *   fieldHistory: [
 *     {
 *       fieldId: string,
 *       fieldName?: string,  // Optional, will use fieldId if not present
 *       timestamp: number,   // Unix timestamp in milliseconds
 *       changeType: 'created' | 'updated' | 'deleted',
 *       newValue: any
 *     }
 *   ]
 * }
 *
 * Output: Flattened records with current state and last update times
 */

// Process all input items
const results = [];

for (const item of $input.all()) {
  const data = item.json;

  // Skip items without field history
  if (!data.fieldHistory || !Array.isArray(data.fieldHistory)) {
    // If it's already a flat record, pass through
    results.push({
      json: {
        tableId: data.tableId,
        recordId: data.recordId,
        fields: data.fields || {},
        _note: 'No field history found, passed through as-is'
      }
    });
    continue;
  }

  // Group history by field and find the latest entry for each
  const fieldLatest = new Map();

  for (const entry of data.fieldHistory) {
    const fieldKey = entry.fieldId;
    const existing = fieldLatest.get(fieldKey);

    // Keep the entry with the highest timestamp (most recent)
    if (!existing || entry.timestamp > existing.timestamp) {
      fieldLatest.set(fieldKey, entry);
    }
  }

  // Build the flattened output
  const fields = {};
  const fieldMetadata = {};

  for (const [fieldId, entry] of fieldLatest) {
    const fieldName = entry.fieldName || fieldId;

    // Only include fields that weren't deleted
    if (entry.changeType !== 'deleted') {
      fields[fieldName] = entry.newValue;
      fieldMetadata[fieldName] = {
        fieldId: fieldId,
        lastUpdated: new Date(entry.timestamp).toISOString(),
        lastUpdatedTimestamp: entry.timestamp,
        changeType: entry.changeType
      };
    }
  }

  results.push({
    json: {
      tableId: data.tableId,
      recordId: data.recordId,
      fields: fields,
      _fieldMetadata: fieldMetadata
    }
  });
}

return results;
