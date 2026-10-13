import type { BCEvent, PropertyChangedEvent } from './types.js';
import { SystemAction } from './types.js';
import { isHostedPartChange } from './form-state.js';

/**
 * replaySafe verdicts (epic #17, #24). `replaySafe: true` means: re-running the
 * SAME call after an unknown outcome cannot apply the change a second time, and
 * BC's own response proves it. `false` means a re-run may double-apply (post,
 * insert, import, step a wizard again) or the response does not prove
 * otherwise -- read the record back before retrying.
 *
 * Two proofs exist:
 * - Absolute write echoed: a SaveValue sets a field to a value (not a delta),
 *   and BC echoes the stored value as PropertyChanged StringValue/ObjectValue
 *   only when it changed (decompiled `LogicalControlObserver.BeforeGetChanges`).
 *   A re-run converges to the same value.
 * - Target form closed: BC resolves every interaction's formId through
 *   `UISession.GetOpenedFormByStringInstanceId` and throws FormNotFoundException
 *   for a closed form (decompiled `InteractionParameterHelper.GetLogicalControl`),
 *   so a re-run against a form the response closed is rejected, not re-applied.
 */

/**
 * BC echoed a stored value for controlPath. `formIds` lists the forms the echo
 * may be reported under: a line cell echo arrives under the page's ROOT formId
 * with the subpage-relative controlPath (verified live, cronus29).
 */
export function valueEchoed(events: readonly BCEvent[], formIds: readonly string[], controlPath: string): boolean {
  return events.some(e => e.type === 'PropertyChanged' && formIds.includes(e.formId) && e.controlPath === controlPath
    && ('StringValue' in e.changes || 'ObjectValue' in e.changes));
}

/**
 * BC closed the form: `LogicalFormObserver` reports `State` = 0
 * (`ClientLogicalFormState.Closed`) on the form itself (`server:`). Verified
 * live (cronus29) for CloseForm on a card and Cancel on a report request page.
 */
export function formClosed(events: readonly BCEvent[], formId: string | undefined): boolean {
  return formId !== undefined && events.some(e => isFormClosedChange(e) && e.formId === formId);
}

/**
 * The PropertyChanged that reports a form closing (`server:`, `State` = 0).
 * BC never sends a dedicated close event: `ClosePendingForm` is the ghost-form
 * cache key (decompiled `CallbackHandler`), not a close. A hosted part's
 * close (e.g. `FormHostControl.ReplaceHostedForm` -> `Release`) arrives on its
 * host's formId and is excluded (`isHostedPartChange`).
 */
export function isFormClosedChange(e: BCEvent): e is PropertyChangedEvent {
  return e.type === 'PropertyChanged' && e.controlPath === 'server:' && e.changes['State'] === 0 && !isHostedPartChange(e);
}

/** write_data: every field written and echoed, and no dialog left pending. */
export function writeDataReplaySafe(results: ReadonlyArray<{ success: boolean; echoed?: boolean }>, dialogsOpened: number): boolean {
  return results.length > 0 && dialogsOpened === 0 && results.every(r => r.success && r.echoed === true);
}

/**
 * execute_action: Refresh is a pure re-read (decompiled `RefreshAction.InvokeCore`
 * aborts the transaction and refills); any other action (including wizard
 * navigation) only when it closed the form it was invoked on.
 */
export function actionReplaySafe(ar: { systemAction: number; formId: string; events: readonly BCEvent[] }): boolean {
  if (ar.systemAction === SystemAction.Refresh) return !ar.events.some(e => e.type === 'DialogOpened');
  return formClosed(ar.events, ar.formId);
}
