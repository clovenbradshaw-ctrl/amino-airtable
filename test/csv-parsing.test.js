/**
 * Tests for CSV parsing.
 *
 * parseCSVLine is the core CSV parser used during CSV import.
 * These tests cover standard CSV edge cases and potential bugs.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { loadFunctions } from './extract.js';

let ctx;

beforeAll(() => {
  ctx = loadFunctions();
});

describe('parseCSVLine', () => {
  it('parses a simple comma-separated line', () => {
    expect(ctx.parseCSVLine('a,b,c')).toEqual(['a', 'b', 'c']);
  });

  it('handles empty fields', () => {
    expect(ctx.parseCSVLine(',,')).toEqual(['', '', '']);
    expect(ctx.parseCSVLine('a,,c')).toEqual(['a', '', 'c']);
  });

  it('handles quoted fields', () => {
    expect(ctx.parseCSVLine('"hello","world"')).toEqual(['hello', 'world']);
  });

  it('handles commas inside quotes', () => {
    expect(ctx.parseCSVLine('"a,b",c')).toEqual(['a,b', 'c']);
  });

  it('handles escaped double quotes inside quoted fields', () => {
    expect(ctx.parseCSVLine('"say ""hello""",done')).toEqual(['say "hello"', 'done']);
  });

  it('handles newlines inside quoted fields', () => {
    expect(ctx.parseCSVLine('"line1\nline2",b')).toEqual(['line1\nline2', 'b']);
  });

  it('handles a single field', () => {
    expect(ctx.parseCSVLine('hello')).toEqual(['hello']);
  });

  it('handles empty input', () => {
    expect(ctx.parseCSVLine('')).toEqual(['']);
  });

  it('handles mixed quoted and unquoted fields', () => {
    expect(ctx.parseCSVLine('a,"b,c",d')).toEqual(['a', 'b,c', 'd']);
  });

  it('parses a realistic CSV header', () => {
    expect(ctx.parseCSVLine('id,set,recordId,created_at,payload')).toEqual([
      'id', 'set', 'recordId', 'created_at', 'payload',
    ]);
  });

  it('parses a realistic CSV data row with JSON payload', () => {
    const line = '1,airtable:tbl123,rec456,2024-01-15T10:00:00Z,"{""_set"":""table"",""fields"":{""INS"":{""name"":""Test""}}}"';
    const result = ctx.parseCSVLine(line);
    expect(result[0]).toBe('1');
    expect(result[1]).toBe('airtable:tbl123');
    expect(result[2]).toBe('rec456');
    expect(result[3]).toBe('2024-01-15T10:00:00Z');
    expect(result[4]).toContain('"_set":"table"');
  });

  // Edge cases that commonly cause CSV parser bugs

  it('handles trailing comma', () => {
    const result = ctx.parseCSVLine('a,b,');
    expect(result).toEqual(['a', 'b', '']);
  });

  it('handles leading comma', () => {
    const result = ctx.parseCSVLine(',a,b');
    expect(result).toEqual(['', 'a', 'b']);
  });

  it('handles field with only quotes', () => {
    const result = ctx.parseCSVLine('""');
    expect(result).toEqual(['']);
  });

  it('handles whitespace in fields', () => {
    const result = ctx.parseCSVLine(' a , b , c ');
    expect(result).toEqual([' a ', ' b ', ' c ']);
  });

  it('handles many fields', () => {
    const line = Array(50).fill('x').join(',');
    const result = ctx.parseCSVLine(line);
    expect(result.length).toBe(50);
    expect(result.every(v => v === 'x')).toBe(true);
  });
});
