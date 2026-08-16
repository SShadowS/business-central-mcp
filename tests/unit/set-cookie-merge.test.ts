import { describe, it, expect } from 'vitest';
import { mergeSetCookies } from '../../src/connection/auth/set-cookie-merge.js';

describe('mergeSetCookies', () => {
  it('adds new cookies and overwrites existing by name', () => {
    expect(mergeSetCookies('a=1; b=2', ['b=3; Path=/', 'c=4; Secure'])).toBe('a=1; b=3; c=4');
  });

  it('honors a Max-Age=0 deletion by removing the cookie', () => {
    expect(mergeSetCookies('a=1; b=2', ['b=; Max-Age=0'])).toBe('a=1');
  });

  it('honors a negative Max-Age deletion', () => {
    expect(mergeSetCookies('a=1; b=2', ['b=whatever; Max-Age=-1'])).toBe('a=1');
  });

  it('honors an Expires-in-the-past deletion', () => {
    expect(mergeSetCookies('a=1', ['a=; Expires=Thu, 01 Jan 1970 00:00:00 GMT'])).toBe('');
  });

  it('keeps a cookie whose Expires is in the future', () => {
    expect(mergeSetCookies('', ['a=1; Expires=Tue, 19 Jan 2038 03:14:07 GMT'])).toBe('a=1');
  });

  it('does not treat a normal cookie value as a deletion', () => {
    expect(mergeSetCookies('', ['a=1; Path=/; Secure; HttpOnly'])).toBe('a=1');
  });
});
