/**
 * Tests for the Formula Registry
 *
 * Run with: node --experimental-vm-modules tests/formulas/test-registry.js
 */

import { FormulaRegistry } from '../../src/formulas/registry.js';

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

// ── Test Data Setup ───────────────────────────────────────────

const fieldEntries = [
  {
    fieldId: 'fldName',
    fieldName: 'Name',
    fieldType: 'singleLineText',
    isComputed: false,
    tableId: 'tbl001',
    options: {}
  },
  {
    fieldId: 'fldScore',
    fieldName: 'Score',
    fieldType: 'number',
    isComputed: false,
    tableId: 'tbl001',
    options: {}
  },
  {
    fieldId: 'fldBonus',
    fieldName: 'Bonus',
    fieldType: 'number',
    isComputed: false,
    tableId: 'tbl001',
    options: {}
  },
  {
    fieldId: 'fldBioDate',
    fieldName: 'Biometrics Date',
    fieldType: 'date',
    isComputed: false,
    tableId: 'tbl001',
    options: {}
  },
  {
    fieldId: 'fldDOB',
    fieldName: 'DOB',
    fieldType: 'date',
    isComputed: false,
    tableId: 'tbl001',
    options: {}
  },
  // Formula: Total = Score + Bonus
  {
    fieldId: 'fldTotal',
    fieldName: 'Total',
    fieldType: 'formula',
    isComputed: true,
    tableId: 'tbl001',
    options: {
      formula: '{Score} + {Bonus}',
      result: { type: 'number' }
    }
  },
  // Formula: Grade (depends on Total, which is also a formula)
  {
    fieldId: 'fldGrade',
    fieldName: 'Grade',
    fieldType: 'formula',
    isComputed: true,
    tableId: 'tbl001',
    options: {
      formula: 'IF({Total} >= 90, "A", IF({Total} >= 80, "B", "C"))',
      result: { type: 'string' }
    }
  },
  // Formula: Est. Age at biometrics
  {
    fieldId: 'fldAge',
    fieldName: 'Est. Age',
    fieldType: 'formula',
    isComputed: true,
    tableId: 'tbl001',
    options: {
      formula: 'DATETIME_DIFF({Biometrics Date}, {DOB}, "years")',
      result: { type: 'number', options: { precision: 0 } }
    }
  },
  // Formula: Display Name = Name & " (" & Grade & ")"
  {
    fieldId: 'fldDisplay',
    fieldName: 'Display Name',
    fieldType: 'formula',
    isComputed: true,
    tableId: 'tbl001',
    options: {
      formula: '{Name} & " (" & {Grade} & ")"',
      result: { type: 'string' }
    }
  },
];

// Minimal data context (no lookup/rollup in this test)
const dataContext = {
  tables: new Map([
    ['tbl001', new Map()]
  ]),
  fieldRegistry: new Map(),
  tableRegistry: new Map()
};

// ── Registry Compilation ──────────────────────────────────────

console.log('=== Registry Compilation Tests ===');

{
  const registry = new FormulaRegistry(fieldEntries, dataContext, 'tbl001', 'appXYZ');
  registry.compile();

  const allCompiled = registry.getAllCompiled();
  assert(allCompiled.length === 4, 'compiled 4 formula fields');
}

{
  const registry = new FormulaRegistry(fieldEntries, dataContext, 'tbl001', 'appXYZ');
  registry.compile();

  const total = registry.getCompiledFieldByName('Total');
  assert(total !== undefined, 'Total field compiled');
  assert(total.fieldType === 'formula', 'Total is formula type');
  assert(total.sourceFieldNames.includes('Score'), 'Total depends on Score');
  assert(total.sourceFieldNames.includes('Bonus'), 'Total depends on Bonus');
}

{
  const registry = new FormulaRegistry(fieldEntries, dataContext, 'tbl001', 'appXYZ');
  registry.compile();

  const grade = registry.getCompiledField('fldGrade');
  assert(grade !== undefined, 'Grade field compiled by ID');
}

// ── Record Computation ────────────────────────────────────────

console.log('\n=== Record Computation Tests ===');

{
  const registry = new FormulaRegistry(fieldEntries, dataContext, 'tbl001', 'appXYZ');
  registry.compile();

  const record = { Name: 'Alice', Score: 50, Bonus: 45, 'Biometrics Date': '2025-06-15', DOB: '1990-03-20' };
  const computed = registry.computeRecord(record, { recordId: 'rec001' });

  assert(computed.Total === 95, 'Total = 50 + 45 = 95');
  assert(computed.Grade === 'A', 'Grade = A (Total >= 90)');
  assert(computed['Est. Age'] === 35, 'Est. Age = 35');
  assert(computed['Display Name'] === 'Alice (A)', 'Display Name = Alice (A)');
}

{
  const registry = new FormulaRegistry(fieldEntries, dataContext, 'tbl001', 'appXYZ');
  registry.compile();

  const record = { Name: 'Bob', Score: 40, Bonus: 35, 'Biometrics Date': '2025-01-01', DOB: '2000-06-15' };
  const computed = registry.computeRecord(record, { recordId: 'rec002' });

  assert(computed.Total === 75, 'Bob Total = 40 + 35 = 75');
  assert(computed.Grade === 'C', 'Bob Grade = C (Total < 80)');
  assert(computed['Display Name'] === 'Bob (C)', 'Bob Display Name = Bob (C)');
}

{
  const registry = new FormulaRegistry(fieldEntries, dataContext, 'tbl001', 'appXYZ');
  registry.compile();

  // Grade B case
  const record = { Name: 'Carol', Score: 45, Bonus: 40 };
  const computed = registry.computeRecord(record, {});

  assert(computed.Total === 85, 'Carol Total = 85');
  assert(computed.Grade === 'B', 'Carol Grade = B');
}

// ── Dependency Order ──────────────────────────────────────────

console.log('\n=== Dependency Order Tests ===');

{
  const registry = new FormulaRegistry(fieldEntries, dataContext, 'tbl001', 'appXYZ');
  registry.compile();

  // Total must be computed before Grade and Display Name
  const order = registry.dependencyOrder;
  const totalIdx = order.indexOf('fldTotal');
  const gradeIdx = order.indexOf('fldGrade');
  const displayIdx = order.indexOf('fldDisplay');

  assert(totalIdx < gradeIdx, 'Total computed before Grade');
  assert(gradeIdx < displayIdx, 'Grade computed before Display Name');
}

// ── EO-IR Provenance ──────────────────────────────────────────

console.log('\n=== EO-IR Provenance Tests ===');

{
  const registry = new FormulaRegistry(fieldEntries, dataContext, 'tbl001', 'appXYZ');
  registry.compile();

  const total = registry.getCompiledFieldByName('Total');
  assert(total.eoIR !== null, 'Total has EO-IR');
  assert(total.eoIR.mode === 'DERIVED', 'Total EO-IR mode is DERIVED');
  assert(total.eoIR.grounding.rawDefinition === '{Score} + {Bonus}', 'Total rawDefinition preserved');
  assert(total.eoIR.grounding.source === 'airtable_schema', 'Total grounding source');
}

{
  const registry = new FormulaRegistry(fieldEntries, dataContext, 'tbl001', 'appXYZ');
  registry.compile();

  const age = registry.getCompiledFieldByName('Est. Age');
  assert(age.eoIR.sourceFields.length === 2, 'Est. Age has 2 source fields');
  assert(age.eoIR.operators.length > 0, 'Est. Age has operators');
}

// ── Error Handling ────────────────────────────────────────────

console.log('\n=== Error Handling Tests ===');

{
  // Invalid formula should not crash the registry
  const badEntries = [
    ...fieldEntries.filter(f => !f.isComputed),
    {
      fieldId: 'fldBad',
      fieldName: 'Bad Formula',
      fieldType: 'formula',
      isComputed: true,
      tableId: 'tbl001',
      options: {
        formula: 'THIS IS NOT VALID {{{',
        result: { type: 'string' }
      }
    }
  ];

  const registry = new FormulaRegistry(badEntries, dataContext, 'tbl001', 'appXYZ');
  registry.compile();

  const bad = registry.getCompiledField('fldBad');
  assert(bad !== undefined, 'bad formula registered as stub');
  const result = bad.execute({});
  assert(result && result.__error === true, 'bad formula returns error');
}

// ── Summary ───────────────────────────────────────────────────

console.log(`\n=== Registry Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
