/**
 * Pure helper: resolve a canonical report format ('pdf' | 'excel' | 'word') to
 * the text label used by BC's "Send to..." format-selection dialog.
 *
 * BC's PrintDialog SelectionControl carries an Items array with human-readable
 * labels and raw value strings. SaveValue requires the TEXT label (not the value
 * index) — numeric values are rejected by BC. This function picks the correct
 * label from the dialog's actual option list so the caller can SaveValue it.
 *
 * Matching rules (verified against live BC28, report 6, 2026-06-19):
 *  - 'pdf'   → first option whose text contains "PDF" (case-insensitive)
 *  - 'word'  → first option whose text contains "Word" (case-insensitive)
 *  - 'excel' → prefer option containing BOTH "Excel" AND "data only";
 *              fallback to first option containing "Excel" (case-insensitive)
 *
 * Returns null when no matching option exists (caller should return ProtocolError
 * listing the available option texts so the caller can report what is available).
 */
export function resolveFormatLabel(
  options: ReadonlyArray<{ readonly text: string; readonly value: string }>,
  format: 'pdf' | 'excel' | 'word',
): string | null {
  switch (format) {
    case 'pdf': {
      const match = options.find(o => o.text.toLowerCase().includes('pdf'));
      return match?.text ?? null;
    }
    case 'word': {
      const match = options.find(o => o.text.toLowerCase().includes('word'));
      return match?.text ?? null;
    }
    case 'excel': {
      // Prefer "data only" over "data and layout" when both are present.
      const lower = options.map(o => ({ ...o, lower: o.text.toLowerCase() }));
      const dataOnly = lower.find(o => o.lower.includes('excel') && o.lower.includes('data only'));
      if (dataOnly) return dataOnly.text;
      const any = lower.find(o => o.lower.includes('excel'));
      return any?.text ?? null;
    }
  }
}
