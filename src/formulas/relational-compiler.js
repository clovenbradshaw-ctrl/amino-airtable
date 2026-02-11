/**
 * Relational Compiler — Lookups and Rollups
 *
 * Lookups and rollups require access to linked records beyond the current row.
 * This module compiles lookup and rollup field definitions into executable
 * functions that resolve linked record references.
 *
 * DataContext:
 *   tables: Map<tableId, Map<recordId, fields>>
 *   fieldRegistry: Map<fieldName, FieldRegistryEntry>
 *   tableRegistry: Map<tableId, TableRegistryEntry>
 */

/**
 * @typedef {Object} DataContext
 * @property {Map<string, Map<string, object>>} tables - tableId → (recordId → fields)
 * @property {Map<string, object>} fieldRegistry - fieldName → entry
 * @property {Map<string, object>} tableRegistry - tableId → entry
 */

/**
 * Compile a lookup field into an executable function.
 * Resolves linked record IDs and pulls a field from the linked table.
 *
 * @param {string} linkFieldName - Field on the current record holding linked record IDs
 * @param {string} foreignFieldName - Field to pull from the linked table
 * @param {DataContext} ctx - Data context with all synced tables
 * @param {string} linkedTableId - ID of the linked table
 * @returns {function(object): any[]} (record) => array of looked-up values
 */
export function compileLookup(linkFieldName, foreignFieldName, ctx, linkedTableId) {
  return (record) => {
    // Get linked record IDs from the link field
    const linkedIds = record[linkFieldName];
    if (!Array.isArray(linkedIds) || linkedIds.length === 0) return [];

    // Resolve each linked record from the target table
    const linkedTable = ctx.tables.get(linkedTableId);
    if (!linkedTable) return [];

    return linkedIds
      .map(id => linkedTable.get(id))
      .filter(Boolean)
      .map(rec => rec[foreignFieldName]);
  };
}

/**
 * Compile a rollup field into an executable function.
 * Performs a lookup, then applies an aggregation function to the results.
 *
 * @param {string} linkFieldName - Field on the current record holding linked record IDs
 * @param {string} foreignFieldName - Field to pull from the linked table
 * @param {string} aggregationFormula - Airtable rollup formula, e.g. "SUM(values)"
 * @param {DataContext} ctx - Data context with all synced tables
 * @param {string} linkedTableId - ID of the linked table
 * @returns {function(object): any} (record) => aggregated value
 */
export function compileRollup(linkFieldName, foreignFieldName, aggregationFormula, ctx, linkedTableId) {
  const lookupFn = compileLookup(linkFieldName, foreignFieldName, ctx, linkedTableId);

  // Parse the rollup aggregation formula — extract function name
  const aggName = aggregationFormula.replace(/\(values\)/i, '').trim().toUpperCase();

  return (record) => {
    const values = lookupFn(record);

    switch (aggName) {
      case 'SUM':
        return values.reduce((a, b) => (a || 0) + (b || 0), 0);

      case 'MAX': {
        const nums = values.filter(v => typeof v === 'number');
        return nums.length ? Math.max(...nums) : null;
      }

      case 'MIN': {
        const nums = values.filter(v => typeof v === 'number');
        return nums.length ? Math.min(...nums) : null;
      }

      case 'AVERAGE': {
        const nums = values.filter(v => typeof v === 'number');
        return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
      }

      case 'COUNT':
        return values.filter(v => typeof v === 'number').length;

      case 'COUNTA':
        return values.filter(v => v != null && v !== '').length;

      case 'COUNTALL':
        return values.length;

      case 'CONCATENATE':
      case 'ARRAYJOIN':
        return values.map(v => v ?? '').join(', ');

      case 'ARRAYUNIQUE':
        return [...new Set(values)];

      case 'ARRAYCOMPACT':
        return values.filter(v => v != null && v !== '');

      case 'AND':
        return values.every(Boolean);

      case 'OR':
        return values.some(Boolean);

      default:
        console.warn(`Unsupported rollup aggregation: ${aggregationFormula}`);
        return null;
    }
  };
}
