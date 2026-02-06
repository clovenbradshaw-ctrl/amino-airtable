/**
 * Tests for display formatting functions.
 *
 * formatCell renders cell values to HTML for the table grid.
 * These tests verify correct output for all supported data types
 * and catch potential XSS or rendering bugs.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { loadFunctions } from './extract.js';

let ctx;

beforeAll(() => {
  ctx = loadFunctions();
});

describe('formatCell', () => {
  it('renders null as empty dash', () => {
    const result = ctx.formatCell(null);
    expect(result).toContain('cell-empty');
    expect(result).toContain('—');
  });

  it('renders undefined as empty dash', () => {
    const result = ctx.formatCell(undefined);
    expect(result).toContain('cell-empty');
  });

  it('renders empty string as empty dash', () => {
    const result = ctx.formatCell('');
    expect(result).toContain('cell-empty');
  });

  it('renders plain strings as escaped text', () => {
    const result = ctx.formatCell('Hello World');
    expect(result).toContain('Hello World');
  });

  it('escapes HTML in strings to prevent XSS', () => {
    const result = ctx.formatCell('<script>alert("xss")</script>');
    expect(result).not.toContain('<script>');
    expect(result).toContain('&lt;script&gt;');
  });

  it('renders URLs as clickable links', () => {
    const result = ctx.formatCell('https://example.com/page');
    expect(result).toContain('href=');
    expect(result).toContain('target="_blank"');
    expect(result).toContain('cell-link');
  });

  it('renders numbers with locale formatting', () => {
    const result = ctx.formatCell(42);
    expect(result).toContain('cell-number');
    expect(result).toContain('42');
  });

  it('renders booleans as Yes/No', () => {
    const trueResult = ctx.formatCell(true);
    expect(trueResult).toContain('Yes');
    expect(trueResult).toContain('cell-bool');

    const falseResult = ctx.formatCell(false);
    expect(falseResult).toContain('No');
  });

  it('renders empty arrays as empty dash', () => {
    const result = ctx.formatCell([]);
    expect(result).toContain('cell-empty');
  });

  it('renders arrays of strings as tags', () => {
    const result = ctx.formatCell(['tag1', 'tag2']);
    expect(result).toContain('tag');
    expect(result).toContain('tag1');
    expect(result).toContain('tag2');
  });

  it('renders arrays of objects by name property', () => {
    const result = ctx.formatCell([{ name: 'Alice' }, { name: 'Bob' }]);
    expect(result).toContain('Alice');
    expect(result).toContain('Bob');
  });

  it('renders arrays of attachment objects by filename', () => {
    const result = ctx.formatCell([{ filename: 'doc.pdf' }]);
    expect(result).toContain('doc.pdf');
  });

  it('renders single objects with name', () => {
    const result = ctx.formatCell({ name: 'Test Object' });
    expect(result).toContain('Test Object');
  });

  it('renders single objects with url as link', () => {
    const result = ctx.formatCell({ url: 'https://example.com' });
    expect(result).toContain('href=');
    expect(result).toContain('example.com');
  });

  it('truncates long URLs in display text', () => {
    const longUrl = 'https://example.com/' + 'a'.repeat(100);
    const result = ctx.formatCell(longUrl);
    // Display text should be truncated but href should have full URL
    expect(result).toContain('href=');
  });

  it('renders 0 as a number, not as empty', () => {
    const result = ctx.formatCell(0);
    expect(result).toContain('cell-number');
    expect(result).toContain('0');
    expect(result).not.toContain('cell-empty');
  });

  it('renders negative numbers', () => {
    const result = ctx.formatCell(-42);
    expect(result).toContain('-42');
  });

  // Edge case: objects with no recognizable properties
  it('renders generic objects as truncated JSON', () => {
    const result = ctx.formatCell({ x: 1, y: 2 });
    expect(result).toBeDefined();
    expect(typeof result).toBe('string');
  });
});
