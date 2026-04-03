import { mapResult, type Result } from '../core/result.js';
import type { ProtocolError } from '../core/errors.js';
import type { ActionService } from '../services/action-service.js';
import { resolveSection } from '../protocol/section-resolver.js';

export interface ExecuteActionInput {
  pageContextId: string;
  action: string;
  section?: string;
  rowIndex?: number;
  bookmark?: string;
}

export interface ExecuteActionOutput {
  success: boolean;
  dialog?: { formId: string };
  updatedFields?: Array<{ name: string; value?: string }>;
}

export class ExecuteActionOperation {
  constructor(private readonly actionService: ActionService) {}

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
      return {
        success: ar.success,
        dialog: ar.dialog ? { formId: ar.dialog.formId } : undefined,
        updatedFields,
      };
    });
  }
}
