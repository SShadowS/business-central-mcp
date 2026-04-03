import { mapResult, type Result } from '../core/result.js';
import type { ProtocolError } from '../core/errors.js';
import type { ActionService } from '../services/action-service.js';

export interface ExecuteActionInput {
  pageContextId: string;
  action: string;
}

export interface ExecuteActionOutput {
  success: boolean;
  dialog?: { formId: string };
  updatedFields?: Array<{ name: string; value?: string }>;
}

export class ExecuteActionOperation {
  constructor(private readonly actionService: ActionService) {}

  async execute(input: ExecuteActionInput): Promise<Result<ExecuteActionOutput, ProtocolError>> {
    const result = await this.actionService.executeAction(input.pageContextId, input.action);
    return mapResult(result, (ar) => ({
      success: ar.success,
      dialog: ar.dialog ? { formId: ar.dialog.formId } : undefined,
      updatedFields: ar.updatedState?.controlTree
        .filter(f => f.visible && f.caption)
        .map(f => ({ name: f.caption, value: f.stringValue })),
    }));
  }
}
