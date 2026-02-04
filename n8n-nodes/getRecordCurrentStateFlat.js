/**
 * n8n Code Node: Get Current State of Records (Flat Output)
 *
 * This node takes records with field history and produces a completely flat output:
 * - Each field value at the top level
 * - Each field's last update time as fieldName_lastUpdated
 *
 * Input: Array of items with fieldHistory entries
 * Expected input structure per item:
 * {
 *   tableId: string,
 *   recordId: string,
 *   fieldHistory: [
 *     {
 *       fieldId: string,
 *       fieldName?: string,
 *       timestamp: number,
 *       changeType: 'created' | 'updated' | 'deleted',
 *       newValue: any
 *     }
 *   ]
 * }
 *
 * Output: Completely flat records like:
 * {
 *   tableId: "tbl...",
 *   recordId: "rec...",
 *   Name: "John Doe",
 *   Name_lastUpdated: "2024-01-15T10:30:00.000Z",
 *   Email: "john@example.com",
 *   Email_lastUpdated: "2024-01-14T08:00:00.000Z",
 *   Status: "Active",
 *   Status_lastUpdated: "2024-01-13T12:00:00.000Z"
 * }
 */

// Process all input items
const results = [];

for (const item of $input.all()) {
  const data = item.json;

  // Skip items without field history
  if (!data.fieldHistory || !Array.isArray(data.fieldHistory)) {
    results.push({ json: data });
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

  // Build the completely flat output
  const output = {
    tableId: data.tableId,
    recordId: data.recordId
  };

  for (const [fieldId, entry] of fieldLatest) {
    const fieldName = entry.fieldName || fieldId;

    // Only include fields that weren't deleted
    if (entry.changeType !== 'deleted') {
      // Sanitize field name for use as object key (replace special chars)
      const safeName = fieldName.replace(/[^a-zA-Z0-9_]/g, '_');

      output[safeName] = entry.newValue;
      output[`${safeName}_lastUpdated`] = new Date(entry.timestamp).toISOString();
    }
  }

  results.push({ json: output });
}

return results;
