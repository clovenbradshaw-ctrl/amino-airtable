/**
 * Formula Registry
 *
 * Orchestrates the full formula compilation pipeline:
 * 1. Load field definitions from amino.field_registry
 * 2. Build dependency graph between computed fields
 * 3. Topological sort for evaluation order
 * 4. Compile each field (formula, lookup, rollup)
 * 5. Provide a single interface for the renderer
 *
 * Public API:
 *   registry.compile()                      — compile all computed fields
 *   registry.getCompiledField(fieldId)       — get a single compiled field
 *   registry.getCompiledFieldByName(name)    — lookup by name
 *   registry.computeRecord(record, meta)     — compute all formula values for a row
 *   registry.getAllCompiled()                — get all compiled fields
 */

import { parseAirtableFormula, collectFieldRefs } from './parser.js';
import { translateToEoIR, translateLookupToEoIR, translateRollupToEoIR } from './eo-ir.js';
import { compileFormula } from './compiler.js';
import { compileLookup, compileRollup } from './relational-compiler.js';

/**
 * @typedef {Object} CompiledField
 * @property {string} fieldId
 * @property {string} fieldName
 * @property {'formula'|'rollup'|'lookup'} fieldType
 * @property {function(object, object=): any} execute - (record, meta?) => value
 * @property {object|null} eoIR - Full EO-IR descriptor for provenance
 * @property {string[]} sourceFieldNames - Field names this computation reads
 * @property {{type: string, options?: object}} resultType
 */

/**
 * @typedef {Object} FieldRegistryEntry
 * @property {string} fieldId
 * @property {string} fieldName
 * @property {string} fieldType
 * @property {boolean} isComputed
 * @property {string} tableId
 * @property {object} [options]
 */

// Field types that are computed (not directly editable)
const COMPUTED_FIELD_TYPES = new Set([
  'formula', 'rollup', 'lookup', 'count',
  'autoNumber', 'createdTime', 'lastModifiedTime',
  'createdBy', 'lastModifiedBy'
]);

export class FormulaRegistry {
  /**
   * @param {FieldRegistryEntry[]} fieldEntries - All fields for the table
   * @param {import('./relational-compiler.js').DataContext} dataContext - All table data
   * @param {string} tableId - Current table ID
   * @param {string} baseId - Airtable base ID
   */
  constructor(fieldEntries, dataContext, tableId, baseId) {
    this.fieldEntries = fieldEntries;
    this.dataContext = dataContext;
    this.tableId = tableId;
    this.baseId = baseId;

    /** @type {Map<string, CompiledField>} */
    this.compiled = new Map();

    /** @type {string[]} */
    this.dependencyOrder = [];
  }

  /**
   * Compile all computed fields in dependency order.
   */
  compile() {
    // Separate computed from non-computed fields
    const computedFields = this.fieldEntries.filter(f =>
      f.isComputed || COMPUTED_FIELD_TYPES.has(f.fieldType)
    );

    // Build dependency graph and topological sort
    const deps = this._buildDependencyGraph(computedFields);
    this.dependencyOrder = this._topologicalSort(deps);

    // Compile each field in dependency order
    for (const fieldId of this.dependencyOrder) {
      const entry = computedFields.find(f => f.fieldId === fieldId);
      if (!entry) continue;

      try {
        this._compileField(entry);
      } catch (e) {
        console.error(`Failed to compile ${entry.fieldName}: ${e.message}`);
        // Register a stub that returns the error
        this.compiled.set(fieldId, {
          fieldId: entry.fieldId,
          fieldName: entry.fieldName,
          fieldType: entry.fieldType,
          execute: () => ({ __error: true, message: `Compile error: ${e.message}` }),
          eoIR: null,
          sourceFieldNames: [],
          resultType: { type: 'error' }
        });
      }
    }
  }

  /**
   * Compile a single field entry.
   * @param {FieldRegistryEntry} entry
   * @private
   */
  _compileField(entry) {
    const options = entry.options || {};
    const capturedAt = new Date().toISOString();

    if (entry.fieldType === 'formula') {
      const formulaStr = options.formula;
      if (!formulaStr) throw new Error('No formula string in field options');

      const ast = parseAirtableFormula(formulaStr);
      const fieldRegistry = new Map(
        this.fieldEntries.map(f => [f.fieldName, f])
      );

      const ctx = {
        tableId: this.tableId,
        fieldRegistry,
        baseId: this.baseId,
        capturedAt
      };

      const eoIR = translateToEoIR(
        entry.fieldId, entry.fieldName, ast, formulaStr,
        options.result || { type: 'string' },
        ctx
      );

      const executeFn = compileFormula(ast);

      this.compiled.set(entry.fieldId, {
        fieldId: entry.fieldId,
        fieldName: entry.fieldName,
        fieldType: 'formula',
        execute: executeFn,
        eoIR,
        sourceFieldNames: eoIR.sourceFields.map(f => f.fieldName),
        resultType: options.result || { type: 'string' }
      });

    } else if (entry.fieldType === 'lookup') {
      const linkedTableId = this._resolveLinkedTable(options.recordLinkFieldId);
      const foreignFieldName = this._resolveFieldName(options.fieldIdInLinkedTable, linkedTableId);
      const linkFieldName = this._resolveFieldName(options.recordLinkFieldId, this.tableId);

      const executeFn = compileLookup(
        linkFieldName, foreignFieldName, this.dataContext, linkedTableId
      );

      const fieldRegistry = new Map(
        this.fieldEntries.map(f => [f.fieldName, f])
      );

      const ctx = {
        tableId: this.tableId,
        fieldRegistry,
        baseId: this.baseId,
        capturedAt
      };

      const eoIR = translateLookupToEoIR(
        entry.fieldId, entry.fieldName,
        options.recordLinkFieldId, linkFieldName,
        options.fieldIdInLinkedTable, foreignFieldName,
        linkedTableId,
        options.result || { type: 'string' },
        ctx
      );

      this.compiled.set(entry.fieldId, {
        fieldId: entry.fieldId,
        fieldName: entry.fieldName,
        fieldType: 'lookup',
        execute: (record) => executeFn(record),
        eoIR,
        sourceFieldNames: [linkFieldName],
        resultType: options.result || { type: 'string' }
      });

    } else if (entry.fieldType === 'rollup') {
      const linkedTableId = this._resolveLinkedTable(options.recordLinkFieldId);
      const foreignFieldName = this._resolveFieldName(options.fieldIdInLinkedTable, linkedTableId);
      const linkFieldName = this._resolveFieldName(options.recordLinkFieldId, this.tableId);
      const aggregation = options.formula || 'ARRAYJOIN(values)';

      const executeFn = compileRollup(
        linkFieldName, foreignFieldName, aggregation, this.dataContext, linkedTableId
      );

      const fieldRegistry = new Map(
        this.fieldEntries.map(f => [f.fieldName, f])
      );

      const ctx = {
        tableId: this.tableId,
        fieldRegistry,
        baseId: this.baseId,
        capturedAt
      };

      const eoIR = translateRollupToEoIR(
        entry.fieldId, entry.fieldName,
        options.recordLinkFieldId, linkFieldName,
        options.fieldIdInLinkedTable, foreignFieldName,
        linkedTableId, aggregation,
        options.result || { type: 'string' },
        ctx
      );

      this.compiled.set(entry.fieldId, {
        fieldId: entry.fieldId,
        fieldName: entry.fieldName,
        fieldType: 'rollup',
        execute: (record) => executeFn(record),
        eoIR,
        sourceFieldNames: [linkFieldName],
        resultType: options.result || { type: 'string' }
      });
    }
  }

  // ── Public API ──────────────────────────────────────────────

  /**
   * Get a compiled field by its field ID.
   * @param {string} fieldId
   * @returns {CompiledField|undefined}
   */
  getCompiledField(fieldId) {
    return this.compiled.get(fieldId);
  }

  /**
   * Get a compiled field by its human-readable name.
   * @param {string} name
   * @returns {CompiledField|undefined}
   */
  getCompiledFieldByName(name) {
    for (const cf of this.compiled.values()) {
      if (cf.fieldName === name) return cf;
    }
    return undefined;
  }

  /**
   * Get all compiled fields.
   * @returns {CompiledField[]}
   */
  getAllCompiled() {
    return [...this.compiled.values()];
  }

  /**
   * Compute all formula values for a record, in dependency order.
   * Returns a new object with all original fields plus computed fields.
   *
   * @param {object} record - Raw record fields { fieldName: value }
   * @param {{recordId?: string, createdTime?: string, lastModifiedTime?: string}} [meta]
   * @returns {object} Record with computed fields filled in
   */
  computeRecord(record, meta) {
    const result = { ...record };
    for (const fieldId of this.dependencyOrder) {
      const cf = this.compiled.get(fieldId);
      if (!cf) continue;
      result[cf.fieldName] = cf.execute(result, meta);
    }
    return result;
  }

  // ── Private Helpers ─────────────────────────────────────────

  /**
   * Resolve which table a link field points to.
   * @param {string} linkFieldId
   * @returns {string} Target table ID
   * @private
   */
  _resolveLinkedTable(linkFieldId) {
    const linkField = this.fieldEntries.find(f => f.fieldId === linkFieldId);
    return (linkField && linkField.options && linkField.options.linkedTableId) || '';
  }

  /**
   * Resolve a field name from its ID within a given table.
   * @param {string} fieldId
   * @param {string} tableId
   * @returns {string} Field name
   * @private
   */
  _resolveFieldName(fieldId, tableId) {
    const field = this.fieldEntries.find(
      f => f.fieldId === fieldId && (f.tableId === tableId || !tableId)
    );
    return field ? field.fieldName : fieldId;
  }

  /**
   * Build a dependency graph: fieldId → Set<fieldId> of dependencies.
   * @param {FieldRegistryEntry[]} computedFields
   * @returns {Map<string, Set<string>>}
   * @private
   */
  _buildDependencyGraph(computedFields) {
    const deps = new Map();
    const nameToId = new Map(
      this.fieldEntries.map(f => [f.fieldName, f.fieldId])
    );

    for (const field of computedFields) {
      const fieldDeps = new Set();

      if (field.fieldType === 'formula' && field.options && field.options.formula) {
        try {
          const ast = parseAirtableFormula(field.options.formula);
          const refs = collectFieldRefs(ast);
          for (const ref of refs) {
            const depId = nameToId.get(ref);
            if (depId) fieldDeps.add(depId);
          }
        } catch (_e) {
          // Parse error — no dependencies detected
        }
      }

      // Lookups and rollups depend on their link field
      if ((field.fieldType === 'lookup' || field.fieldType === 'rollup') &&
          field.options && field.options.recordLinkFieldId) {
        fieldDeps.add(field.options.recordLinkFieldId);
      }

      deps.set(field.fieldId, fieldDeps);
    }

    return deps;
  }

  /**
   * Topological sort — compute dependency-leaves first.
   * Detects circular references.
   * @param {Map<string, Set<string>>} deps
   * @returns {string[]} Sorted field IDs
   * @private
   */
  _topologicalSort(deps) {
    const sorted = [];
    const visited = new Set();
    const visiting = new Set();

    const visit = (id) => {
      if (visited.has(id)) return;
      if (visiting.has(id)) {
        throw new Error(`Circular formula dependency involving ${id}`);
      }
      visiting.add(id);
      for (const dep of deps.get(id) || []) {
        if (deps.has(dep)) visit(dep);
      }
      visiting.delete(id);
      visited.add(id);
      sorted.push(id);
    };

    for (const id of deps.keys()) {
      visit(id);
    }

    return sorted;
  }
}
