// src/protocol/page-context.ts
import type { FormState } from './form-state.js';
import type { SectionDescriptor } from './section-resolver.js';
import type { DialogInfo, PageType, WizardState } from './types.js';

export interface PageContext {
  readonly pageContextId: string;
  readonly rootFormId: string;
  readonly pageType: PageType;
  readonly caption: string;
  readonly forms: ReadonlyMap<string, FormState>;
  readonly sections: ReadonlyMap<string, SectionDescriptor>;
  readonly dialogs: DialogInfo[];
  readonly ownedFormIds: string[];
  /**
   * Monotonically increasing counter — bumped by one each time an event batch
   * actually mutates the page's state (form tree changed or rows changed).
   * No-op batches (events that produce no structural change) leave it
   * unchanged. Starts at 0 on creation.
   *
   * Exposed as `stateVersion` in bc_open_page / bc_read_data output.
   * Mutating tools (bc_write_data, bc_execute_action) accept an optional
   * `expectedStateVersion`; if the stored generation differs they return
   * a STALE_CONTEXT error before touching BC.
   */
  readonly generation: number;
  /**
   * True when the root was a `DialogOpened` (modal page — wizards, request pages,
   * confirmation prompts). Modal-rooted pages must be closed via the modal's own
   * Cancel/Finish/Close action; CloseForm on the root works but BC may emit a
   * LogicalModalityViolation if other modals layered on top.
   */
  readonly isModal: boolean;
  /**
   * Set on NavigatePage / wizard pages where the parser found ≥2 top-level gcs
   * with `ExpressionProperties.Visible`. ActionService.executeWizardNav advances
   * `currentStepIndex` after each successful Next/Back; the repo mirrors the
   * change into the root form's groupVisibility map. `null` for non-wizard
   * pages — leave it untouched.
   */
  readonly wizardState: WizardState | null;
}
