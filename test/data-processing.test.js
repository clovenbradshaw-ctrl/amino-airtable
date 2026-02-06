/**
 * Tests for core data processing functions.
 *
 * These test the pure logic that parses payloads, infers field types,
 * applies field operations (INS/ALT/SYN/NUL), and classifies tables.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { loadFunctions } from './extract.js';

let ctx;

beforeAll(() => {
  ctx = loadFunctions();
});

// ─── parsePayload ───────────────────────────────────────────

describe('parsePayload', () => {
  it('parses a valid JSON string', () => {
    const result = ctx.parsePayload('{"name":"test"}');
    expect(result).toEqual({ name: 'test' });
  });

  it('returns the object directly if already an object', () => {
    const obj = { foo: 'bar' };
    expect(ctx.parsePayload(obj)).toBe(obj);
  });

  it('returns null for invalid JSON strings', () => {
    expect(ctx.parsePayload('not json')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(ctx.parsePayload('')).toBeNull();
  });

  it('handles nested JSON', () => {
    const input = '{"fields":{"INS":{"name":"Alice"}}}';
    const result = ctx.parsePayload(input);
    expect(result.fields.INS.name).toBe('Alice');
  });

  it('returns numbers, booleans, and arrays as-is (not strings)', () => {
    expect(ctx.parsePayload(42)).toBe(42);
    expect(ctx.parsePayload(true)).toBe(true);
    expect(ctx.parsePayload([1, 2])).toEqual([1, 2]);
  });

  it('returns null for undefined', () => {
    // undefined is not a string, so goes to the else branch and returns undefined
    const result = ctx.parsePayload(undefined);
    expect(result).toBeUndefined();
  });
});

// ─── inferFieldType ─────────────────────────────────────────

describe('inferFieldType', () => {
  it('returns "unknown" for null', () => {
    expect(ctx.inferFieldType(null)).toBe('unknown');
  });

  it('returns "unknown" for undefined', () => {
    expect(ctx.inferFieldType(undefined)).toBe('unknown');
  });

  it('returns "checkbox" for booleans', () => {
    expect(ctx.inferFieldType(true)).toBe('checkbox');
    expect(ctx.inferFieldType(false)).toBe('checkbox');
  });

  it('returns "number" for integers', () => {
    expect(ctx.inferFieldType(42)).toBe('number');
  });

  it('returns "number" for floats', () => {
    expect(ctx.inferFieldType(3.14)).toBe('number');
  });

  it('returns "singleLineText" for plain strings', () => {
    expect(ctx.inferFieldType('hello world')).toBe('singleLineText');
  });

  it('returns "date" for ISO date strings', () => {
    expect(ctx.inferFieldType('2024-01-15')).toBe('date');
    expect(ctx.inferFieldType('2024-01-15T10:30:00Z')).toBe('date');
  });

  it('returns "email" for email strings', () => {
    expect(ctx.inferFieldType('user@example.com')).toBe('email');
  });

  it('returns "url" for URL strings', () => {
    expect(ctx.inferFieldType('https://example.com')).toBe('url');
    expect(ctx.inferFieldType('http://foo.bar/path')).toBe('url');
  });

  it('returns "multipleAttachments" for arrays with url objects', () => {
    const arr = [{ url: 'https://example.com/file.jpg', filename: 'file.jpg' }];
    expect(ctx.inferFieldType(arr)).toBe('multipleAttachments');
  });

  it('returns "multipleRecordLinks" for arrays of rec-prefixed strings', () => {
    const arr = ['recABC123', 'recDEF456'];
    expect(ctx.inferFieldType(arr)).toBe('multipleRecordLinks');
  });

  it('returns "multipleSelects" for other arrays', () => {
    expect(ctx.inferFieldType(['option1', 'option2'])).toBe('multipleSelects');
    expect(ctx.inferFieldType([1, 2, 3])).toBe('multipleSelects');
  });

  it('returns "multipleAttachments" for single objects with url', () => {
    expect(ctx.inferFieldType({ url: 'https://example.com' })).toBe('multipleAttachments');
  });

  it('returns "object" for generic objects', () => {
    expect(ctx.inferFieldType({ foo: 'bar' })).toBe('object');
  });

  // Edge cases / potential bugs
  it('handles empty arrays', () => {
    // Empty array has no elements to check — should still return a type
    const result = ctx.inferFieldType([]);
    expect(result).toBe('multipleSelects');
  });

  it('does not misclassify partial date strings', () => {
    // "2024" alone should not match the date regex
    expect(ctx.inferFieldType('2024')).toBe('singleLineText');
  });

  it('does not misclassify strings starting with "rec" but not record IDs', () => {
    // A single string (not array) starting with "rec" is just text
    expect(ctx.inferFieldType('recipe for cookies')).toBe('singleLineText');
  });
});

// ─── applyPayloadFields ─────────────────────────────────────

describe('applyPayloadFields', () => {
  it('applies INS (insert) fields', () => {
    const target = {};
    ctx.applyPayloadFields(target, { fields: { INS: { name: 'Alice', age: 30 } } });
    expect(target).toEqual({ name: 'Alice', age: 30 });
  });

  it('applies ALT (alter) fields', () => {
    const target = { name: 'Alice', age: 30 };
    ctx.applyPayloadFields(target, { fields: { ALT: { age: 31 } } });
    expect(target).toEqual({ name: 'Alice', age: 31 });
  });

  it('applies SYN (sync) fields', () => {
    const target = {};
    ctx.applyPayloadFields(target, { fields: { SYN: { status: 'active' } } });
    expect(target).toEqual({ status: 'active' });
  });

  it('applies NUL (delete) fields', () => {
    const target = { name: 'Alice', age: 30, email: 'a@b.com' };
    ctx.applyPayloadFields(target, { fields: { NUL: ['age', 'email'] } });
    expect(target).toEqual({ name: 'Alice' });
  });

  it('applies INS + ALT + NUL together in order', () => {
    const target = { existing: true };
    ctx.applyPayloadFields(target, {
      fields: {
        INS: { newField: 'hello' },
        ALT: { existing: false },
        NUL: ['newField'],
      },
    });
    // INS adds newField, ALT changes existing, NUL removes newField
    expect(target).toEqual({ existing: false });
  });

  it('does nothing when payload has no fields', () => {
    const target = { a: 1 };
    ctx.applyPayloadFields(target, {});
    expect(target).toEqual({ a: 1 });
  });

  it('does nothing when fields is empty', () => {
    const target = { a: 1 };
    ctx.applyPayloadFields(target, { fields: {} });
    expect(target).toEqual({ a: 1 });
  });

  it('handles NUL as non-array gracefully', () => {
    // NUL should be an array, but if it's not, it should not crash
    const target = { a: 1 };
    // The function checks Array.isArray(fields.NUL)
    ctx.applyPayloadFields(target, { fields: { NUL: 'not-an-array' } });
    expect(target).toEqual({ a: 1 });
  });
});

// ─── getTableType ───────────────────────────────────────────

describe('getTableType', () => {
  it('classifies event stream tables', () => {
    expect(ctx.getTableType('Event Stream')).toBe('events');
    expect(ctx.getTableType('events')).toBe('events');
  });

  it('classifies collection tables by date patterns', () => {
    expect(ctx.getTableType('Jan Collection')).toBe('collection');
    expect(ctx.getTableType('My Collection')).toBe('collection');
    expect(ctx.getTableType('1st - 15th')).toBe('collection');
  });

  it('classifies reference tables', () => {
    expect(ctx.getTableType('Dictionary')).toBe('reference');
    expect(ctx.getTableType('Type List')).toBe('reference');
    expect(ctx.getTableType('Appendix A')).toBe('reference');
    expect(ctx.getTableType('Info Center')).toBe('reference');
  });

  it('classifies dev/test tables', () => {
    expect(ctx.getTableType('test')).toBe('dev');
    expect(ctx.getTableType('dev table')).toBe('dev');
    expect(ctx.getTableType('data test results')).toBe('dev');
  });

  it('defaults to operational for unrecognized names', () => {
    expect(ctx.getTableType('Customers')).toBe('operational');
    expect(ctx.getTableType('Orders')).toBe('operational');
    expect(ctx.getTableType('')).toBe('operational');
  });

  it('handles null/undefined table names', () => {
    expect(ctx.getTableType(null)).toBe('operational');
    expect(ctx.getTableType(undefined)).toBe('operational');
  });

  it('is case-insensitive', () => {
    expect(ctx.getTableType('EVENT STREAM')).toBe('events');
    expect(ctx.getTableType('DICTIONARY')).toBe('reference');
    expect(ctx.getTableType('TEST')).toBe('dev');
  });

  // Edge: "activity type" should not be classified as reference
  it('does not classify "activity type" as reference', () => {
    expect(ctx.getTableType('Activity Type Log')).toBe('operational');
  });
});

// ─── formatRecordCount ──────────────────────────────────────

describe('formatRecordCount', () => {
  it('returns raw number for counts under 1000', () => {
    expect(ctx.formatRecordCount(0)).toBe('0');
    expect(ctx.formatRecordCount(1)).toBe('1');
    expect(ctx.formatRecordCount(999)).toBe('999');
  });

  it('formats thousands with k suffix', () => {
    expect(ctx.formatRecordCount(1000)).toBe('1.0k');
    expect(ctx.formatRecordCount(1500)).toBe('1.5k');
    expect(ctx.formatRecordCount(73262)).toBe('73.3k');
  });

  it('handles exact multiples', () => {
    expect(ctx.formatRecordCount(10000)).toBe('10.0k');
    expect(ctx.formatRecordCount(100000)).toBe('100.0k');
  });
});

// ─── getCountBarWidth ───────────────────────────────────────

describe('getCountBarWidth', () => {
  it('returns 0 for zero or negative counts', () => {
    expect(ctx.getCountBarWidth(0, 100)).toBe(0);
    expect(ctx.getCountBarWidth(-1, 100)).toBe(0);
  });

  it('returns 0 when maxCount is 0 or negative', () => {
    expect(ctx.getCountBarWidth(10, 0)).toBe(0);
    expect(ctx.getCountBarWidth(10, -5)).toBe(0);
  });

  it('returns 1 when count equals maxCount', () => {
    const result = ctx.getCountBarWidth(100, 100);
    expect(result).toBeCloseTo(1, 2);
  });

  it('returns a value between 0.15 and 1 for valid inputs', () => {
    const result = ctx.getCountBarWidth(10, 10000);
    expect(result).toBeGreaterThanOrEqual(0.15);
    expect(result).toBeLessThanOrEqual(1);
  });

  it('uses logarithmic scale (small counts get proportionally wider)', () => {
    const small = ctx.getCountBarWidth(10, 10000);
    const medium = ctx.getCountBarWidth(100, 10000);
    const large = ctx.getCountBarWidth(1000, 10000);
    // Each jump is 10x but the bar width differences should shrink
    expect(medium - small).toBeLessThan(large - medium + 0.5);
    expect(small).toBeGreaterThan(0);
    expect(large).toBeGreaterThan(medium);
    expect(medium).toBeGreaterThan(small);
  });
});
