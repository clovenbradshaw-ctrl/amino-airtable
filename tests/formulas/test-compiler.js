/**
 * Tests for the Formula Compiler
 *
 * Run with: node --experimental-vm-modules tests/formulas/test-compiler.js
 */

import { parseAirtableFormula } from '../../src/formulas/parser.js';
import { compileFormula, FORMULA_RUNTIME } from '../../src/formulas/compiler.js';

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

function assertClose(actual, expected, message, epsilon = 0.001) {
  if (Math.abs(actual - expected) < epsilon) {
    passed++;
  } else {
    failed++;
    console.error('FAIL:', message, '- expected', expected, 'got', actual);
  }
}

// Helper: parse and compile a formula, then execute with a record
function exec(formula, record, meta) {
  const ast = parseAirtableFormula(formula);
  const fn = compileFormula(ast);
  return fn(record || {}, meta);
}

// ── Arithmetic ────────────────────────────────────────────────

console.log('=== Arithmetic Tests ===');

assert(exec('{A} + {B}', { A: 10, B: 20 }) === 30, 'addition: 10 + 20 = 30');
assert(exec('{A} - {B}', { A: 50, B: 20 }) === 30, 'subtraction: 50 - 20 = 30');
assert(exec('{A} * {B}', { A: 6, B: 7 }) === 42, 'multiplication: 6 * 7 = 42');
assert(exec('{A} / {B}', { A: 100, B: 4 }) === 25, 'division: 100 / 4 = 25');
assert(exec('{A} / {B}', { A: 100, B: 0 }) === null, 'division by zero: null');
assert(exec('{A} % {B}', { A: 10, B: 3 }) === 1, 'modulo: 10 % 3 = 1');
assert(exec('-{A}', { A: 5 }) === -5, 'unary minus: -5');
assert(exec('{A} + {B}', { A: null, B: 5 }) === 5, 'null coercion: null + 5 = 5');

// ── Comparison ────────────────────────────────────────────────

console.log('\n=== Comparison Tests ===');

assert(exec('{A} = {B}', { A: 5, B: 5 }) === true, 'equal: true');
assert(exec('{A} = {B}', { A: 5, B: 6 }) === false, 'equal: false');
assert(exec('{A} != {B}', { A: 5, B: 6 }) === true, 'not equal: true');
assert(exec('{A} < {B}', { A: 3, B: 5 }) === true, 'less than: true');
assert(exec('{A} > {B}', { A: 5, B: 3 }) === true, 'greater than: true');
assert(exec('{A} <= {B}', { A: 5, B: 5 }) === true, 'lte: true');
assert(exec('{A} >= {B}', { A: 5, B: 5 }) === true, 'gte: true');

// ── String Concatenation ─────────────────────────────────────

console.log('\n=== String Concatenation Tests ===');

assert(exec('{A} & " " & {B}', { A: 'Hello', B: 'World' }) === 'Hello World', 'concat with &');
assert(exec('{A} & {B}', { A: null, B: 'test' }) === 'test', 'concat with null');

// ── Literals ──────────────────────────────────────────────────

console.log('\n=== Literal Tests ===');

assert(exec('42') === 42, 'number literal');
assert(exec('"hello"') === 'hello', 'string literal');
assert(exec('TRUE()') === true, 'TRUE()');
assert(exec('FALSE()') === false, 'FALSE()');
assert(exec('BLANK()') === null, 'BLANK()');

// ── Math Functions ────────────────────────────────────────────

console.log('\n=== Math Function Tests ===');

assert(exec('ABS(-5)') === 5, 'ABS(-5)');
assert(exec('ABS(5)') === 5, 'ABS(5)');
assert(exec('CEILING(4.2)') === 5, 'CEILING(4.2)');
assert(exec('FLOOR(4.8)') === 4, 'FLOOR(4.8)');
assert(exec('ROUND(3.456, 2)') === 3.46, 'ROUND(3.456, 2)');
assert(exec('ROUND(3.5)') === 4, 'ROUND(3.5)');
assert(exec('INT(4.9)') === 4, 'INT(4.9)');
assert(exec('MAX(1, 5, 3)') === 5, 'MAX(1, 5, 3)');
assert(exec('MIN(1, 5, 3)') === 1, 'MIN(1, 5, 3)');
assert(exec('MOD(10, 3)') === 1, 'MOD(10, 3)');
assert(exec('POWER(2, 10)') === 1024, 'POWER(2, 10)');
assert(exec('SQRT(144)') === 12, 'SQRT(144)');
assert(exec('SUM(1, 2, 3, 4)') === 10, 'SUM(1, 2, 3, 4)');
assert(exec('EVEN(3)') === 4, 'EVEN(3)');
assert(exec('ODD(4)') === 5, 'ODD(4)');
assert(exec('VALUE("42.5")') === 42.5, 'VALUE("42.5")');

// ── Text Functions ────────────────────────────────────────────

console.log('\n=== Text Function Tests ===');

assert(exec('CONCATENATE("a", "b", "c")') === 'abc', 'CONCATENATE');
assert(exec('LEN("hello")') === 5, 'LEN');
assert(exec('LOWER("HELLO")') === 'hello', 'LOWER');
assert(exec('UPPER("hello")') === 'HELLO', 'UPPER');
assert(exec('TRIM("  hi  ")') === 'hi', 'TRIM');
assert(exec('LEFT("hello", 3)') === 'hel', 'LEFT');
assert(exec('RIGHT("hello", 3)') === 'llo', 'RIGHT');
assert(exec('MID("hello", 2, 3)') === 'ell', 'MID');
assert(exec('REPT("ab", 3)') === 'ababab', 'REPT');
assert(exec('FIND("ll", "hello")') === 3, 'FIND');
assert(exec('SEARCH("LL", "hello")') === 3, 'SEARCH (case-insensitive)');
assert(exec('SUBSTITUTE("hello world", "world", "earth")') === 'hello earth', 'SUBSTITUTE');
assert(exec('REPLACE("hello", 2, 3, "XY")') === 'hXYo', 'REPLACE');
assert(exec('T("hello")') === 'hello', 'T(string)');
assert(exec('T(42)') === '', 'T(number)');

// ── Logical Functions ─────────────────────────────────────────

console.log('\n=== Logical Function Tests ===');

assert(exec('IF(TRUE(), "yes", "no")') === 'yes', 'IF true');
assert(exec('IF(FALSE(), "yes", "no")') === 'no', 'IF false');
assert(exec('IF({Score} > 90, "A", "B")', { Score: 95 }) === 'A', 'IF with comparison');
assert(exec('IF({Score} > 90, "A", "B")', { Score: 85 }) === 'B', 'IF with comparison false');
assert(exec('AND(TRUE(), TRUE())') === true, 'AND true');
assert(exec('AND(TRUE(), FALSE())') === false, 'AND false');
assert(exec('OR(FALSE(), TRUE())') === true, 'OR true');
assert(exec('OR(FALSE(), FALSE())') === false, 'OR false');
assert(exec('NOT(TRUE())') === false, 'NOT true');
assert(exec('NOT(FALSE())') === true, 'NOT false');
assert(exec('REGEX_MATCH("abc-123", "[a-z]+-[0-9]+")') === true, 'REGEX_MATCH true');
assert(exec('REGEX_REPLACE("(555) 123-4567", "[^0-9]", "")') === '5551234567', 'REGEX_REPLACE strips punctuation');
assert(exec('REGEX_EXTRACT("Order #12345 received", "[0-9]+")') === '12345', 'REGEX_EXTRACT captures digits');
assert(exec('REGEX_EXTRACT("no match here", "[0-9]+")') === null, 'REGEX_EXTRACT returns null on no match');
assert(exec('REGEX_EXTRACT("John Smith - Attorney", "^[^-]+")').trim() === 'John Smith', 'REGEX_EXTRACT extracts before dash');
assert(exec('ISERROR(ERROR())') === true, 'ISERROR catches error object');
assert(exec('ISERROR(123)') === false, 'ISERROR false for scalar');

{
  const result = exec('SWITCH({Status}, "draft", 1, "review", 2, "final", 3, 0)', { Status: 'review' });
  assert(result === 2, 'SWITCH matched case');
}
{
  const result = exec('SWITCH({Status}, "draft", 1, "review", 2, 0)', { Status: 'unknown' });
  assert(result === 0, 'SWITCH default case');
}

assert(exec('COUNT(1, 2, "a", 3)') === 3, 'COUNT');
assert(exec('COUNTA(1, "", "a", BLANK())') === 2, 'COUNTA');
assert(exec('COUNTALL(1, "", "a", BLANK())') === 4, 'COUNTALL');

// ── Date Functions ────────────────────────────────────────────

console.log('\n=== Date Function Tests ===');

{
  const result = exec('YEAR("2025-06-15")');
  assert(result === 2025, 'YEAR');
}

{
  const result = exec('MONTH("2025-06-15")');
  assert(result === 6, 'MONTH');
}

{
  const result = exec('DAY("2025-06-15")');
  assert(result === 15, 'DAY');
}

{
  // DATETIME_DIFF — the key formula from the spec
  const result = exec(
    'DATETIME_DIFF({Biometrics Date}, {DOB}, "years")',
    { 'Biometrics Date': '2025-06-15', 'DOB': '1990-03-20' }
  );
  assert(result === 35, 'DATETIME_DIFF years: 35');
}

{
  const result = exec(
    'DATETIME_DIFF({End}, {Start}, "days")',
    { End: '2025-06-15', Start: '2025-06-10' }
  );
  assert(result === 5, 'DATETIME_DIFF days: 5');
}

{
  const result = exec('IS_BEFORE("2020-01-01", "2025-01-01")');
  assert(result === true, 'IS_BEFORE: true');
}

{
  const result = exec('IS_AFTER("2025-01-01", "2020-01-01")');
  assert(result === true, 'IS_AFTER: true');
}

{
  const result = exec('DATESTR("2025-06-15T10:30:00Z")');
  // Note: this depends on local timezone; the date portion should be correct
  assert(typeof result === 'string' && result.includes('2025'), 'DATESTR returns string with year');
}

// ── Array Functions ───────────────────────────────────────────

console.log('\n=== Array Function Tests ===');

assert(exec('ARRAYJOIN({A}, ", ")', { A: ['x', 'y', 'z'] }) === 'x, y, z', 'ARRAYJOIN');
assert(JSON.stringify(exec('ARRAYCOMPACT({A})', { A: ['a', '', null, 'b'] })) === '["a","b"]', 'ARRAYCOMPACT');
assert(JSON.stringify(exec('ARRAYUNIQUE({A})', { A: [1, 2, 2, 3, 1] })) === '[1,2,3]', 'ARRAYUNIQUE');
assert(JSON.stringify(exec('ARRAYSLICE({A}, 1, 3)', { A: [10, 20, 30, 40] })) === '[20,30]', 'ARRAYSLICE');

// ── Record Meta Functions ─────────────────────────────────────

console.log('\n=== Record Meta Tests ===');

{
  const result = exec('RECORD_ID()', {}, { recordId: 'rec123' });
  assert(result === 'rec123', 'RECORD_ID()');
}

{
  const result = exec('CREATED_TIME()', {}, { createdTime: '2025-01-01T00:00:00Z' });
  assert(result instanceof Date, 'CREATED_TIME() returns Date');
}

// ── Error Handling ────────────────────────────────────────────

console.log('\n=== Error Handling Tests ===');

{
  const result = exec('ERROR()');
  assert(result && result.__error === true, 'ERROR() returns error object');
}

{
  // Ensure compilation errors are caught gracefully
  const ast = parseAirtableFormula('{A} / {B}');
  const fn = compileFormula(ast);
  const result = fn({ A: 100, B: 0 });
  assert(result === null, 'Division by zero returns null');
}

{
  // Unknown functions should compile gracefully and return null at runtime
  const ast = parseAirtableFormula('SOME_FUTURE_FUNCTION({Name})');
  const fn = compileFormula(ast);
  const result = fn({ Name: 'test' });
  assert(result === null, 'Unknown function returns null gracefully');
}

{
  // Formulas mixing known + unknown functions should still compute known parts
  const ast = parseAirtableFormula('IF(UNKNOWN_FN({A}), "yes", "no")');
  const fn = compileFormula(ast);
  const result = fn({ A: 'test' });
  assert(result === 'no', 'Unknown fn returns null (falsy) so IF falls to else');
}

// ── Complex Formulas ──────────────────────────────────────────

console.log('\n=== Complex Formula Tests ===');

{
  // Nested: ROUND(SUM(...), 2)
  const result = exec('ROUND(SUM({A}, {B}, {C}), 2)', { A: 1.111, B: 2.222, C: 3.333 });
  assertClose(result, 6.67, 'ROUND(SUM(...), 2)', 0.01);
}

{
  // IF with nested comparison and arithmetic
  const result = exec(
    'IF({Total} > 100, {Total} * 0.9, {Total})',
    { Total: 150 }
  );
  assertClose(result, 135, 'IF with arithmetic', 0.01);
}

{
  // Concatenation with function results
  const result = exec(
    'CONCATENATE({First}, " ", UPPER({Last}))',
    { First: 'John', Last: 'doe' }
  );
  assert(result === 'John DOE', 'CONCATENATE with UPPER');
}

{
  // Multi-level operator precedence
  const result = exec('{A} + {B} * {C} - {D}', { A: 10, B: 3, C: 4, D: 2 });
  assert(result === 20, 'precedence: 10 + 3*4 - 2 = 20');
}

// ── Summary ───────────────────────────────────────────────────

console.log(`\n=== Compiler Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
