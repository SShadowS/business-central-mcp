import { ok, err, isErr, type Result } from '../core/result.js';
import { ProtocolError } from '../core/errors.js';
import type { BCSession } from '../session/bc-session.js';
import type { PageContextRepository } from '../protocol/page-context-repo.js';
import type { PageState, RepeaterRow, ControlField, SaveValueInteraction } from '../protocol/types.js';
import type { Logger } from '../core/logger.js';

export interface FieldWriteResult {
  fieldName: string;
  controlPath: string;
  success: boolean;
  newValue?: string;
  error?: string;
}

export class DataService {
  constructor(
    private readonly session: BCSession,
    private readonly repo: PageContextRepository,
    private readonly logger: Logger,
  ) {}

  readRows(pageContextId: string): Result<RepeaterRow[], ProtocolError> {
    const state = this.repo.get(pageContextId);
    if (!state) return err(new ProtocolError(`Page context not found: ${pageContextId}`));
    return ok(state.repeater?.rows ?? []);
  }

  readField(pageContextId: string, fieldName: string): Result<ControlField | undefined, ProtocolError> {
    const state = this.repo.get(pageContextId);
    if (!state) return err(new ProtocolError(`Page context not found: ${pageContextId}`));
    return ok(this.resolveField(state, fieldName));
  }

  getFields(pageContextId: string): Result<ControlField[], ProtocolError> {
    const state = this.repo.get(pageContextId);
    if (!state) return err(new ProtocolError(`Page context not found: ${pageContextId}`));
    return ok(state.controlTree);
  }

  async writeField(
    pageContextId: string,
    fieldName: string,
    value: string,
  ): Promise<Result<FieldWriteResult, ProtocolError>> {
    const state = this.repo.get(pageContextId);
    if (!state) return err(new ProtocolError(`Page context not found: ${pageContextId}`));

    const field = this.resolveField(state, fieldName);
    if (!field) {
      return err(new ProtocolError(`Field not found: ${fieldName}`, {
        pageContextId,
        availableFields: state.controlTree.map(f => f.caption || f.controlPath).filter(Boolean),
      }));
    }

    const interaction: SaveValueInteraction = {
      type: 'SaveValue',
      formId: state.formId,
      controlPath: field.controlPath,
      newValue: value,
    };

    this.logger.debug('data', `writeField: ${fieldName} = ${value}`, { pageContextId, controlPath: field.controlPath });

    const result = await this.session.invoke(
      interaction,
      (event) => event.type === 'InvokeCompleted' || event.type === 'PropertyChanged',
    );

    if (isErr(result)) return result;

    // Apply events to update state
    this.repo.applyToPage(pageContextId, result.value);

    const updatedField = this.repo.get(pageContextId)?.controlTree.find(f => f.controlPath === field.controlPath);

    return ok({
      fieldName,
      controlPath: field.controlPath,
      success: true,
      newValue: updatedField?.stringValue ?? value,
    });
  }

  async writeFields(
    pageContextId: string,
    fields: Record<string, string>,
  ): Promise<Result<FieldWriteResult[], ProtocolError>> {
    const results: FieldWriteResult[] = [];
    for (const [name, value] of Object.entries(fields)) {
      const result = await this.writeField(pageContextId, name, value);
      if (isErr(result)) {
        results.push({ fieldName: name, controlPath: '', success: false, error: result.error.message });
      } else {
        results.push(result.value);
      }
    }
    return ok(results);
  }

  private resolveField(state: PageState, fieldName: string): ControlField | undefined {
    const lower = fieldName.toLowerCase();
    // Try caption match first, then controlPath match
    return state.controlTree.find(f =>
      f.caption.toLowerCase() === lower ||
      f.controlPath === fieldName,
    );
  }
}
