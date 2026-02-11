/**
 * Tests for the Airtable Formula Parser
 *
 * Run with: node --experimental-vm-modules tests/formulas/test-parser.js
 * Or load in browser via test-runner.html
 */

import { parseAirtableFormula, tokenize, collectFieldRefs } from '../../src/formulas/parser.js';

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

function assertDeepEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
  } else {
    failed++;
    console.error('FAIL:', message);
    console.error('  Expected:', e);
    console.error('  Actual:  ', a);
  }
}

// ── Tokenizer Tests ───────────────────────────────────────────

console.log('=== Tokenizer Tests ===');

{
  const tokens = tokenize('{Field Name}');
  assert(tokens.length === 2, 'field ref: token count');
  assert(tokens[0].type === 'FIELD_REF', 'field ref: type');
  assert(tokens[0].value === 'Field Name', 'field ref: value');
  assert(tokens[1].type === 'EOF', 'field ref: EOF');
}

{
  const tokens = tokenize('"hello world"');
  assert(tokens[0].type === 'STRING', 'string literal: type');
  assert(tokens[0].value === 'hello world', 'string literal: value');
}

{
  const tokens = tokenize("'single quoted'");
  assert(tokens[0].type === 'STRING', 'single-quoted string: type');
  assert(tokens[0].value === 'single quoted', 'single-quoted string: value');
}

{
  const tokens = tokenize('42');
  assert(tokens[0].type === 'NUMBER', 'number: type');
  assert(tokens[0].value === 42, 'number: value');
}

{
  const tokens = tokenize('3.14');
  assert(tokens[0].type === 'NUMBER', 'float: type');
  assert(tokens[0].value === 3.14, 'float: value');
}

{
  const tokens = tokenize('{A} + {B}');
  assert(tokens.length === 4, 'binary op tokens: count');
  assert(tokens[0].type === 'FIELD_REF', 'binary: field A');
  assert(tokens[1].type === 'OP' && tokens[1].value === '+', 'binary: +');
  assert(tokens[2].type === 'FIELD_REF', 'binary: field B');
}

{
  const tokens = tokenize('!=');
  assert(tokens[0].type === 'OP' && tokens[0].value === '!=', 'two-char op: !=');
}

{
  const tokens = tokenize('<=');
  assert(tokens[0].type === 'OP' && tokens[0].value === '<=', 'two-char op: <=');
}

{
  const tokens = tokenize('>=');
  assert(tokens[0].type === 'OP' && tokens[0].value === '>=', 'two-char op: >=');
}

{
  const tokens = tokenize('SUM({A}, {B})');
  assert(tokens[0].type === 'IDENT' && tokens[0].value === 'SUM', 'function ident');
  assert(tokens[1].type === 'LPAREN', 'function (');
  assert(tokens[2].type === 'FIELD_REF', 'function arg A');
  assert(tokens[3].type === 'COMMA', 'function comma');
  assert(tokens[4].type === 'FIELD_REF', 'function arg B');
  assert(tokens[5].type === 'RPAREN', 'function )');
}

{
  // Escaped quote in string
  const tokens = tokenize('"hello \\"world\\""');
  assert(tokens[0].value === 'hello "world"', 'escaped quotes in string');
}

// ── Parser Tests ──────────────────────────────────────────────

console.log('\n=== Parser Tests ===');

{
  const ast = parseAirtableFormula('{Name}');
  assertDeepEqual(ast, { type: 'field_ref', name: 'Name' }, 'parse field ref');
}

{
  const ast = parseAirtableFormula('42');
  assertDeepEqual(ast, { type: 'literal', value: 42, dataType: 'number' }, 'parse number');
}

{
  const ast = parseAirtableFormula('"hello"');
  assertDeepEqual(ast, { type: 'literal', value: 'hello', dataType: 'string' }, 'parse string');
}

{
  const ast = parseAirtableFormula('TRUE()');
  assertDeepEqual(ast, { type: 'literal', value: true, dataType: 'boolean' }, 'parse TRUE()');
}

{
  const ast = parseAirtableFormula('FALSE()');
  assertDeepEqual(ast, { type: 'literal', value: false, dataType: 'boolean' }, 'parse FALSE()');
}

{
  const ast = parseAirtableFormula('BLANK()');
  assertDeepEqual(ast, { type: 'literal', value: null, dataType: 'null' }, 'parse BLANK()');
}

{
  const ast = parseAirtableFormula('{A} + {B}');
  assert(ast.type === 'binary_op', 'addition: type');
  assert(ast.op === '+', 'addition: op');
  assert(ast.left.type === 'field_ref' && ast.left.name === 'A', 'addition: left');
  assert(ast.right.type === 'field_ref' && ast.right.name === 'B', 'addition: right');
}

{
  // Operator precedence: * before +
  const ast = parseAirtableFormula('{A} + {B} * {C}');
  assert(ast.type === 'binary_op' && ast.op === '+', 'precedence: top is +');
  assert(ast.right.type === 'binary_op' && ast.right.op === '*', 'precedence: right is *');
}

{
  const ast = parseAirtableFormula('-{X}');
  assert(ast.type === 'unary_op', 'unary: type');
  assert(ast.op === '-', 'unary: op');
  assert(ast.operand.type === 'field_ref' && ast.operand.name === 'X', 'unary: operand');
}

{
  const ast = parseAirtableFormula('({A} + {B}) * {C}');
  assert(ast.type === 'binary_op' && ast.op === '*', 'parenthesized: top is *');
  assert(ast.left.type === 'binary_op' && ast.left.op === '+', 'parenthesized: left is +');
}

{
  const ast = parseAirtableFormula('IF({Score} > 90, "A", "B")');
  assert(ast.type === 'function_call', 'IF: type');
  assert(ast.name === 'IF', 'IF: name');
  assert(ast.args.length === 3, 'IF: 3 args');
  assert(ast.args[0].type === 'binary_op' && ast.args[0].op === '>', 'IF: condition is >');
}

{
  const ast = parseAirtableFormula('DATETIME_DIFF({Biometrics Date}, {DOB}, "years")');
  assert(ast.type === 'function_call', 'DATETIME_DIFF: type');
  assert(ast.name === 'DATETIME_DIFF', 'DATETIME_DIFF: name');
  assert(ast.args.length === 3, 'DATETIME_DIFF: 3 args');
  assert(ast.args[0].type === 'field_ref' && ast.args[0].name === 'Biometrics Date', 'DATETIME_DIFF: arg0');
  assert(ast.args[1].type === 'field_ref' && ast.args[1].name === 'DOB', 'DATETIME_DIFF: arg1');
  assert(ast.args[2].type === 'literal' && ast.args[2].value === 'years', 'DATETIME_DIFF: arg2');
}

{
  const ast = parseAirtableFormula('CONCATENATE({First}, " ", {Last})');
  assert(ast.type === 'function_call', 'CONCATENATE: type');
  assert(ast.args.length === 3, 'CONCATENATE: 3 args');
}

{
  // Nested function calls
  const ast = parseAirtableFormula('ROUND(SUM({A}, {B}), 2)');
  assert(ast.type === 'function_call' && ast.name === 'ROUND', 'nested: outer is ROUND');
  assert(ast.args[0].type === 'function_call' && ast.args[0].name === 'SUM', 'nested: inner is SUM');
}

{
  // String concatenation with &
  const ast = parseAirtableFormula('{First} & " " & {Last}');
  assert(ast.type === 'binary_op' && ast.op === '&', 'concat: top is &');
}

{
  // Comparison operators
  const ast = parseAirtableFormula('{A} != {B}');
  assert(ast.type === 'binary_op' && ast.op === '!=', 'not-equal: op');
}

{
  // SWITCH function
  const ast = parseAirtableFormula('SWITCH({Status}, "A", 1, "B", 2, 0)');
  assert(ast.type === 'function_call' && ast.name === 'SWITCH', 'SWITCH: type');
  assert(ast.args.length === 6, 'SWITCH: 6 args');
}

// ── collectFieldRefs Tests ────────────────────────────────────

console.log('\n=== collectFieldRefs Tests ===');

{
  const ast = parseAirtableFormula('DATETIME_DIFF({Bio Date}, {DOB}, "years")');
  const refs = collectFieldRefs(ast);
  assert(refs.length === 2, 'collectFieldRefs: count');
  assert(refs.includes('Bio Date'), 'collectFieldRefs: Bio Date');
  assert(refs.includes('DOB'), 'collectFieldRefs: DOB');
}

{
  const ast = parseAirtableFormula('{A} + {B} + {A}');
  const refs = collectFieldRefs(ast);
  assert(refs.length === 2, 'collectFieldRefs deduplicate: count');
}

{
  const ast = parseAirtableFormula('IF({X} > 0, {Y}, {Z})');
  const refs = collectFieldRefs(ast);
  assert(refs.length === 3, 'collectFieldRefs nested: count');
  assert(refs.includes('X') && refs.includes('Y') && refs.includes('Z'), 'collectFieldRefs nested: all present');
}

// ── Error Handling Tests ──────────────────────────────────────

console.log('\n=== Error Handling Tests ===');

{
  let threw = false;
  try { parseAirtableFormula('{Unclosed'); } catch (_e) { threw = true; }
  assert(threw, 'unclosed field ref throws');
}

{
  let threw = false;
  try { parseAirtableFormula('UNKNOWN_BARE_IDENT'); } catch (_e) { threw = true; }
  assert(threw, 'bare identifier throws');
}

// ── Summary ───────────────────────────────────────────────────

console.log(`\n=== Parser Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
