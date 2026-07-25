import { describe, it, expect } from 'vitest';
import { fileNameFromResponse } from '../../src/connection/http-filename.js';

describe('fileNameFromResponse', () => {
  it('prefers RFC 5987 filename* and percent-decodes it', () => {
    expect(fileNameFromResponse("attachment; filename*=UTF-8''Trial%20Balance.pdf", 'x')).toBe('Trial Balance.pdf');
  });
  it('falls back to plain filename= verbatim (no decode)', () => {
    expect(fileNameFromResponse('attachment; filename="100% Done.pdf"', 'x')).toBe('100% Done.pdf');
  });
  it('falls back to fname query param when no disposition', () => {
    expect(fileNameFromResponse('', 'DynamicFileHandler.axd?fname=Report.xlsx')).toBe('Report.xlsx');
  });
  it('returns undefined when nothing is available', () => {
    expect(fileNameFromResponse('', 'DynamicFileHandler.axd?form=41D')).toBeUndefined();
  });
  it('does not double-decode a literal % in the fname param', () => {
    expect(fileNameFromResponse('', 'x?fname=100%25%20Done.pdf')).toBe('100% Done.pdf');
  });
});
