import type { BCEvent } from '../protocol/types.js';

/**
 * Returns the first `DialogOpened` event from the supplied list that looks
 * like a BC license / evaluation notification dialog, or `undefined` if none
 * is present.
 *
 * Detection heuristic: the control-tree's Caption or Message field contains
 * "license", "evaluation", or "trial" (case-insensitive). This covers both
 * the standard "Your license is about to expire" dialog and the "This is an
 * evaluation version" nag that appears on fresh BC databases.
 *
 * The function is pure (no side effects) and is intended to be called during
 * session initialisation so the caller can auto-dismiss the dialog.
 */
export function findLicenseDialog(
  events: BCEvent[],
): (BCEvent & { type: 'DialogOpened' }) | undefined {
  return events.find((e): e is BCEvent & { type: 'DialogOpened' } => {
    if (e.type !== 'DialogOpened') return false;
    const tree = e.controlTree as Record<string, unknown> | undefined;
    if (!tree) return false;
    const caption = ((tree.Caption ?? tree.caption ?? '') as string).toLowerCase();
    const message = ((tree.Message ?? tree.message ?? '') as string).toLowerCase();
    const text = caption + ' ' + message;
    return text.includes('license') || text.includes('evaluation') || text.includes('trial');
  });
}
