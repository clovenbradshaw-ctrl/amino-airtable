/**
 * Tests for the EO-IR Translator
 *
 * Run with: node --experimental-vm-modules tests/formulas/test-eo-ir.js
 */

import { parseAirtableFormula } from '../../src/formulas/parser.js';
import { translateToEoIR, translateLookupToEoIR, translateRollupToEoIR } from '../../src/formulas/eo-ir.js';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error('FAIL:', message);
  }
}

// ── Translation Context ───────────────────────────────────────

const fieldRegistry = new Map([
  ['Biometrics Date', { fieldId: 'fld001', fieldName: 'Biometrics Date', fieldType: 'date', isComputed: false, tableId: 'tbl001' }],
  ['DOB', { fieldId: 'fld002', fieldName: 'DOB', fieldType: 'date', isComputed: false, tableId: 'tbl001' }],
  ['Score', { fieldId: 'fld003', fieldName: 'Score', fieldType: 'number', isComputed: false, tableId: 'tbl001' }],
  ['Tax', { fieldId: 'fld004', fieldName: 'Tax', fieldType: 'formula', isComputed: true, tableId: 'tbl001' }],
]);

const ctx = {
  tableId: 'tbl001',
  fieldRegistry,
  baseId: 'appXYZ',
  capturedAt: '2025-01-01T00:00:00Z',
};

// ── Basic Formula Translation ─────────────────────────────────

console.log('=== EO-IR Translation Tests ===');

{
  const formula = 'DATETIME_DIFF({Biometrics Date}, {DOB}, "years")';
  const ast = parseAirtableFormula(formula);
  const eoIR = translateToEoIR('fldAge', 'Est. Age', ast, formula, { type: 'number' }, ctx);

  assert(eoIR.mode === 'DERIVED', 'mode is DERIVED');
  assert(eoIR.derivationType === 'formula', 'derivationType is formula');
  assert(eoIR.fieldId === 'fldAge', 'fieldId preserved');
  assert(eoIR.fieldName === 'Est. Age', 'fieldName preserved');
  assert(eoIR.setId === 'tbl001', 'setId matches tableId');
}

{
  const formula = 'DATETIME_DIFF({Biometrics Date}, {DOB}, "years")';
  const ast = parseAirtableFormula(formula);
  const eoIR = translateToEoIR('fldAge', 'Est. Age', ast, formula, { type: 'number' }, ctx);

  // Source fields
  assert(eoIR.sourceFields.length === 2, 'sourceFields count');
  const bioDate = eoIR.sourceFields.find(sf => sf.fieldName === 'Biometrics Date');
  const dob = eoIR.sourceFields.find(sf => sf.fieldName === 'DOB');
  assert(bioDate && bioDate.epistemicStatus === 'GIVEN', 'Biometrics Date is GIVEN');
  assert(dob && dob.epistemicStatus === 'GIVEN', 'DOB is GIVEN');
  assert(bioDate && bioDate.fieldId === 'fld001', 'Biometrics Date fieldId resolved');
}

{
  const formula = 'DATETIME_DIFF({Biometrics Date}, {DOB}, "years")';
  const ast = parseAirtableFormula(formula);
  const eoIR = translateToEoIR('fldAge', 'Est. Age', ast, formula, { type: 'number' }, ctx);

  // Grounding
  assert(eoIR.grounding.source === 'airtable_schema', 'grounding source');
  assert(eoIR.grounding.baseId === 'appXYZ', 'grounding baseId');
  assert(eoIR.grounding.rawDefinition === formula, 'grounding rawDefinition');
  assert(eoIR.grounding.capturedAt === '2025-01-01T00:00:00Z', 'grounding capturedAt');
}

{
  const formula = 'DATETIME_DIFF({Biometrics Date}, {DOB}, "years")';
  const ast = parseAirtableFormula(formula);
  const eoIR = translateToEoIR('fldAge', 'Est. Age', ast, formula, { type: 'number' }, ctx);

  // Operator chain
  assert(eoIR.operators.length > 0, 'has operators');

  // Should have DES ops for field refs and an ALT op for the function call
  const desOps = eoIR.operators.filter(op => op.op === 'DES');
  const altOps = eoIR.operators.filter(op => op.op === 'ALT');
  assert(desOps.length >= 2, 'at least 2 DES ops for field refs');
  assert(altOps.length >= 1, 'at least 1 ALT op for function call');
}

// ── DERIVED Source Field Detection ────────────────────────────

console.log('\n=== Derived Source Detection ===');

{
  // {Tax} is a computed field
  const formula = '{Score} + {Tax}';
  const ast = parseAirtableFormula(formula);
  const eoIR = translateToEoIR('fldTotal', 'Total', ast, formula, { type: 'number' }, ctx);

  const score = eoIR.sourceFields.find(sf => sf.fieldName === 'Score');
  const tax = eoIR.sourceFields.find(sf => sf.fieldName === 'Tax');
  assert(score && score.epistemicStatus === 'GIVEN', 'Score is GIVEN');
  assert(tax && tax.epistemicStatus === 'DERIVED', 'Tax is DERIVED');
}

// ── Unresolved Field Reference ────────────────────────────────

console.log('\n=== Unresolved Field Refs ===');

{
  const formula = '{Unknown Field} + 1';
  const ast = parseAirtableFormula(formula);
  const eoIR = translateToEoIR('fldX', 'X', ast, formula, { type: 'number' }, ctx);

  const unknown = eoIR.sourceFields.find(sf => sf.fieldName === 'Unknown Field');
  assert(unknown, 'unresolved field is in sourceFields');
  assert(unknown && unknown.fieldId.startsWith('UNRESOLVED:'), 'unresolved field has UNRESOLVED prefix');
}

// ── Operator Types ────────────────────────────────────────────

console.log('\n=== Operator Type Mapping ===');

{
  // SUM should produce a SEG operator
  const formula = 'SUM({Score}, 10)';
  const ast = parseAirtableFormula(formula);
  const eoIR = translateToEoIR('fldSum', 'Sum', ast, formula, { type: 'number' }, ctx);

  const segOps = eoIR.operators.filter(op => op.op === 'SEG');
  assert(segOps.length >= 1, 'SUM produces SEG operator');
  assert(segOps[0].params.aggregation === 'SUM', 'SEG params has aggregation: SUM');
}

{
  // IF should produce an ALT operator
  const formula = 'IF({Score} > 0, "yes", "no")';
  const ast = parseAirtableFormula(formula);
  const eoIR = translateToEoIR('fldIf', 'IfResult', ast, formula, { type: 'string' }, ctx);

  const altOps = eoIR.operators.filter(op => op.op === 'ALT' && op.params.transform === 'function_call');
  assert(altOps.length >= 1, 'IF produces ALT operator with function_call transform');
}

// ── Lookup EO-IR ──────────────────────────────────────────────

console.log('\n=== Lookup EO-IR ===');

{
  const eoIR = translateLookupToEoIR(
    'fldLookup', 'Client Name',
    'fldLink', 'Cases',
    'fldClientName', 'Name',
    'tblClients',
    { type: 'singleLineText' },
    ctx
  );

  assert(eoIR.mode === 'DERIVED', 'lookup mode is DERIVED');
  assert(eoIR.derivationType === 'lookup', 'lookup derivationType');
  assert(eoIR.operators.length === 2, 'lookup has 2 operators');
  assert(eoIR.operators[0].op === 'CON', 'lookup first op is CON');
  assert(eoIR.operators[1].op === 'DES', 'lookup second op is DES');
}

// ── Rollup EO-IR ──────────────────────────────────────────────

console.log('\n=== Rollup EO-IR ===');

{
  const eoIR = translateRollupToEoIR(
    'fldRollup', 'Total Amount',
    'fldLink', 'Cases',
    'fldAmount', 'Amount',
    'tblCases',
    'SUM(values)',
    { type: 'number' },
    ctx
  );

  assert(eoIR.mode === 'DERIVED', 'rollup mode is DERIVED');
  assert(eoIR.derivationType === 'rollup', 'rollup derivationType');
  assert(eoIR.operators.length === 3, 'rollup has 3 operators');
  assert(eoIR.operators[0].op === 'CON', 'rollup first op is CON');
  assert(eoIR.operators[1].op === 'DES', 'rollup second op is DES');
  assert(eoIR.operators[2].op === 'SEG', 'rollup third op is SEG');
  assert(eoIR.operators[2].params.aggregation === 'SUM', 'rollup SEG aggregation is SUM');
}

// ── Summary ───────────────────────────────────────────────────

console.log(`\n=== EO-IR Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
