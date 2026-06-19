import { describe, it, expect } from 'vitest';
import { resolveFormatLabel } from '../../src/session/report-format-resolver.js';

/**
 * Unit tests for the pure format→label resolver used by runReportWithDownload.
 *
 * The BC "Send to..." format dialog exposes a SelectionControl whose options
 * carry human-readable text labels (e.g. "PDF Document", "Microsoft Word Document").
 * resolveFormatLabel maps a canonical format name to the best matching option text
 * so we can SaveValue the correct label into the SelectionControl.
 *
 * Rules (from live-verified design):
 *  - 'pdf'   → option whose text contains "PDF" (case-insensitive)
 *  - 'word'  → option whose text contains "Word" (case-insensitive)
 *  - 'excel' → prefer option containing BOTH "Excel" AND "data only";
 *              fallback to any option containing "Excel" (case-insensitive)
 *  - No matching option → returns null (caller returns ProtocolError)
 */

// Typical BC28 report 6 (Trial Balance) options from live wire capture:
const TYPICAL_OPTIONS = [
  { text: 'PDF Document', value: '0' },
  { text: 'Microsoft Word Document', value: '1' },
  { text: 'Microsoft Excel Document (data only)', value: '2' },
  { text: 'Microsoft Excel Document (data and layout)', value: '3' },
];

describe('resolveFormatLabel', () => {
  it('resolves pdf to the option containing "PDF"', () => {
    const label = resolveFormatLabel(TYPICAL_OPTIONS, 'pdf');
    expect(label).toBe('PDF Document');
  });

  it('resolves word to the option containing "Word"', () => {
    const label = resolveFormatLabel(TYPICAL_OPTIONS, 'word');
    expect(label).toBe('Microsoft Word Document');
  });

  it('resolves excel preferring the "data only" option', () => {
    const label = resolveFormatLabel(TYPICAL_OPTIONS, 'excel');
    expect(label).toBe('Microsoft Excel Document (data only)');
  });

  it('resolves excel to any Excel option when "data only" is absent', () => {
    const options = [
      { text: 'PDF Document', value: '0' },
      { text: 'Microsoft Excel Document', value: '1' },
    ];
    const label = resolveFormatLabel(options, 'excel');
    expect(label).toBe('Microsoft Excel Document');
  });

  it('returns null for pdf when no PDF option is present', () => {
    const options = [
      { text: 'Microsoft Word Document', value: '0' },
      { text: 'Microsoft Excel Document (data only)', value: '1' },
    ];
    const label = resolveFormatLabel(options, 'pdf');
    expect(label).toBeNull();
  });

  it('returns null for word when no Word option is present', () => {
    const options = [
      { text: 'PDF Document', value: '0' },
    ];
    const label = resolveFormatLabel(options, 'word');
    expect(label).toBeNull();
  });

  it('returns null for excel when no Excel option is present', () => {
    const options = [
      { text: 'PDF Document', value: '0' },
      { text: 'Microsoft Word Document', value: '1' },
    ];
    const label = resolveFormatLabel(options, 'excel');
    expect(label).toBeNull();
  });

  it('is case-insensitive for pdf matching', () => {
    const options = [{ text: 'pdf document', value: '0' }];
    expect(resolveFormatLabel(options, 'pdf')).toBe('pdf document');
  });

  it('is case-insensitive for word matching', () => {
    const options = [{ text: 'microsoft word document', value: '0' }];
    expect(resolveFormatLabel(options, 'word')).toBe('microsoft word document');
  });

  it('is case-insensitive for excel matching', () => {
    const options = [{ text: 'microsoft excel document (data only)', value: '0' }];
    expect(resolveFormatLabel(options, 'excel')).toBe('microsoft excel document (data only)');
  });

  it('handles empty options array', () => {
    expect(resolveFormatLabel([], 'pdf')).toBeNull();
    expect(resolveFormatLabel([], 'word')).toBeNull();
    expect(resolveFormatLabel([], 'excel')).toBeNull();
  });
});
