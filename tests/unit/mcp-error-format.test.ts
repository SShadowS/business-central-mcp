import { describe, it, expect } from 'vitest';
import { formatBcError } from '../../src/mcp/handler.js';

describe('formatBcError', () => {
  it('includes code bracket and message for a code with a registered hint', () => {
    const text = formatBcError({ code: 'VALIDATION_ERROR', message: 'bad' });
    expect(text).toContain('Error [VALIDATION_ERROR]: bad');
    expect(text).toContain('Hint:');
    expect(text).toContain('bc_write_data');
  });

  it('omits the Hint line for codes with no registered hint', () => {
    const text = formatBcError({ code: 'PROTOCOL_ERROR', message: 'x' });
    expect(text).toBe('Error [PROTOCOL_ERROR]: x');
    expect(text).not.toContain('Hint:');
  });

  it('renders without brackets when no code is provided', () => {
    const text = formatBcError({ message: 'y' });
    expect(text).toBe('Error: y');
    expect(text).not.toContain('[');
    expect(text).not.toContain('Hint:');
  });

  it('includes the BUSINESS_ERROR hint', () => {
    const text = formatBcError({ code: 'BUSINESS_ERROR', message: 'Cannot post.' });
    expect(text).toContain('Error [BUSINESS_ERROR]: Cannot post.');
    expect(text).toContain('Hint:');
    expect(text).toContain('BC rejected the operation');
  });

  it('includes the SIGN_IN_REQUIRED hint', () => {
    const text = formatBcError({ code: 'SIGN_IN_REQUIRED', message: 'need sign-in' });
    expect(text).toContain('Error [SIGN_IN_REQUIRED]: need sign-in');
    expect(text).toContain('Hint:');
    expect(text).toMatch(/login|window/i);
  });

  it('includes the SESSION_LOST hint', () => {
    const text = formatBcError({ code: 'SESSION_LOST', message: 'Session lost.' });
    expect(text).toContain('Error [SESSION_LOST]: Session lost.');
    expect(text).toContain('Hint:');
    expect(text).toContain('bc_open_page');
  });
});
