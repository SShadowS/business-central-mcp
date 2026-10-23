import type { KeyByInput } from '../protocol/section-dto.js';
import { resolveKeyBy, DEFAULT_KEY_BY, type KeyBy } from '../protocol/row-mapping.js';
import { v4 as uuid } from 'uuid';
import { err, ok, isOk, isErr, type Result } from '../core/result.js';
import { ProtocolError, StaleContextError, InvalidBookmarkError, type BCError } from '../core/errors.js';
import { classifyBusinessError } from '../protocol/error-classifier.js';
import type { ActionService, ActionResult } from '../services/action-service.js';
import type { NavigationService } from '../services/navigation-service.js';
import type { PageContextRepository } from '../protocol/page-context-repo.js';
import type { BCEvent, ControlField } from '../protocol/types.js';
import type { Download, DownloadService } from '../services/download-service.js';
import { resolveSection } from '../protocol/section-resolver.js';
import { detectChangedSections, detectDialogs } from '../protocol/mutation-result.js';
import { isEffectivelyVisible } from '../protocol/visibility.js';
import { fields as treeFields, groupVisibility as treeGroupVisibility } from '../protocol/form-views.js';
import { isInvalidBookmarkError } from '../session/rpc-error-classifier.js';
import { actionReplaySafe } from '../protocol/replay-safety.js';

export interface ExecuteActionInput extends Pick<KeyByInput, 'keyBy'> {
  pageContextId: string;
  action?: string;
  cue?: string;
  section?: string;
  rowIndex?: number;
  bookmark?: string;
  /**
   * Stable row identifiers for a MULTI-ROW action (e.g. batch Delete). The
   * first bookmark is the anchor/current row -- BC requires the current row
   * to be a member of the selection set for selection-consuming actions.
   * Mutually exclusive with `bookmark`, `rowIndex`, and `cue`. Rejected for
   * current-row-only actions (Edit/View/DrillDown/New) since those never
   * consume a selection.
   */
  bookmarks?: string[];
  /**
   * Opt-in staleness guard. When provided, the operation checks the page
   * context's current generation before sending anything to BC. If the
   * generation differs, the call is rejected immediately with a STALE_CONTEXT
   * error. Obtain the value from `stateVersion` in bc_open_page / bc_read_data.
   */
  expectedStateVersion?: number;
}

/**
 * A dialog the action opened. `pageContextId` addresses it as a page context of its own:
 * fill its fields with bc_write_data against it, then answer it with bc_respond_dialog.
 */
export interface OpenedDialog {
  pageContextId: string;
  formId: string;
  message?: string;
  fields?: ControlField[];
}

export interface ExecuteActionOutput {
  success: boolean;
  dialog?: OpenedDialog;
  updatedFields?: Array<{ name: string; value?: string }>;
  changedSections: string[];
  openedPages: Array<{ pageContextId: string; caption: string }>;
  dialogsOpened: OpenedDialog[];
  requiresDialogResponse: boolean;
  /** Captured file downloads produced by this action (e.g. Open in Excel); empty when none. */
  downloads: Download[];
  /** Links BC would open externally (not fetched by the server); empty when none. */
  externalUris: Array<{ uri: string; style: string }>;
  /** True only for Refresh, or when BC closed the form the action ran on (a re-run is rejected). */
  replaySafe: boolean;
}

export class ExecuteActionOperation {
  constructor(
    private readonly actionService: ActionService,
    private readonly repo: PageContextRepository,
    private readonly navigationService: NavigationService,
    private readonly downloadService: DownloadService,
    private readonly maxSelection: number,
  ) {}

  async execute(input: ExecuteActionInput): Promise<Result<ExecuteActionOutput, BCError>> {
    if (input.expectedStateVersion !== undefined) {
      const ctx = this.repo.get(input.pageContextId);
      if (ctx && ctx.generation !== input.expectedStateVersion) {
        return err(new StaleContextError(input.expectedStateVersion, ctx.generation, { pageContextId: input.pageContextId }));
      }
    }

    if (input.bookmarks !== undefined) {
      if (input.bookmark !== undefined || input.rowIndex !== undefined || input.cue !== undefined) {
        return err(new ProtocolError('bookmarks is mutually exclusive with bookmark, rowIndex, and cue.'));
      }
      if (!input.action) {
        return err(new ProtocolError('bookmarks requires an action (not a cue).'));
      }
      if (input.bookmarks.length === 0 || input.bookmarks.some(b => b === '')) {
        return err(new ProtocolError('bookmarks must be a non-empty array of non-empty bookmark strings.'));
      }
      // Order-preserving de-dupe: a repeated bookmark is one row, not two, so the
      // maxSelection cap below is enforced against the de-duplicated set.
      const deduped = Array.from(new Set(input.bookmarks));
      if (deduped.length > this.maxSelection) {
        return err(new ProtocolError(
          `bookmarks selects ${deduped.length} rows, exceeding the maximum selection size of ${this.maxSelection} (BC_MAX_SELECTION).`,
        ));
      }
      if (this.actionService.isCurrentRowOnlyAction(input.action)) {
        return err(new ProtocolError(
          `Action '${input.action}' operates on the current row only and does not consume a bookmarks[] selection. Use bookmark/rowIndex instead.`,
        ));
      }

      const ctx = this.repo.get(input.pageContextId);
      if (!ctx) return err(new ProtocolError(`Page context not found: ${input.pageContextId}`));
      const resolved = resolveSection(ctx, input.section);
      if ('error' in resolved) {
        return err(new ProtocolError(resolved.error, { availableSections: resolved.availableSections }));
      }
      if (!resolved.repeater) {
        return err(new ProtocolError('bookmarks supplied but the target section has no repeater.'));
      }

      const result = await this.actionService.executeAction(input.pageContextId, input.action, input.section, {
        formId: resolved.form.formId,
        controlPath: resolved.repeater.controlPath,
        bookmarks: deduped,
      });
      if (!isOk(result)) {
        if (isInvalidBookmarkError(result.error.message)) {
          return err(new InvalidBookmarkError(deduped[0]!));
        }
        return result;
      }
      const bizErr = classifyBusinessError(result.value.events);
      if (bizErr !== null) return err(bizErr);
      const out = this.buildOutput(input.pageContextId, result.value, resolveKeyBy(input.keyBy));
      const captured = await this.downloadService.capture(result.value.events);
      return ok({ ...out, downloads: captured.downloads, externalUris: captured.externalUris });
    }

    if (input.cue) {
      if (!input.section) {
        return err(new ProtocolError('cue requires a section (e.g. "subpage:Activities")'));
      }
      const result = await this.actionService.executeOnCue(input.pageContextId, input.section, input.cue);
      if (!isOk(result)) return result;
      const bizErr = classifyBusinessError(result.value.events);
      if (bizErr !== null) return err(bizErr);
      const out = this.buildOutput(input.pageContextId, result.value, resolveKeyBy(input.keyBy));
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
    const out = this.buildOutput(input.pageContextId, result.value, resolveKeyBy(input.keyBy));
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

  private buildOutput(pageContextId: string, ar: ActionResult, keyBy: KeyBy = DEFAULT_KEY_BY): Omit<ExecuteActionOutput, 'downloads' | 'externalUris'> {
    let updatedFields: Array<{ name: string; value?: string }> | undefined;
    if (ar.updatedState) {
      const resolved = resolveSection(ar.updatedState, 'header');
      if (!('error' in resolved)) {
        const root = resolved.form.root;
        const groupVis = treeGroupVisibility(root);
        updatedFields = treeFields(root)
          .filter(f => f.properties.caption && isEffectivelyVisible(root, f.controlPath, groupVis, ar.updatedState!.wizardState))
          .map(f => ({
            // keyBy "designName": name is the AL DesignName (fallback caption).
            name: keyBy === 'designName' ? (f.properties.designName || f.properties.caption!) : f.properties.caption!,
            value: f.properties.stringValue,
          }));
      }
    }

    const ctx = this.repo.get(pageContextId);
    const changedSections = ctx ? detectChangedSections(ctx, ar.events) : [];
    const dialogsOpened = this.registerDialogs(pageContextId, detectDialogs(ar.events), ar.events);

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
      dialog: ar.dialog ? dialogsOpened.find(d => d.formId === ar.dialog!.formId) : undefined,
      updatedFields,
      changedSections,
      openedPages,
      dialogsOpened,
      requiresDialogResponse: dialogsOpened.length > 0,
      replaySafe: actionReplaySafe(ar),
    };
  }

  /**
   * Register every dialog the action opened as a page context of its own, the way
   * bc_run_report registers its request page, so bc_write_data can fill the dialog's
   * fields (it resolves the field, checks the write and classifies BC's answer) and
   * bc_respond_dialog can press its button. Only the dialog's own events are applied to
   * its context: a sibling dialog or a host-form event in the same batch must not leak in.
   */
  private registerDialogs(
    ownerPageContextId: string,
    detected: ReturnType<typeof detectDialogs>,
    events: BCEvent[],
  ): OpenedDialog[] {
    return detected.map(d => {
      const pageContextId = `session:page:dialog:${uuid().substring(0, 8)}`;
      this.repo.create(pageContextId, d.formId, { isModal: true, ownerPageContextId });
      this.repo.applyToPage(pageContextId, events.flatMap(e => this.eventForDialog(e, d.formId)));
      return { pageContextId, ...d };
    });
  }

  private eventForDialog(event: BCEvent, formId: string): BCEvent[] {
    if (!('formId' in event) || event.formId !== formId) return [];
    if (event.type !== 'DialogOpened') return [event];
    // Same normalisation as detectDialogs: a dialog tree can arrive without the `lf` tag.
    const raw = event.controlTree as Record<string, unknown> | undefined;
    if (raw && raw.t !== 'lf' && typeof raw.Children !== 'undefined') {
      return [{ ...event, controlTree: { ...raw, t: 'lf' } }];
    }
    return [event];
  }
}
