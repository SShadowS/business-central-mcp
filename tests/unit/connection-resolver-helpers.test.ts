import { describe, it, expect } from 'vitest';
import { expandEnv, matchPath, FIELD_TO_ENV } from '../../src/core/connection-resolver.js';
import { ConfigError } from '../../src/core/errors.js';

describe('expandEnv', () => {
  it('expands a single variable', () => {
    expect(expandEnv('${PW}', { PW: 'secret' })).toBe('secret');
  });
  it('returns non-template values verbatim', () => {
    expect(expandEnv('http://cronus28/BC', {})).toBe('http://cronus28/BC');
  });
  it('throws on a missing variable, naming it', () => {
    expect(() => expandEnv('${NOPE}', {})).toThrow(ConfigError);
    expect(() => expandEnv('${NOPE}', {})).toThrow(/NOPE/);
  });
  it('throws on an empty variable', () => {
    expect(() => expandEnv('${PW}', { PW: '' })).toThrow(ConfigError);
  });
});

describe('matchPath', () => {
  it('matches a ** suffix including the directory itself', () => {
    expect(matchPath('U:/git/custA', 'U:/git/custA/**')).toBe(true);
    expect(matchPath('U:/git/custA/sub', 'U:/git/custA/**')).toBe(true);
  });
  it('is case-insensitive and slash-normalized', () => {
    expect(matchPath('u:\\Git\\CustA\\x', 'U:/git/custA/**')).toBe(true);
  });
  it('matches a single-segment * ', () => {
    expect(matchPath('U:/git/test1/x', 'U:/git/test*/**')).toBe(true);
    expect(matchPath('U:/git/testing', 'U:/git/test*/**')).toBe(true);
  });
  it('does not let * cross a segment boundary', () => {
    expect(matchPath('U:/git/test/a/b', 'U:/git/test*')).toBe(false);
  });
  it('treats a wildcard-free pattern as a prefix', () => {
    expect(matchPath('U:/git/custA/deep', 'U:/git/custA')).toBe(true);
    expect(matchPath('U:/git/custAB', 'U:/git/custA')).toBe(false);
  });
  it('returns false on no match', () => {
    expect(matchPath('U:/git/other', 'U:/git/custA/**')).toBe(false);
  });
});
