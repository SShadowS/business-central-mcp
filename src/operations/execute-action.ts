import { err, ok, isOk, isErr, type Result } from '../core/result.js';
import { ProtocolError, StaleContextError, type BCError } from '../core/errors.js';
import { classifyBusinessError } from '../protocol/error-classifier.js';
import type { ActionService, ActionResult } from '../services/action-service.js';
import type { NavigationService } from '../services/navigation-service.js';
import type { PageContextRepository } from '../protocol/page-context-repo.js';
import type { ControlField } from '../protocol/types.js';
import type { Download, DownloadService } from '../services/download-service.js';
import { resolveSection } from '../protocol/section-resolver.js';
import { detectChangedSections, detectDialogs } from '../protocol/mutation-result.js';
import { isEffectivelyVisible } from '../protocol/visibility.js';
import { fields as treeFields, groupVisibility as treeGroupVisibility } from '../protocol/form-views.js';

export interface ExecuteActionInput {
  pageContextId: string;
  action?: string;
  cue?: string;
  section?: string;
  rowIndex?: number;
  bookmark?: string;
  /**
   * Opt-in staleness guard. When provided, the operation checks the page
   * context's current generation before sending anything to BC. If the
   * generation differs, the call is rejected immediately with a STALE_CONTEXT
   * error. Obtain the value from `stateVersion` in bc_open_page / bc_read_data.
   */
  expectedStateVersion?: number;
}

export interface ExecuteActionOutput {
  success: boolean;
  dialog?: { formId: string; message?: string; fields?: ControlField[] };
  updatedFields?: Array<{ name: string; value?: string }>;
  changedSections: string[];
  openedPages: Array<{ pageContextId: string; caption: string }>;
  dialogsOpened: Array<{ formId: string; message?: string; fields?: ControlField[] }>;
  requiresDialogResponse: boolean;
  /** Captured file downloads produced by this action (e.g. Open in Excel); empty when none. */
  downloads: Download[];
  /** Links BC would open externally (not fetched by the server); empty when none. */
  externalUris: Array<{ uri: string; style: string }>;
}

export class ExecuteActionOperation {
  constructor(
    private readonly actionService: ActionService,
    private readonly repo: PageContextRepository,
    private readonly navigationService: NavigationService,
    private readonly downloadService: DownloadService,
  ) {}

  async execute(input: ExecuteActionInput): Promise<Result<ExecuteActionOutput, BCError>> {
    if (input.expectedStateVersion !== undefined) {
      const ctx = this.repo.get(input.pageContextId);
      if (ctx && ctx.generation !== input.expectedStateVersion) {
        return err(new StaleContextError(input.expectedStateVersion, ctx.generation, { pageContextId: input.pageContextId }));
      }
    }

    if (input.cue) {
      if (!input.section) {
        return err(new ProtocolError('cue requires a section (e.g. "subpage:Activities")'));
      }
      const result = await this.actionService.executeOnCue(input.pageContextId, input.section, input.cue);
      if (!isOk(result)) return result;
      const bizErr = classifyBusinessError(result.value.events);
      if (bizErr !== null) return err(bizErr);
      const out = this.buildOutput(input.pageContextId, result.value);
      const captured = await this.downloadService.capture(result.value.events);
      return ok({ ...out, downloads: captured.downloads, externalUris: captured.externalUris });
    }
    if (!input.action) {
      return err(new ProtocolError('Provide exactly one of: action, cue'));
    }

    // Position the current row before a row-scoped action (Delete/Edit/View/...).
    // BC's row actions target `{repeater}/cr/c[0]` = the currently-selected row,
    // so without this a Delete/Edit would silently hit the wrong record.
    if (input.bookmark !== undefined || input.rowIndex !== undefined) {
      const positioned = await this.positionRow(input);
      if (isErr(positioned)) return positioned;
    }

    const result = await this.actionService.executeAction(input.pageContextId, input.action, input.section);
    if (!isOk(result)) return result;
    const bizErr = classifyBusinessError(result.value.events);
    if (bizErr !== null) return err(bizErr);
    const out = this.buildOutput(input.pageContextId, result.value);
    const captured = await this.downloadService.capture(result.value.events);
    return ok({ ...out, downloads: captured.downloads, externalUris: captured.externalUris });
  }

  /**
   * Move BC's current-row cursor to the caller's target row so a subsequent
   * row-scoped action (which BC resolves against `{repeater}/cr/c[0]`) operates
   * on the intended record. Prefers `bookmark`; resolves `rowIndex` against the
   * section's loaded repeater rows.
   */
  private async positionRow(input: ExecuteActionInput): Promise<Result<void, BCError>> {
    let bookmark = input.bookmark;
    if (bookmark === undefined && input.rowIndex !== undefined) {
      const ctx = this.repo.get(input.pageContextId);
      if (!ctx) return err(new ProtocolError(`Page context not found: ${input.pageContextId}`));
      const resolved = resolveSection(ctx, input.section);
      if ('error' in resolved) {
        return err(new ProtocolError(resolved.error, { availableSections: resolved.availableSections }));
      }
      if (!resolved.repeater) {
        return err(new ProtocolError('rowIndex/bookmark supplied but the target section has no repeater.'));
      }
      const rows = resolved.form.rows.get(resolved.repeater.controlPath) ?? [];
      const row = rows[input.rowIndex];
      if (!row) {
        return err(new ProtocolError(
          `rowIndex ${input.rowIndex} is out of range (${rows.length} rows loaded). Read the section first or pass a bookmark.`,
        ));
      }
      bookmark = row.bookmark;
    }
    const selectResult = await this.navigationService.selectRow(input.pageContextId, bookmark!, input.section);
    if (isErr(selectResult)) return selectResult;
    return ok(undefined);
  }

  private buildOutput(pageContextId: string, ar: ActionResult): Omit<ExecuteActionOutput, 'downloads' | 'externalUris'> {
    let updatedFields: Array<{ name: string; value?: string }> | undefined;
    if (ar.updatedState) {
      const resolved = resolveSection(ar.updatedState, 'header');
      if (!('error' in resolved)) {
        const root = resolved.form.root;
        const groupVis = treeGroupVisibility(root);
        updatedFields = treeFields(root)
          .filter(f => f.properties.caption && isEffectivelyVisible(root, f.controlPath, groupVis, ar.updatedState!.wizardState))
          .map(f => ({ name: f.properties.caption!, value: f.properties.stringValue }));
      }
    }

    const ctx = this.repo.get(pageContextId);
    const changedSections = ctx ? detectChangedSections(ctx, ar.events) : [];
    const dialogsOpened = detectDialogs(ar.events);

    // Detect opened pages from FormCreated events (excluding the source page's forms)
    const openedPages: Array<{ pageContextId: string; caption: string }> = [];
    for (const event of ar.events) {
      if (event.type === 'FormCreated' && event.formId !== ctx?.rootFormId) {
        // New form opened -- check if repo has a page context for it
        const newCtx = this.repo.getByFormId(event.formId);
        if (newCtx && newCtx.pageContextId !== pageContextId) {
          openedPages.push({ pageContextId: newCtx.pageContextId, caption: newCtx.caption });
        }
      }
    }

    return {
      success: ar.success,
      dialog: ar.dialog ? {
        formId: ar.dialog.formId,
        message: dialogsOpened.find(d => d.formId === ar.dialog!.formId)?.message,
        fields: dialogsOpened.find(d => d.formId === ar.dialog!.formId)?.fields,
      } : undefined,
      updatedFields,
      changedSections,
      openedPages,
      dialogsOpened,
      requiresDialogResponse: dialogsOpened.length > 0,
    };
  }
}
