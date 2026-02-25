/**
 * Formula Engine Bridge
 *
 * Exposes the ES-module formula engine to the global (non-module) script in
 * index.html so that renderTable / renderRecordProfile can compute formula
 * column values on the fly for every row.
 */

import { parseAirtableFormula, collectFieldRefs } from './parser.js';
import { compileFormula } from './compiler.js';

window._formulaEngine = {
  parseAirtableFormula,
  collectFieldRefs,
  compileFormula
};
window.dispatchEvent(new CustomEvent('formulaengine:ready'));
