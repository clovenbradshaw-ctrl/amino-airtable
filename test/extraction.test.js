/**
 * Smoke test: verify function extraction from index.html works.
 */
import { describe, it, expect } from 'vitest';
import { loadFunctions, getFunction } from './extract.js';

describe('Function extraction', () => {
  it('loads the sandbox without crashing', () => {
    const ctx = loadFunctions();
    expect(ctx).toBeDefined();
  });

  it('extracts parsePayload', () => {
    const fn = getFunction('parsePayload');
    expect(typeof fn).toBe('function');
  });

  it('extracts inferFieldType', () => {
    const fn = getFunction('inferFieldType');
    expect(typeof fn).toBe('function');
  });

  it('extracts parseCSVLine', () => {
    const fn = getFunction('parseCSVLine');
    expect(typeof fn).toBe('function');
  });

  it('extracts getTableType', () => {
    const fn = getFunction('getTableType');
    expect(typeof fn).toBe('function');
  });

  it('extracts formatRecordCount', () => {
    const fn = getFunction('formatRecordCount');
    expect(typeof fn).toBe('function');
  });

  it('extracts getCountBarWidth', () => {
    const fn = getFunction('getCountBarWidth');
    expect(typeof fn).toBe('function');
  });

  it('extracts getGroupKeyFromValue', () => {
    const fn = getFunction('getGroupKeyFromValue');
    expect(typeof fn).toBe('function');
  });

  it('extracts applyPayloadFields', () => {
    const fn = getFunction('applyPayloadFields');
    expect(typeof fn).toBe('function');
  });

  it('extracts arrayBufferToBase64 and base64ToArrayBuffer', () => {
    const a = getFunction('arrayBufferToBase64');
    const b = getFunction('base64ToArrayBuffer');
    expect(typeof a).toBe('function');
    expect(typeof b).toBe('function');
  });
});
