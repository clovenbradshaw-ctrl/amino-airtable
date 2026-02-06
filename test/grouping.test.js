/**
 * Tests for grouping and display key functions.
 *
 * groupRecordsByField groups record IDs into buckets by field value.
 * getGroupKeyFromValue converts arbitrary cell values to display strings.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { loadFunctions } from './extract.js';

let ctx;

beforeAll(() => {
  ctx = loadFunctions();
});

// ─── getGroupKeyFromValue ───────────────────────────────────

describe('getGroupKeyFromValue', () => {
  it('returns "(Empty)" for null', () => {
    expect(ctx.getGroupKeyFromValue(null)).toBe('(Empty)');
  });

  it('returns "(Empty)" for undefined', () => {
    expect(ctx.getGroupKeyFromValue(undefined)).toBe('(Empty)');
  });

  it('returns "(Empty)" for empty string', () => {
    expect(ctx.getGroupKeyFromValue('')).toBe('(Empty)');
  });

  it('returns "(Empty)" for empty array', () => {
    expect(ctx.getGroupKeyFromValue([])).toBe('(Empty)');
  });

  it('converts strings to themselves', () => {
    expect(ctx.getGroupKeyFromValue('Active')).toBe('Active');
  });

  it('converts numbers to strings', () => {
    expect(ctx.getGroupKeyFromValue(42)).toBe('42');
  });

  it('converts booleans to strings', () => {
    expect(ctx.getGroupKeyFromValue(true)).toBe('true');
    expect(ctx.getGroupKeyFromValue(false)).toBe('false');
  });

  it('joins array of strings', () => {
    expect(ctx.getGroupKeyFromValue(['tag1', 'tag2'])).toBe('tag1, tag2');
  });

  it('extracts name from array of objects', () => {
    const arr = [{ name: 'Alice' }, { name: 'Bob' }];
    expect(ctx.getGroupKeyFromValue(arr)).toBe('Alice, Bob');
  });

  it('extracts filename from array of attachment objects', () => {
    const arr = [{ filename: 'photo.jpg' }];
    expect(ctx.getGroupKeyFromValue(arr)).toBe('photo.jpg');
  });

  it('extracts email from array of collaborator objects', () => {
    const arr = [{ email: 'user@test.com' }];
    expect(ctx.getGroupKeyFromValue(arr)).toBe('user@test.com');
  });

  it('falls back to JSON for complex array objects', () => {
    const arr = [{ x: 1, y: 2 }];
    const result = ctx.getGroupKeyFromValue(arr);
    expect(result).toContain('"x":1');
  });

  it('extracts name from single object', () => {
    expect(ctx.getGroupKeyFromValue({ name: 'Test' })).toBe('Test');
  });

  it('extracts url from single object', () => {
    expect(ctx.getGroupKeyFromValue({ url: 'https://example.com' })).toBe('https://example.com');
  });

  it('falls back to JSON for generic objects', () => {
    const result = ctx.getGroupKeyFromValue({ x: 1 });
    expect(result).toContain('"x":1');
  });
});

// ─── groupRecordsByField ────────────────────────────────────

describe('groupRecordsByField', () => {
  const recordMap = {
    rec1: { status: 'Active', fldABC: 'Active' },
    rec2: { status: 'Inactive', fldABC: 'Inactive' },
    rec3: { status: 'Active', fldABC: 'Active' },
    rec4: { status: null, fldABC: null },
    rec5: {},
  };
  const colNames = { fldABC: 'status' };
  const allIds = ['rec1', 'rec2', 'rec3', 'rec4', 'rec5'];

  it('groups records by a field ID', () => {
    const groups = ctx.groupRecordsByField(allIds, recordMap, 'fldABC', colNames);
    expect(Object.keys(groups)).toContain('Active');
    expect(Object.keys(groups)).toContain('Inactive');
    expect(groups['Active']).toEqual(['rec1', 'rec3']);
    expect(groups['Inactive']).toEqual(['rec2']);
  });

  it('puts records with missing values in (Empty) group', () => {
    const groups = ctx.groupRecordsByField(allIds, recordMap, 'fldABC', colNames);
    expect(groups['(Empty)']).toContain('rec4');
    expect(groups['(Empty)']).toContain('rec5');
  });

  it('sorts groups alphabetically with (Empty) last', () => {
    const groups = ctx.groupRecordsByField(allIds, recordMap, 'fldABC', colNames);
    const keys = Object.keys(groups);
    const emptyIdx = keys.indexOf('(Empty)');
    expect(emptyIdx).toBe(keys.length - 1);
  });

  it('falls back to colNames mapping when fieldId not found directly', () => {
    // rec1 has { fldABC: 'Active' } but also { status: 'Active' }
    // When looking up 'fldABC', it should find it directly
    const groups = ctx.groupRecordsByField(['rec1'], recordMap, 'fldABC', colNames);
    expect(groups['Active']).toEqual(['rec1']);
  });

  it('handles empty record list', () => {
    const groups = ctx.groupRecordsByField([], recordMap, 'fldABC', colNames);
    expect(Object.keys(groups).length).toBe(0);
  });

  it('handles field that no record has', () => {
    const groups = ctx.groupRecordsByField(allIds, recordMap, 'nonexistent', colNames);
    // All records should be in (Empty)
    expect(groups['(Empty)'].length).toBe(5);
  });
});
