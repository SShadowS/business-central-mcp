import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import { decompressPayload, decompressIfNeeded } from '../../src/protocol/decompression.js';
import { isOk, isErr } from '../../src/core/result.js';

describe('decompressPayload', () => {
  it('decompresses base64 gzip to JSON', () => {
    const original = [{ handlerType: 'test', parameters: [1, 2] }];
    const compressed = gzipSync(JSON.stringify(original)).toString('base64');
    const result = decompressPayload(compressed);
    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value).toEqual(original);
  });

  it('returns Err on invalid base64', () => {
    const result = decompressPayload('not-valid-base64!!!');
    expect(isErr(result)).toBe(true);
  });

  it('returns Err on non-gzip data', () => {
    const result = decompressPayload(Buffer.from('plain text').toString('base64'));
    expect(isErr(result)).toBe(true);
  });
});

describe('decompressIfNeeded', () => {
  it('passes through non-compressed messages', () => {
    const msg = { id: 1, result: [{ handlerType: 'test' }] };
    const result = decompressIfNeeded(msg);
    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value).toBe(msg);
  });

  it('decompresses compressedResult field', () => {
    const original = [{ handlerType: 'test' }];
    const compressed = gzipSync(JSON.stringify(original)).toString('base64');
    const msg = { id: 1, result: { compressedResult: compressed } };
    const result = decompressIfNeeded(msg);
    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value).toEqual(original);
  });

  it('decompresses compressedData field', () => {
    const original = [{ handlerType: 'test' }];
    const compressed = gzipSync(JSON.stringify(original)).toString('base64');
    const msg = { id: 1, result: { compressedData: compressed } };
    const result = decompressIfNeeded(msg);
    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value).toEqual(original);
  });
});
