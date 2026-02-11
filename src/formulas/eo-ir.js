/**
 * EO-IR (Epistemic-Ontological Intermediate Representation) Translator
 *
 * Translates a FormulaAST into an EO-IR operator chain that captures:
 * - What is being computed (the operation chain)
 * - From what it derives (source GIVEN fields)
 * - How the derivation was defined (Airtable schema as grounding)
 * - When the definition was captured (schema sync timestamp)
 *
 * EO Operators:
 *   DES  — field selection / description (reading a value from a record)
 *   SEG  — segmentation / aggregation (SUM, COUNT, filtering)
 *   CON  — connection traversal (following linked records)
 *   ALT  — transformation (date math, string ops, arithmetic)
 *
 * Epistemic Status:
 *   GIVEN   — user-entered data, directly observed
 *   DERIVED — computed from other fields via formula/rollup/lookup
 */

import { collectFieldRefs } from './parser.js';

/**
 * @typedef {Object} EoIRComputedField
 * @property {string} fieldId - Airtable field ID (fldXYZ)
 * @property {string} fieldName - Human-readable name
 * @property {string} setId - Which set (table) this belongs to
 * @property {'DERIVED'} mode - Always DERIVED for computed fields
 * @property {'formula'|'rollup'|'lookup'} derivationType
 * @property {EoIROperator[]} operators - The operation chain
 * @property {SourceFieldRef[]} sourceFields - Which GIVEN fields feed this computation
 * @property {Grounding} grounding - Where this definition came from
 * @property {{type: string, options?: object}} resultType - Result type from Airtable metadata
 */

/**
 * @typedef {Object} SourceFieldRef
 * @property {string} fieldId
 * @property {string} fieldName
 * @property {string} tableId
 * @property {'GIVEN'|'DERIVED'} epistemicStatus
 */

/**
 * @typedef {Object} EoIROperator
 * @property {'DES'|'SEG'|'CON'|'ALT'} op
 * @property {object} params
 * @property {string[]} inputs - Field IDs or prior operator output symbols
 * @property {string} output - Symbolic name for result
 */

/**
 * @typedef {Object} Grounding
 * @property {'airtable_schema'} source
 * @property {string} baseId
 * @property {string} tableId
 * @property {string} fieldId
 * @property {string} capturedAt - ISO timestamp of schema sync
 * @property {string} schemaVersion - Hash or version of field_registry snapshot
 * @property {string} rawDefinition - Original Airtable formula string
 */

/**
 * @typedef {Object} TranslationContext
 * @property {string} tableId
 * @property {Map<string, object>} fieldRegistry - fieldName → FieldRegistryEntry
 * @property {string} baseId
 * @property {string} capturedAt - ISO timestamp
 */

// Aggregation function names that map to SEG operator
const AGGREGATION_FUNCTIONS = new Set([
  'SUM', 'COUNT', 'COUNTA', 'COUNTALL', 'MAX', 'MIN', 'AVERAGE'
]);

/**
 * Build an EO-IR operator chain from a FormulaAST.
 * Flattens the tree into a linear sequence of operators.
 *
 * @param {object} ast - FormulaAST node
 * @param {TranslationContext} ctx
 * @returns {EoIROperator[]}
 */
function buildOperatorChain(ast, ctx) {
  const ops = [];
  let counter = 0;

  function emit(op, params, inputs) {
    const output = `_v${counter++}`;
    ops.push({ op, params, inputs, output });
    return output;
  }

  function translate(node) {
    switch (node.type) {
      case 'field_ref': {
        const entry = ctx.fieldRegistry.get(node.name);
        const fieldId = entry ? entry.fieldId : `UNRESOLVED:${node.name}`;
        return emit('DES', { field: node.name, fieldId }, [fieldId]);
      }
      case 'literal': {
        return emit('ALT', {
          transform: 'literal',
          value: node.value,
          dataType: node.dataType
        }, []);
      }
      case 'binary_op': {
        const leftRef = translate(node.left);
        const rightRef = translate(node.right);
        return emit('ALT', {
          transform: 'binary_op',
          op: node.op
        }, [leftRef, rightRef]);
      }
      case 'unary_op': {
        const operandRef = translate(node.operand);
        return emit('ALT', {
          transform: 'unary_op',
          op: node.op
        }, [operandRef]);
      }
      case 'function_call': {
        const argRefs = node.args.map(translate);
        if (AGGREGATION_FUNCTIONS.has(node.name)) {
          return emit('SEG', { aggregation: node.name }, argRefs);
        }
        return emit('ALT', {
          transform: 'function_call',
          function: node.name
        }, argRefs);
      }
      default:
        throw new Error(`Unknown AST node type: ${node.type}`);
    }
  }

  translate(ast);
  return ops;
}

/**
 * Translate a parsed formula AST into a full EO-IR computed field descriptor.
 *
 * @param {string} fieldId - Airtable field ID
 * @param {string} fieldName - Human-readable field name
 * @param {object} ast - FormulaAST root node
 * @param {string} rawFormula - Original Airtable formula string
 * @param {{type: string, options?: object}} resultType - Expected result type
 * @param {TranslationContext} ctx
 * @returns {EoIRComputedField}
 */
export function translateToEoIR(fieldId, fieldName, ast, rawFormula, resultType, ctx) {
  const fieldRefs = collectFieldRefs(ast);

  const sourceFields = fieldRefs.map(name => {
    const entry = ctx.fieldRegistry.get(name);
    if (!entry) {
      return {
        fieldId: `UNRESOLVED:${name}`,
        fieldName: name,
        tableId: ctx.tableId,
        epistemicStatus: 'GIVEN'
      };
    }
    return {
      fieldId: entry.fieldId,
      fieldName: entry.fieldName,
      tableId: entry.tableId || ctx.tableId,
      epistemicStatus: entry.isComputed ? 'DERIVED' : 'GIVEN'
    };
  });

  const operators = buildOperatorChain(ast, ctx);

  return {
    fieldId,
    fieldName,
    setId: ctx.tableId,
    mode: 'DERIVED',
    derivationType: 'formula',
    operators,
    sourceFields,
    grounding: {
      source: 'airtable_schema',
      baseId: ctx.baseId,
      tableId: ctx.tableId,
      fieldId,
      capturedAt: ctx.capturedAt,
      schemaVersion: `field_registry:${ctx.capturedAt}`,
      rawDefinition: rawFormula
    },
    resultType
  };
}

/**
 * Build an EO-IR descriptor for a lookup field.
 *
 * @param {string} fieldId
 * @param {string} fieldName
 * @param {string} linkFieldId - Record link field ID
 * @param {string} linkFieldName - Record link field name
 * @param {string} foreignFieldId - Field ID in linked table
 * @param {string} foreignFieldName - Field name in linked table
 * @param {string} linkedTableId - Target table ID
 * @param {{type: string, options?: object}} resultType
 * @param {TranslationContext} ctx
 * @returns {EoIRComputedField}
 */
export function translateLookupToEoIR(
  fieldId, fieldName,
  linkFieldId, linkFieldName,
  foreignFieldId, foreignFieldName,
  linkedTableId, resultType, ctx
) {
  const operators = [
    {
      op: 'CON',
      params: {
        traversal: 'linked_record',
        linkField: linkFieldName,
        linkFieldId,
        targetTable: linkedTableId
      },
      inputs: [linkFieldId],
      output: '_linked_records'
    },
    {
      op: 'DES',
      params: {
        field: foreignFieldName,
        fieldId: foreignFieldId,
        sourceTable: linkedTableId
      },
      inputs: ['_linked_records'],
      output: '_lookup_result'
    }
  ];

  return {
    fieldId,
    fieldName,
    setId: ctx.tableId,
    mode: 'DERIVED',
    derivationType: 'lookup',
    operators,
    sourceFields: [{
      fieldId: linkFieldId,
      fieldName: linkFieldName,
      tableId: ctx.tableId,
      epistemicStatus: 'GIVEN'
    }],
    grounding: {
      source: 'airtable_schema',
      baseId: ctx.baseId,
      tableId: ctx.tableId,
      fieldId,
      capturedAt: ctx.capturedAt,
      schemaVersion: `field_registry:${ctx.capturedAt}`,
      rawDefinition: `LOOKUP({${linkFieldName}}, {${foreignFieldName}})`
    },
    resultType
  };
}

/**
 * Build an EO-IR descriptor for a rollup field.
 *
 * @param {string} fieldId
 * @param {string} fieldName
 * @param {string} linkFieldId
 * @param {string} linkFieldName
 * @param {string} foreignFieldId
 * @param {string} foreignFieldName
 * @param {string} linkedTableId
 * @param {string} aggregationFormula - e.g. "SUM(values)"
 * @param {{type: string, options?: object}} resultType
 * @param {TranslationContext} ctx
 * @returns {EoIRComputedField}
 */
export function translateRollupToEoIR(
  fieldId, fieldName,
  linkFieldId, linkFieldName,
  foreignFieldId, foreignFieldName,
  linkedTableId, aggregationFormula, resultType, ctx
) {
  const aggName = aggregationFormula.replace(/\(values\)/i, '').trim().toUpperCase();

  const operators = [
    {
      op: 'CON',
      params: {
        traversal: 'linked_record',
        linkField: linkFieldName,
        linkFieldId,
        targetTable: linkedTableId
      },
      inputs: [linkFieldId],
      output: '_linked_records'
    },
    {
      op: 'DES',
      params: {
        field: foreignFieldName,
        fieldId: foreignFieldId,
        sourceTable: linkedTableId
      },
      inputs: ['_linked_records'],
      output: '_lookup_values'
    },
    {
      op: 'SEG',
      params: {
        aggregation: aggName,
        formula: aggregationFormula
      },
      inputs: ['_lookup_values'],
      output: '_rollup_result'
    }
  ];

  return {
    fieldId,
    fieldName,
    setId: ctx.tableId,
    mode: 'DERIVED',
    derivationType: 'rollup',
    operators,
    sourceFields: [{
      fieldId: linkFieldId,
      fieldName: linkFieldName,
      tableId: ctx.tableId,
      epistemicStatus: 'GIVEN'
    }],
    grounding: {
      source: 'airtable_schema',
      baseId: ctx.baseId,
      tableId: ctx.tableId,
      fieldId,
      capturedAt: ctx.capturedAt,
      schemaVersion: `field_registry:${ctx.capturedAt}`,
      rawDefinition: `ROLLUP({${linkFieldName}}, {${foreignFieldName}}, ${aggregationFormula})`
    },
    resultType
  };
}
