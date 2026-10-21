import { ok, err, isOk, type Result } from '../core/result.js';
import { ProtocolError, InputValidationError, type BCError } from '../core/errors.js';
import type { BCSession } from '../session/bc-session.js';
import type { PageContextRepository } from '../protocol/page-context-repo.js';
import { SystemAction } from '../protocol/types.js';
import { detectChangedSections, detectDialogs } from '../protocol/mutation-result.js';
import { classifyBusinessError } from '../protocol/error-classifier.js';
import { formClosed } from '../protocol/replay-safety.js';
import type { Download, DownloadService } from '../services/download-service.js';
import { buildFormTree } from '../protocol/form-tree-builder.js';
import { fields as treeFields } from '../protocol/form-views.js';
import { fieldNodeToControlField } from '../protocol/mcp-adapters.js';
import type { BCEvent } from '../protocol/types.js';

export interface RespondDialogInput {
  pageContextId: string;
  dialogFormId: string;
  response: 'ok' | 'cancel' | 'yes' | 'no' | 'abort' | 'close' | 'none';
  fields?: Array<{ field: string; value: string }>;
}

export interface DialogFieldResult { field: string; controlPath: string; requested: string; value?: string; error?: string }

export interface RespondDialogOutput {
  success: boolean;
  changedSections: string[];
  dialogsOpened: Array<{ formId: string; message?: string; fields?: import('../protocol/types.js').ControlField[] }>;
  requiresDialogResponse: boolean;
  openedPages: Array<{ pageContextId: string; caption: string }>;
  /** Captured file downloads produced by this response (e.g. Open in Excel); empty when none. */
  downloads: Download[];
  /** Links BC would open externally (not fetched by the server); empty when none. */
  externalUris: Array<{ uri: string; style: string }>;
  /** True when BC closed the dialog form: a re-run against that dialogFormId is rejected (FormNotFoundException). */
  replaySafe: boolean;
  /** Per-field outcome of input.fields (value = what BC echoed back). */
  fieldResults?: DialogFieldResult[];
}

const RESPONSE_MAP: Record<string, number> = {
  ok: SystemAction.Ok,
  cancel: SystemAction.Cancel,
  yes: SystemAction.Yes,
  no: SystemAction.No,
  abort: SystemAction.Abort,
};

export class RespondDialogOperation {
  constructor(
    private readonly session: BCSession,
    private readonly repo: PageContextRepository,
    private readonly downloadService: DownloadService,
  ) {}

  async execute(input: RespondDialogInput): Promise<Result<RespondDialogOutput, BCError>> {
    const ctx = this.repo.get(input.pageContextId);
    if (!ctx) return err(new ProtocolError(`Page context not found: ${input.pageContextId}`));

    let fieldResults: DialogFieldResult[] | undefined;
    if (input.fields && input.fields.length > 0) {
      const set = await this.setDialogFields(input.pageContextId, input.dialogFormId, input.fields);
      if (!isOk(set)) return set;
      fieldResults = set.value;
    }
    if (input.response === 'none') {
      return ok({ success: !(fieldResults ?? []).some(f => f.error), changedSections: [], dialogsOpened: [], requiresDialogResponse: true,
        openedPages: [], downloads: [], externalUris: [], replaySafe: false, fieldResults });
    }

    // "close" uses CloseForm instead of InvokeAction
    if (input.response === 'close') {
      const closeResult = await this.session.invoke(
        { type: 'CloseForm' as const, formId: input.dialogFormId },
        (event) => event.type === 'InvokeCompleted',
      );
      if (!isOk(closeResult)) return closeResult;

      this.repo.applyToPage(input.pageContextId, closeResult.value);

      const closeBizErr = classifyBusinessError(closeResult.value);
      if (closeBizErr !== null) return err(closeBizErr);

      const updatedCtx = this.repo.get(input.pageContextId);
      const changedSections = updatedCtx ? detectChangedSections(updatedCtx, closeResult.value) : [];
      const newDialogs = detectDialogs(closeResult.value);
      const closeCaptured = await this.downloadService.capture(closeResult.value);
      return ok({
        success: true,
        changedSections,
        dialogsOpened: newDialogs,
        requiresDialogResponse: newDialogs.length > 0,
        openedPages: [],
        downloads: closeCaptured.downloads,
        externalUris: closeCaptured.externalUris,
        replaySafe: formClosed(closeResult.value, input.dialogFormId),
        fieldResults,
      });
    }

    const systemAction = RESPONSE_MAP[input.response];
    if (systemAction === undefined) {
      return err(new ProtocolError(`Invalid dialog response: ${input.response}. Use: ok, cancel, yes, no, abort, close`));
    }

    const result = await this.session.invoke(
      {
        type: 'InvokeAction' as const,
        formId: input.dialogFormId,
        controlPath: 'server:c[0]',
        systemAction,
      },
      (event) => event.type === 'InvokeCompleted' || event.type === 'FormCreated' || event.type === 'DialogOpened',
    );

    if (!isOk(result)) return result;

    const events = result.value;
    this.repo.applyToPage(input.pageContextId, events);

    const bizErr = classifyBusinessError(events);
    if (bizErr !== null) return err(bizErr);

    // BC runs Abort only on a dialog that has an Abort action (InvokeActionInteraction: session,
    // context or form action); confirms, messages and request pages have none (LogicalDialog.AddActions),
    // so BC answers InvokeCompleted and the dialog stays open (live cronus29, report 6 request page).
    // The dialog's tree cannot decide this up front: context actions such as a request page's OK are
    // not serialized as controls. Nothing ran, so this is a definite failure (#38).
    if (systemAction === SystemAction.Abort && !formClosed(events, input.dialogFormId)
      && !events.some(e => e.type === 'DialogOpened' || e.type === 'FormCreated')) {
      return err(new InputValidationError([{ path: 'response', message: `BC ignored 'abort': dialog ${input.dialogFormId} has no Abort action and is still open. Answer it with ok, cancel, yes, no or close.` }]));
    }

    const updatedCtx = this.repo.get(input.pageContextId);
    const changedSections = updatedCtx ? detectChangedSections(updatedCtx, events) : [];
    const newDialogs = detectDialogs(events);

    // Check for new pages opened (e.g., posting creates a Posted Invoice)
    const openedPages: Array<{ pageContextId: string; caption: string }> = [];
    for (const event of events) {
      if (event.type === 'FormCreated' && event.formId !== ctx.rootFormId) {
        const newCtx = this.repo.getByFormId(event.formId);
        if (newCtx && newCtx.pageContextId !== input.pageContextId) {
          openedPages.push({ pageContextId: newCtx.pageContextId, caption: newCtx.caption });
        }
      }
    }

    const captured = await this.downloadService.capture(events);
    return ok({
      success: true,
      changedSections,
      dialogsOpened: newDialogs,
      requiresDialogResponse: newDialogs.length > 0,
      openedPages,
      downloads: captured.downloads,
      externalUris: captured.externalUris,
      replaySafe: formClosed(events, input.dialogFormId),
      fieldResults,
    });
  }

  private async setDialogFields(pcId: string, dialogFormId: string, wanted: Array<{ field: string; value: string }>): Promise<Result<DialogFieldResult[], BCError>> {
    const page = this.repo.get(pcId);
    const dlg = page?.dialogs.find(d => d.formId === dialogFormId);
    if (!dlg?.controlTree) return err(new ProtocolError(`Dialog ${dialogFormId} not found on page context ${pcId}`));
    const raw = dlg.controlTree as Record<string, unknown>;
    const root = buildFormTree(raw.t === 'lf' ? raw : { ...raw, t: 'lf' });
    const all = treeFields(root).map(f => fieldNodeToControlField(root, f));
    const out: DialogFieldResult[] = [];
    for (const w of wanted) {
      const key = w.field.trim().toLowerCase();
      const f = all.find(c => c.controlPath === w.field) ?? all.find(c => c.caption.trim().toLowerCase() === key)
        ?? all.find(c => c.caption.trim().toLowerCase().startsWith(key));
      if (!f) {
        return err(new InputValidationError([{ path: 'fields', message: `Field "${w.field}" not on dialog. Available: ${all.map(c => c.caption).filter(Boolean).join(', ')}` }]));
      }
      const r = await this.session.invoke(
        { type: 'SaveValue' as const, formId: dialogFormId, controlPath: f.controlPath, newValue: w.value },
        (e) => e.type === 'InvokeCompleted',
      );
      if (!isOk(r)) { out.push({ field: f.caption, controlPath: f.controlPath, requested: w.value, error: r.error.message }); continue; }
      const evs = r.value as BCEvent[];
      const bizErr = classifyBusinessError(evs);
      let echoed: string | undefined;
      for (const e of evs) {
        if (e.type === 'PropertyChanged' && e.controlPath === f.controlPath) {
          const ch = e.changes as Record<string, unknown>;
          if (typeof ch.StringValue === 'string') echoed = ch.StringValue;
          else if (ch.ObjectValue !== undefined && echoed === undefined) echoed = String(ch.ObjectValue);
        }
      }
      out.push({ field: f.caption, controlPath: f.controlPath, requested: w.value, ...(echoed !== undefined ? { value: echoed } : {}), ...(bizErr ? { error: bizErr.message } : {}) });
    }
    return ok(out);
  }
}
