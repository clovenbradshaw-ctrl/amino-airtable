/**
 * Airtable Formula Engine — Public API
 *
 * Entry point for the formula conversion and execution system.
 * Re-exports all public functions from the sub-modules.
 *
 * Usage:
 *   import { parseAirtableFormula, compileFormula, FormulaRegistry } from './src/formulas/index.js';
 *
 * Pipeline:
 *   1. parseAirtableFormula(formulaString) → AST
 *   2. translateToEoIR(fieldId, name, ast, raw, resultType, ctx) → EO-IR descriptor
 *   3. compileFormula(ast) → executable function
 *   4. FormulaRegistry orchestrates all of the above per-table
 */

// Parser
export { parseAirtableFormula, tokenize, collectFieldRefs } from './parser.js';

// EO-IR Translator
export { translateToEoIR, translateLookupToEoIR, translateRollupToEoIR } from './eo-ir.js';

// Compiler
export { compileFormula, FORMULA_RUNTIME } from './compiler.js';

// Relational Compiler
export { compileLookup, compileRollup } from './relational-compiler.js';

// Registry
export { FormulaRegistry } from './registry.js';

// UI
export {
  formatFormulaValue,
  getEpistemicDotClass,
  buildFormulaBarHTML,
  buildProvenanceHTML
} from './ui.js';
