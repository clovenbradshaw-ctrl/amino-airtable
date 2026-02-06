/**
 * Edge case and regression tests.
 *
 * These target specific bug-prone areas in the codebase:
 * - Boundary conditions in pagination math
 * - Data processing with malformed inputs
 * - Type coercion issues
 * - CSV parser stress tests
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { loadFunctions } from './extract.js';

let ctx;

beforeAll(() => {
  ctx = loadFunctions();
});

// ─── parsePayload edge cases ────────────────────────────────

describe('parsePayload edge cases', () => {
  it('handles deeply nested JSON', () => {
    const deep = '{"a":{"b":{"c":{"d":{"e":"found"}}}}}';
    const result = ctx.parsePayload(deep);
    expect(result.a.b.c.d.e).toBe('found');
  });

  it('handles JSON with unicode characters', () => {
    const result = ctx.parsePayload('{"name":"日本語テスト"}');
    expect(result.name).toBe('日本語テスト');
  });

  it('handles JSON with special characters', () => {
    const result = ctx.parsePayload('{"text":"line1\\nline2\\ttab"}');
    expect(result.text).toContain('\n');
    expect(result.text).toContain('\t');
  });

  it('handles JSON array strings', () => {
    const result = ctx.parsePayload('[1,2,3]');
    expect(result).toEqual([1, 2, 3]);
  });

  it('handles JSON "null" string', () => {
    const result = ctx.parsePayload('null');
    expect(result).toBeNull();
  });

  it('handles JSON number string', () => {
    const result = ctx.parsePayload('42');
    expect(result).toBe(42);
  });
});

// ─── inferFieldType edge cases ──────────────────────────────

describe('inferFieldType edge cases', () => {
  it('handles NaN', () => {
    // NaN is typeof number
    const result = ctx.inferFieldType(NaN);
    expect(result).toBe('number');
  });

  it('handles Infinity', () => {
    const result = ctx.inferFieldType(Infinity);
    expect(result).toBe('number');
  });

  it('handles very long strings', () => {
    const longStr = 'x'.repeat(100000);
    const result = ctx.inferFieldType(longStr);
    expect(result).toBe('singleLineText');
  });

  it('handles string with only spaces', () => {
    expect(ctx.inferFieldType('   ')).toBe('singleLineText');
  });

  it('handles date-like but invalid dates', () => {
    // Matches the regex but isn't a real date
    expect(ctx.inferFieldType('9999-99-99')).toBe('date');
  });

  it('handles nested arrays', () => {
    const result = ctx.inferFieldType([[1, 2], [3, 4]]);
    // Inner arrays are not strings starting with "rec" or objects with "url"
    expect(result).toBe('multipleSelects');
  });

  it('handles array with mixed types', () => {
    // First element determines classification
    const result = ctx.inferFieldType([42, 'text', null]);
    expect(result).toBe('multipleSelects');
  });
});

// ─── CSV parser stress tests ────────────────────────────────

describe('parseCSVLine stress tests', () => {
  it('handles extremely long fields', () => {
    const longVal = 'x'.repeat(50000);
    const result = ctx.parseCSVLine('a,' + longVal + ',c');
    expect(result.length).toBe(3);
    expect(result[1].length).toBe(50000);
  });

  it('handles consecutive commas', () => {
    const result = ctx.parseCSVLine(',,,,');
    expect(result).toEqual(['', '', '', '', '']);
  });

  it('handles only quoted empty fields', () => {
    const result = ctx.parseCSVLine('"","",""');
    expect(result).toEqual(['', '', '']);
  });

  it('handles real-world JSON payload in CSV', () => {
    const json = '{"_set":"table","fields":{"INS":{"tableName":"My Table","primaryFieldId":"fld123"}}}';
    const escaped = '"' + json.replace(/"/g, '""') + '"';
    const line = '42,airtable:tbl001,recABC,2024-01-01T00:00:00Z,' + escaped;
    const result = ctx.parseCSVLine(line);
    expect(result.length).toBe(5);
    expect(result[0]).toBe('42');
    const payload = JSON.parse(result[4]);
    expect(payload._set).toBe('table');
    expect(payload.fields.INS.tableName).toBe('My Table');
  });

  it('handles carriage returns in quoted fields', () => {
    const result = ctx.parseCSVLine('"line1\r\nline2",b');
    expect(result[0]).toContain('line1');
    expect(result[0]).toContain('line2');
  });
});

// ─── applyPayloadFields edge cases ──────────────────────────

describe('applyPayloadFields edge cases', () => {
  it('handles all operators together', () => {
    const target = { keep: true, update: 'old', remove: true };
    ctx.applyPayloadFields(target, {
      fields: {
        INS: { newKey: 'added' },
        ALT: { update: 'new' },
        SYN: { synced: true },
        NUL: ['remove'],
      },
    });
    expect(target).toEqual({
      keep: true,
      update: 'new',
      newKey: 'added',
      synced: true,
    });
  });

  it('handles INS overwriting existing keys', () => {
    const target = { name: 'old' };
    ctx.applyPayloadFields(target, { fields: { INS: { name: 'new' } } });
    expect(target.name).toBe('new');
  });

  it('handles SYN overwriting ALT values', () => {
    // SYN runs after ALT, so it should win
    const target = {};
    ctx.applyPayloadFields(target, {
      fields: {
        ALT: { status: 'from-alt' },
        SYN: { status: 'from-syn' },
      },
    });
    expect(target.status).toBe('from-syn');
  });

  it('handles NUL removing keys added by INS in same payload', () => {
    // NUL runs after INS, so it should remove what INS added
    const target = {};
    ctx.applyPayloadFields(target, {
      fields: {
        INS: { temp: 'value' },
        NUL: ['temp'],
      },
    });
    expect(target.temp).toBeUndefined();
  });

  it('handles fields with complex nested values', () => {
    const target = {};
    ctx.applyPayloadFields(target, {
      fields: {
        INS: {
          options: { choices: [{ name: 'A' }, { name: 'B' }] },
          nested: { deep: { value: 42 } },
        },
      },
    });
    expect(target.options.choices.length).toBe(2);
    expect(target.nested.deep.value).toBe(42);
  });

  it('handles empty NUL array', () => {
    const target = { a: 1 };
    ctx.applyPayloadFields(target, { fields: { NUL: [] } });
    expect(target).toEqual({ a: 1 });
  });
});

// ─── getTableType edge cases ────────────────────────────────

describe('getTableType edge cases', () => {
  it('handles strings with extra whitespace', () => {
    expect(ctx.getTableType('  test  ')).toBe('dev');
  });

  it('handles "Event Stream Data" (contains both event and stream)', () => {
    expect(ctx.getTableType('Event Stream Data')).toBe('events');
  });

  it('handles "Data Testing" (contains test)', () => {
    expect(ctx.getTableType('Data Testing')).toBe('dev');
  });

  it('handles month abbreviations in names', () => {
    expect(ctx.getTableType('Jan 1st - 15th')).toBe('collection');
    expect(ctx.getTableType('Feb Update')).toBe('collection');
    expect(ctx.getTableType('Dec Summary')).toBe('collection');
  });

  it('handles "February" (not a 3-letter abbreviation)', () => {
    // The regex uses \b word boundaries, so "feb" inside "february" does NOT match
    // Only standalone 3-letter abbreviations like "Feb" match
    const result = ctx.getTableType('February Report');
    expect(result).toBe('operational'); // no match — "feb" lacks word boundary after "b"
  });

  it('handles numeric range patterns', () => {
    expect(ctx.getTableType('Records 1st-15th')).toBe('collection');
    expect(ctx.getTableType('Batch 2nd - 30th')).toBe('collection');
  });
});
