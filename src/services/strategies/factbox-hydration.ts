/**
 * FactboxHydrationStrategy
 *
 * Encapsulates the select-row → re-LoadForm waterfall that populates factbox
 * field values on Card and Document pages.
 *
 * BC populates factbox data server-side only in response to a SetCurrentRow
 * on the parent repeater (the server-side WebLogicalFormObserver registers a
 * "Query" change on child forms). Without this trigger, factbox forms have
 * field metadata but empty StringValues.
 *
 * After SetCurrentRow, each factbox must be re-opened with openForm:true
 * because LoadFormInteraction.CanLoadData() returns false when DataLoaded is
 * already true (set by the initial LoadForm in discoverAndLoadChildForms).
 * OpenForm resets form state, allowing LoadData() to repopulate values.
 *
 * Invoke sequence (per factbox session):
 *   1. SetCurrentRow { formId:rootFormId, controlPath:repPath, key:bookmark }
 *      -- wait for InvokeCompleted
 *   2. For each factbox section:
 *        LoadForm { formId:sec.formId, loadData:true, delayed:true, openForm:true }
 *        -- wait for InvokeCompleted | PropertyChanged | DataLoaded
 *
 * Reference: decompiled WebLogicalFormObserver.cs; live WebSocket capture.
 * Verified against BC28 via tests/integration/phase4-features.test.ts.
 */

import { isOk } from '../../core/result.js';
import type { BCSession } from '../../session/bc-session.js';
import type { PageContextRepository } from '../../protocol/page-context-repo.js';
import type {
  LoadFormInteraction,
  SetCurrentRowInteraction,
} from '../../protocol/types.js';
import { repeaters as treeRepeaters } from '../../protocol/form-views.js';

export interface FactboxSection {
  readonly formId: string;
}

export class FactboxHydrationStrategy {
  constructor(
    private readonly session: BCSession,
    private readonly repo: PageContextRepository,
  ) {}

  /**
   * Trigger factbox data population by selecting the current row on the root
   * repeater, then re-loading each factbox with openForm+loadData.
   *
   * @param pageContextId   - The owning page context (events applied here).
   * @param factboxSections - Entries from ctx.sections where kind === 'factbox'.
   */
  async hydrate(
    pageContextId: string,
    factboxSections: ReadonlyArray<[string, FactboxSection]>,
  ): Promise<void> {
    if (factboxSections.length === 0) return;

    const ctx = this.repo.get(pageContextId);
    if (!ctx) return;

    const rootForm = ctx.forms.get(ctx.rootFormId);
    if (!rootForm) return;

    for (const [repPath] of treeRepeaters(rootForm.root)) {
      const repRows = rootForm.rows.get(repPath) ?? [];
      const firstRow = repRows[0];
      if (!firstRow?.bookmark) continue;

      // Step 1: Select the first row to trigger factbox Query property change
      // on the server. The server-side WebLogicalFormObserver registers a
      // "Query" change on child forms.
      const selectResult = await this.session.invoke(
        {
          type: 'SetCurrentRow',
          formId: ctx.rootFormId,
          controlPath: repPath,
          key: firstRow.bookmark,
        } as SetCurrentRowInteraction,
        (event) => event.type === 'InvokeCompleted',
      );
      if (isOk(selectResult)) {
        this.repo.applyToPage(pageContextId, selectResult.value);
      }

      // Step 2: Re-load each factbox with openForm+loadData to force data
      // refresh. LoadFormInteraction.CanLoadData() only returns true if
      // DataLoaded is false. After the initial LoadForm, DataLoaded is true.
      // OpenForm resets form state so LoadData() can repopulate values.
      // Verified from decompiled LoadFormInteraction.cs: OpenForm -> LoadData.
      for (const [, sec] of factboxSections) {
        const loadResult = await this.session.invoke(
          {
            type: 'LoadForm',
            formId: sec.formId,
            loadData: true,
            delayed: true,
            openForm: true,
          } as LoadFormInteraction,
          (event) =>
            event.type === 'InvokeCompleted' ||
            event.type === 'PropertyChanged' ||
            event.type === 'DataLoaded',
        );
        if (isOk(loadResult)) {
          this.repo.applyToPage(pageContextId, loadResult.value);
        }
      }
      break; // Only one repeater loop iteration needed
    }
  }
}
