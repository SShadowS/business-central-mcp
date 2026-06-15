/**
 * RoleCenterHydrationStrategy
 *
 * Encapsulates the Refresh step required to populate cue tile values on a
 * Role Center hosted CardPart (cuegroup / stackgc form).
 *
 * Context: PageService.discoverAndLoadChildForms already sends a LoadForm
 * (openForm:true, loadData:true) for every Role Center child. That LoadForm
 * populates the form metadata but leaves cue StringValues at the "0" stub.
 * This strategy sends the subsequent Refresh that causes the BC server to
 * recompute the bound stackc StringValues and emit PropertyChanged events.
 *
 * Invoke sequence:
 *   InvokeAction { formId, controlPath:'server:', systemAction:30 (Refresh) }
 *   -- wait for InvokeCompleted | PropertyChanged
 *
 * controlPath 'server:' targets the form root. Cuegroup CardParts have no
 * top-level repeater; form-root Refresh triggers recomputation of the bound
 * stackc StringValues via PropertyChanged events.
 *
 * Reference: CLAUDE.md §Cuegroups (Role-Center cue tiles); decompiled
 * Microsoft.Dynamics.Framework.UI.Client.LogicalControlSerializer.cs.
 */

import { isOk } from '../../core/result.js';
import type { BCSession } from '../../session/bc-session.js';
import type { PageContextRepository } from '../../protocol/page-context-repo.js';
import type { InvokeActionInteraction } from '../../protocol/types.js';

export class RoleCenterHydrationStrategy {
  constructor(
    private readonly session: BCSession,
    private readonly repo: PageContextRepository,
  ) {}

  /**
   * Send a form-root Refresh to trigger cue value recomputation on a Role
   * Center hosted CardPart. Call this AFTER the initial LoadForm has already
   * been sent by the caller.
   *
   * @param pageContextId - The owning page context (events applied here).
   * @param childFormId   - The server-side formId of the hosted CardPart.
   */
  async hydrate(pageContextId: string, childFormId: string): Promise<void> {
    // Cue StringValues are computed server-side in response to a Refresh on
    // the hosted CardPart. Without this, cue tiles parse correctly but their
    // values stay at the initial "0" stub.
    // controlPath 'server:' targets the form root — cuegroup CardParts have
    // no top-level repeater, and form-root Refresh triggers recomputation of
    // the bound stackc StringValues via PropertyChanged events.
    const refreshInteraction: InvokeActionInteraction = {
      type: 'InvokeAction',
      formId: childFormId,
      controlPath: 'server:',
      systemAction: 30, // SystemAction.Refresh
    };

    const refreshResult = await this.session.invoke(
      refreshInteraction,
      (event) => event.type === 'InvokeCompleted' || event.type === 'PropertyChanged',
    );

    if (isOk(refreshResult)) {
      this.repo.applyToPage(pageContextId, refreshResult.value);
    }
  }
}
