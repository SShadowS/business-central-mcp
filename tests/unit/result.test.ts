import { describe, it, expect } from 'vitest';
import { ok, err, isOk, isErr, unwrap, unwrapOr, mapResult, andThen, fromPromise } from '../../src/core/result.js';

describe('Result', () => {
  it('ok creates a success result', () => {
    const r = ok(42);
    expect(r.ok).toBe(true);
    expect(r.value).toBe(42);
  });
  it('err creates a failure result', () => {
    const r = err(new Error('fail'));
    expect(r.ok).toBe(false);
    expect(r.error.message).toBe('fail');
  });
  it('isOk/isErr type guards work', () => {
    expect(isOk(ok('hello'))).toBe(true);
    expect(isErr(ok('hello'))).toBe(false);
    expect(isOk(err(new Error('fail')))).toBe(false);
    expect(isErr(err(new Error('fail')))).toBe(true);
  });
  it('unwrap returns value on Ok', () => { expect(unwrap(ok(42))).toBe(42); });
  it('unwrap throws on Err', () => { expect(() => unwrap(err(new Error('fail')))).toThrow('fail'); });
  it('unwrapOr returns fallback on Err', () => {
    expect(unwrapOr(err(new Error('fail')), 0)).toBe(0);
    expect(unwrapOr(ok(42), 0)).toBe(42);
  });
  it('mapResult transforms Ok value', () => {
    const r = mapResult(ok(2), (n) => n * 3);
    expect(isOk(r) && r.value).toBe(6);
  });
  it('mapResult passes through Err', () => {
    const e = new Error('fail');
    const r = mapResult(err(e), (n: number) => n * 3);
    expect(isErr(r) && r.error).toBe(e);
  });
  it('andThen chains Ok results', () => {
    const r = andThen(ok(2), (n) => ok(n * 3));
    expect(isOk(r) && r.value).toBe(6);
  });
  it('andThen short-circuits on Err', () => {
    const e = new Error('fail');
    const r = andThen(err(e), (n: number) => ok(n * 3));
    expect(isErr(r) && r.error).toBe(e);
  });
  it('fromPromise wraps resolved promise', async () => {
    const r = await fromPromise(Promise.resolve(42));
    expect(isOk(r) && r.value).toBe(42);
  });
  it('fromPromise wraps rejected promise', async () => {
    const r = await fromPromise(Promise.reject(new Error('fail')));
    expect(isErr(r)).toBe(true);
  });
});
