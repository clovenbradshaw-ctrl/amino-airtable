/**
 * Formula Integration Layer
 *
 * Bridges the formula engine with amino.current_state and the existing
 * field_registry / data layer infrastructure.
 *
 * Responsibilities:
 * - Load field definitions from the amino API / field registry
 * - Build a DataContext from synced table data
 * - Instantiate and compile FormulaRegistry per table
 * - Provide helpers for the grid renderer to compute and display formula values
 *
 * This module is designed to be loaded as an ES module alongside the
 * existing index.html application, connecting to the same data layer.
 */

import { FormulaRegistry } from './registry.js';
import { formatFormulaValue, getEpistemicDotClass, buildFormulaBarHTML, buildProvenanceHTML } from './ui.js';

/**
 * @typedef {Object} AminoFieldEntry
 * @property {string} fieldId
 * @property {string} fieldName
 * @property {string} fieldType
 * @property {boolean} isComputed
 * @property {string} tableId
 * @property {object} [options]
 */

// Computed field types — mirrors the COMPUTED_FIELD_TYPES in index.html
const COMPUTED_FIELD_TYPES = [
  'formula', 'rollup', 'lookup', 'count',
  'autoNumber', 'createdTime', 'lastModifiedTime',
  'createdBy', 'lastModifiedBy'
];

/**
 * Convert the META_FIELDS structure (from index.html) into FieldRegistryEntry[].
 * META_FIELDS is structured as: { tableId: { fieldId: { fieldName, fieldType, options, ... } } }
 *
 * @param {object} metaFields - The META_FIELDS global from index.html
 * @param {string} tableId - Target table ID
 * @returns {AminoFieldEntry[]}
 */
export function metaFieldsToRegistry(metaFields, tableId) {
  const tableFields = metaFields[tableId];
  if (!tableFields) return [];

  return Object.entries(tableFields).map(([fieldId, field]) => ({
    fieldId,
    fieldName: field.fieldName || fieldId,
    fieldType: field.fieldType || 'singleLineText',
    isComputed: COMPUTED_FIELD_TYPES.indexOf(field.fieldType) !== -1,
    tableId,
    options: field.options || {}
  }));
}

/**
 * Build a DataContext from the application's data stores.
 * The DataContext maps tableId → (recordId → fields) for lookup/rollup resolution.
 *
 * @param {function} getRecordIdsForTable - async (tableId) => string[]
 * @param {function} getRecordCurrentState - async (tableId, recordId) => { fields: object }
 * @param {string[]} tableIds - All table IDs to include
 * @param {object} metaFields - META_FIELDS global
 * @returns {Promise<import('./relational-compiler.js').DataContext>}
 */
export async function buildDataContext(getRecordIdsForTable, getRecordCurrentState, tableIds, metaFields) {
  const tables = new Map();
  const fieldRegistry = new Map();
  const tableRegistry = new Map();

  // Build field registry from all tables
  for (const tid of tableIds) {
    const fields = metaFieldsToRegistry(metaFields, tid);
    for (const f of fields) {
      fieldRegistry.set(f.fieldName, f);
    }
    tableRegistry.set(tid, {
      tableId: tid,
      tableName: tid,
      fields
    });
  }

  // Load all records for each table
  for (const tid of tableIds) {
    const recordMap = new Map();
    try {
      const recordIds = await getRecordIdsForTable(tid);
      for (const rid of recordIds) {
        try {
          const state = await getRecordCurrentState(tid, rid);
          if (state && state.fields) {
            recordMap.set(rid, state.fields);
          }
        } catch (_e) {
          // Skip records that fail to load
        }
      }
    } catch (_e) {
      // Skip tables that fail to load
    }
    tables.set(tid, recordMap);
  }

  return { tables, fieldRegistry, tableRegistry };
}

/**
 * Identify all linked table IDs referenced by lookup/rollup fields.
 *
 * @param {AminoFieldEntry[]} fieldEntries
 * @param {object} metaFields - META_FIELDS for resolving link field targets
 * @returns {string[]} Unique linked table IDs
 */
export function getLinkedTableIds(fieldEntries, metaFields) {
  const linkedTableIds = new Set();

  for (const field of fieldEntries) {
    if ((field.fieldType === 'lookup' || field.fieldType === 'rollup') &&
        field.options && field.options.recordLinkFieldId) {
      // Find the link field to get the linked table ID
      const linkFieldId = field.options.recordLinkFieldId;
      // Search across all tables for this link field
      for (const tid in metaFields) {
        const linkField = metaFields[tid][linkFieldId];
        if (linkField && linkField.options && linkField.options.linkedTableId) {
          linkedTableIds.add(linkField.options.linkedTableId);
        }
      }
    }
  }

  return [...linkedTableIds];
}

/**
 * Initialize the formula engine for a given table.
 * This is the main entry point for the integration.
 *
 * @param {string} tableId - The table to compile formulas for
 * @param {string} baseId - Airtable base ID
 * @param {object} metaFields - META_FIELDS global
 * @param {function} getRecordIdsForTable - async (tableId) => string[]
 * @param {function} getRecordCurrentState - async (tableId, recordId) => object
 * @returns {Promise<FormulaRegistry>}
 */
export async function initializeFormulas(tableId, baseId, metaFields, getRecordIdsForTable, getRecordCurrentState) {
  // 1. Build field entries for the current table
  const fieldEntries = metaFieldsToRegistry(metaFields, tableId);

  // 2. Find all linked tables needed for lookups/rollups
  const linkedTableIds = getLinkedTableIds(fieldEntries, metaFields);
  const allTableIds = [tableId, ...linkedTableIds.filter(id => id !== tableId)];

  // 3. Build the data context
  const dataContext = await buildDataContext(
    getRecordIdsForTable, getRecordCurrentState, allTableIds, metaFields
  );

  // 4. Create and compile the registry
  const registry = new FormulaRegistry(fieldEntries, dataContext, tableId, baseId);
  registry.compile();

  return registry;
}

/**
 * Compute formula values for a single record and return the augmented record.
 *
 * @param {FormulaRegistry} registry
 * @param {object} record - Record fields
 * @param {string} recordId
 * @param {string} [createdTime]
 * @param {string} [lastModifiedTime]
 * @returns {object} Record with computed fields populated
 */
export function computeRecordFormulas(registry, record, recordId, createdTime, lastModifiedTime) {
  return registry.computeRecord(record, {
    recordId,
    createdTime,
    lastModifiedTime
  });
}

// Re-export UI helpers for convenience
export { formatFormulaValue, getEpistemicDotClass, buildFormulaBarHTML, buildProvenanceHTML };
