/**
 * Tests for base64 / ArrayBuffer encoding utilities.
 *
 * These are the helpers used by the encryption system.
 * Testing them in isolation verifies the data pipeline
 * without needing the full Web Crypto API.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { loadFunctions } from './extract.js';

let ctx;

beforeAll(() => {
  ctx = loadFunctions();
});

describe('arrayBufferToBase64', () => {
  it('encodes an empty buffer', () => {
    expect(ctx.arrayBufferToBase64(new Uint8Array([]))).toBe('');
  });

  it('encodes a simple byte sequence', () => {
    const bytes = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
    const b64 = ctx.arrayBufferToBase64(bytes);
    expect(b64).toBe('SGVsbG8=');
  });

  it('encodes binary data (non-ASCII)', () => {
    const bytes = new Uint8Array([0, 255, 128, 64, 1]);
    const b64 = ctx.arrayBufferToBase64(bytes);
    expect(typeof b64).toBe('string');
    expect(b64.length).toBeGreaterThan(0);
  });
});

describe('base64ToArrayBuffer', () => {
  it('decodes an empty string', () => {
    const result = ctx.base64ToArrayBuffer('');
    expect(result.length).toBe(0);
  });

  it('decodes a valid base64 string', () => {
    const result = ctx.base64ToArrayBuffer('SGVsbG8=');
    expect(Array.from(result)).toEqual([72, 101, 108, 108, 111]);
  });
});

describe('base64 round-trip', () => {
  it('survives a round-trip for simple data', () => {
    const original = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const b64 = ctx.arrayBufferToBase64(original);
    const decoded = ctx.base64ToArrayBuffer(b64);
    expect(Array.from(decoded)).toEqual(Array.from(original));
  });

  it('survives a round-trip for all byte values', () => {
    const original = new Uint8Array(256);
    for (let i = 0; i < 256; i++) original[i] = i;
    const b64 = ctx.arrayBufferToBase64(original);
    const decoded = ctx.base64ToArrayBuffer(b64);
    expect(Array.from(decoded)).toEqual(Array.from(original));
  });

  it('survives a round-trip for large data', () => {
    const original = new Uint8Array(10000);
    for (let i = 0; i < original.length; i++) original[i] = i % 256;
    const b64 = ctx.arrayBufferToBase64(original);
    const decoded = ctx.base64ToArrayBuffer(b64);
    expect(decoded.length).toBe(original.length);
    expect(Array.from(decoded)).toEqual(Array.from(original));
  });
});
