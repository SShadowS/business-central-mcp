import { mapResult, type Result } from '../core/result.js';
import type { ProtocolError } from '../core/errors.js';
import type { ActionService } from '../services/action-service.js';
import type { PageContextRepository } from '../protocol/page-context-repo.js';
import type { ControlField } from '../protocol/types.js';
import { resolveSection } from '../protocol/section-resolver.js';
import { detectChangedSections, detectDialogs } from '../protocol/mutation-result.js';

export interface ExecuteActionInput {
  pageContextId: string;
  action: string;
  section?: string;
  rowIndex?: number;
  bookmark?: string;
}

export interface ExecuteActionOutput {
  success: boolean;
  dialog?: { formId: string; message?: string; fields?: ControlField[] };
  updatedFields?: Array<{ name: string; value?: string }>;
  changedSections: string[];
  openedPages: Array<{ pageContextId: string; caption: string }>;
  dialogsOpened: Array<{ formId: string; message?: string; fields?: ControlField[] }>;
  requiresDialogResponse: boolean;
}

export class ExecuteActionOperation {
  constructor(
    private readonly actionService: ActionService,
    private readonly repo: PageContextRepository,
  ) {}

  async execute(input: ExecuteActionInput): Promise<Result<ExecuteActionOutput, ProtocolError>> {
    const result = await this.actionService.executeAction(input.pageContextId, input.action, input.section);
    return mapResult(result, (ar) => {
      let updatedFields: Array<{ name: string; value?: string }> | undefined;
      if (ar.updatedState) {
        const resolved = resolveSection(ar.updatedState, 'header');
        if (!('error' in resolved)) {
          updatedFields = resolved.form.controlTree
            .filter(f => f.visible && f.caption)
            .map(f => ({ name: f.caption, value: f.stringValue }));
        }
      }

      const ctx = this.repo.get(input.pageContextId);
      const changedSections = ctx ? detectChangedSections(ctx, ar.events) : [];
      const dialogsOpened = detectDialogs(ar.events);

      // Detect opened pages from FormCreated events (excluding the source page's forms)
      const openedPages: Array<{ pageContextId: string; caption: string }> = [];
      for (const event of ar.events) {
        if (event.type === 'FormCreated' && event.formId !== ctx?.rootFormId) {
          // New form opened -- check if repo has a page context for it
          const newCtx = this.repo.getByFormId(event.formId);
          if (newCtx && newCtx.pageContextId !== input.pageContextId) {
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
    });
  }
}
