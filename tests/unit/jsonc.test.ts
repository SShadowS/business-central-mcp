import { describe, it, expect } from 'vitest';
import { stripJsonComments } from '../../src/core/jsonc.js';

describe('stripJsonComments', () => {
  it('removes line comments', () => {
    expect(stripJsonComments('{"a":1} // trailing')).toBe('{"a":1} ');
  });

  it('removes block comments', () => {
    expect(stripJsonComments('{/* note */"a":1}')).toBe('{"a":1}');
  });

  it('preserves comment-like text inside strings', () => {
    const src = '{"url":"http://x/BC","p":"a//b"}';
    expect(stripJsonComments(src)).toBe(src);
  });

  it('preserves escaped quotes inside strings', () => {
    const src = '{"p":"a\\"// not a comment"}';
    expect(stripJsonComments(src)).toBe(src);
  });

  it('leaves newlines intact when removing line comments', () => {
    expect(stripJsonComments('{\n// c\n"a":1\n}')).toBe('{\n\n"a":1\n}');
  });
});
