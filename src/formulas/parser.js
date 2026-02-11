/**
 * Airtable Formula Parser
 *
 * Parses Airtable formula strings into an AST using a recursive descent parser.
 * Handles field references ({Field Name}), literals, operators, and function calls.
 *
 * AST Node Types:
 *   { type: 'field_ref', name: string }
 *   { type: 'literal', value: string|number|boolean|null, dataType: 'string'|'number'|'boolean'|'null' }
 *   { type: 'function_call', name: string, args: FormulaAST[] }
 *   { type: 'binary_op', op: string, left: FormulaAST, right: FormulaAST }
 *   { type: 'unary_op', op: string, operand: FormulaAST }
 *
 * Token Types:
 *   { type: 'FIELD_REF', value: string }
 *   { type: 'STRING', value: string }
 *   { type: 'NUMBER', value: number }
 *   { type: 'IDENT', value: string }
 *   { type: 'OP', value: string }
 *   { type: 'LPAREN' } | { type: 'RPAREN' }
 *   { type: 'COMMA' }
 *   { type: 'EOF' }
 */

/**
 * Tokenize an Airtable formula string into a list of tokens.
 * @param {string} formula
 * @returns {Array<{type: string, value?: any}>}
 */
export function tokenize(formula) {
  const tokens = [];
  let i = 0;

  while (i < formula.length) {
    // Skip whitespace
    if (/\s/.test(formula[i])) {
      i++;
      continue;
    }

    // Field reference: {Field Name}
    if (formula[i] === '{') {
      const end = formula.indexOf('}', i + 1);
      if (end === -1) throw new Error(`Unclosed field reference at position ${i}`);
      tokens.push({ type: 'FIELD_REF', value: formula.slice(i + 1, end) });
      i = end + 1;
      continue;
    }

    // String literal: "..." or '...'
    if (formula[i] === '"' || formula[i] === "'") {
      const quote = formula[i];
      let str = '';
      i++;
      while (i < formula.length && formula[i] !== quote) {
        if (formula[i] === '\\' && i + 1 < formula.length) {
          const next = formula[i + 1];
          if (next === 'n') { str += '\n'; }
          else if (next === 't') { str += '\t'; }
          else if (next === '\\') { str += '\\'; }
          else if (next === quote) { str += quote; }
          else { str += next; }
          i += 2;
        } else {
          str += formula[i];
          i++;
        }
      }
      if (i >= formula.length) throw new Error(`Unclosed string literal`);
      i++; // skip closing quote
      tokens.push({ type: 'STRING', value: str });
      continue;
    }

    // Number
    if (/[0-9]/.test(formula[i]) || (formula[i] === '.' && i + 1 < formula.length && /[0-9]/.test(formula[i + 1]))) {
      let num = '';
      while (i < formula.length && /[0-9.]/.test(formula[i])) {
        num += formula[i];
        i++;
      }
      tokens.push({ type: 'NUMBER', value: parseFloat(num) });
      continue;
    }

    // Two-character operators
    if (i + 1 < formula.length) {
      const two = formula.slice(i, i + 2);
      if (two === '!=' || two === '<=' || two === '>=') {
        tokens.push({ type: 'OP', value: two });
        i += 2;
        continue;
      }
    }

    // Single-character operators and punctuation
    if ('+-*/%&=<>'.includes(formula[i])) {
      tokens.push({ type: 'OP', value: formula[i] });
      i++;
      continue;
    }
    if (formula[i] === '(') { tokens.push({ type: 'LPAREN' }); i++; continue; }
    if (formula[i] === ')') { tokens.push({ type: 'RPAREN' }); i++; continue; }
    if (formula[i] === ',') { tokens.push({ type: 'COMMA' }); i++; continue; }

    // Identifiers (function names, TRUE, FALSE, BLANK)
    if (/[a-zA-Z_]/.test(formula[i])) {
      let ident = '';
      while (i < formula.length && /[a-zA-Z0-9_]/.test(formula[i])) {
        ident += formula[i];
        i++;
      }
      tokens.push({ type: 'IDENT', value: ident });
      continue;
    }

    throw new Error(`Unexpected character '${formula[i]}' at position ${i}`);
  }

  tokens.push({ type: 'EOF' });
  return tokens;
}

/**
 * Recursive descent parser for Airtable formulas.
 */
class Parser {
  /**
   * @param {Array<{type: string, value?: any}>} tokens
   */
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
  }

  peek() {
    return this.tokens[this.pos];
  }

  advance() {
    return this.tokens[this.pos++];
  }

  expect(type) {
    const tok = this.advance();
    if (tok.type !== type) {
      throw new Error(`Expected ${type}, got ${tok.type}${tok.value !== undefined ? ` (${tok.value})` : ''}`);
    }
    return tok;
  }

  /**
   * Parse the token stream into a FormulaAST.
   * @returns {object} FormulaAST node
   */
  parse() {
    const ast = this.parseExpression();
    this.expect('EOF');
    return ast;
  }

  // Entry point for expression parsing — handles all precedence levels
  parseExpression() {
    return this.parseComparison();
  }

  // Comparison: =, !=, <, >, <=, >=
  parseComparison() {
    let left = this.parseAddition();
    while (
      this.peek().type === 'OP' &&
      ['=', '!=', '<', '>', '<=', '>='].includes(this.peek().value)
    ) {
      const op = this.advance().value;
      const right = this.parseAddition();
      left = { type: 'binary_op', op, left, right };
    }
    return left;
  }

  // Addition/subtraction/concatenation: +, -, &
  parseAddition() {
    let left = this.parseMultiplication();
    while (
      this.peek().type === 'OP' &&
      ['+', '-', '&'].includes(this.peek().value)
    ) {
      const op = this.advance().value;
      const right = this.parseMultiplication();
      left = { type: 'binary_op', op, left, right };
    }
    return left;
  }

  // Multiplication/division/modulo: *, /, %
  parseMultiplication() {
    let left = this.parseUnary();
    while (
      this.peek().type === 'OP' &&
      ['*', '/', '%'].includes(this.peek().value)
    ) {
      const op = this.advance().value;
      const right = this.parseUnary();
      left = { type: 'binary_op', op, left, right };
    }
    return left;
  }

  // Unary: -expr
  parseUnary() {
    if (this.peek().type === 'OP' && this.peek().value === '-') {
      this.advance();
      return { type: 'unary_op', op: '-', operand: this.parsePrimary() };
    }
    return this.parsePrimary();
  }

  // Primary: field refs, literals, function calls, parenthesized expressions
  parsePrimary() {
    const tok = this.peek();

    // Field reference: {Field Name}
    if (tok.type === 'FIELD_REF') {
      this.advance();
      return { type: 'field_ref', name: tok.value };
    }

    // String literal
    if (tok.type === 'STRING') {
      this.advance();
      return { type: 'literal', value: tok.value, dataType: 'string' };
    }

    // Number literal
    if (tok.type === 'NUMBER') {
      this.advance();
      return { type: 'literal', value: tok.value, dataType: 'number' };
    }

    // Identifier: function call or boolean/blank constant
    if (tok.type === 'IDENT') {
      this.advance();
      const name = tok.value.toUpperCase();

      // Boolean constants are zero-arg functions in Airtable: TRUE(), FALSE()
      if (name === 'TRUE' && this.peek().type === 'LPAREN') {
        this.advance(); // (
        this.expect('RPAREN');
        return { type: 'literal', value: true, dataType: 'boolean' };
      }
      if (name === 'FALSE' && this.peek().type === 'LPAREN') {
        this.advance(); // (
        this.expect('RPAREN');
        return { type: 'literal', value: false, dataType: 'boolean' };
      }
      if (name === 'BLANK' && this.peek().type === 'LPAREN') {
        this.advance(); // (
        this.expect('RPAREN');
        return { type: 'literal', value: null, dataType: 'null' };
      }

      // Function call: NAME(arg1, arg2, ...)
      if (this.peek().type === 'LPAREN') {
        this.advance(); // consume (
        const args = [];
        if (this.peek().type !== 'RPAREN') {
          args.push(this.parseExpression());
          while (this.peek().type === 'COMMA') {
            this.advance(); // consume ,
            args.push(this.parseExpression());
          }
        }
        this.expect('RPAREN');
        return { type: 'function_call', name, args };
      }

      // Bare identifier without parentheses — not valid in Airtable formulas
      throw new Error(`Unexpected identifier '${tok.value}' — did you mean ${tok.value}()?`);
    }

    // Parenthesized expression: (expr)
    if (tok.type === 'LPAREN') {
      this.advance();
      const expr = this.parseExpression();
      this.expect('RPAREN');
      return expr;
    }

    throw new Error(`Unexpected token: ${tok.type}${tok.value !== undefined ? ` (${tok.value})` : ''}`);
  }
}

/**
 * Parse an Airtable formula string into a FormulaAST.
 * @param {string} formula - Airtable formula string
 * @returns {object} FormulaAST root node
 */
export function parseAirtableFormula(formula) {
  const tokens = tokenize(formula);
  const parser = new Parser(tokens);
  return parser.parse();
}

/**
 * Walk the AST and collect all field reference names.
 * @param {object} ast - FormulaAST node
 * @returns {string[]} Unique field names referenced
 */
export function collectFieldRefs(ast) {
  const refs = [];
  function walk(node) {
    if (node.type === 'field_ref') refs.push(node.name);
    if (node.type === 'function_call') node.args.forEach(walk);
    if (node.type === 'binary_op') { walk(node.left); walk(node.right); }
    if (node.type === 'unary_op') walk(node.operand);
  }
  walk(ast);
  return [...new Set(refs)];
}
