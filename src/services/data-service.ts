import { ok, err, isErr, type Result } from '../core/result.js';
import { ProtocolError } from '../core/errors.js';
import type { BCSession } from '../session/bc-session.js';
import type { PageContextRepository } from '../protocol/page-context-repo.js';
import type { RepeaterRow, ControlField, SaveValueInteraction } from '../protocol/types.js';
import type { Logger } from '../core/logger.js';
import { resolveSection } from '../protocol/section-resolver.js';

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

  readRows(pageContextId: string, sectionId?: string): Result<RepeaterRow[], ProtocolError> {
    const ctx = this.repo.get(pageContextId);
    if (!ctx) return err(new ProtocolError(`Page context not found: ${pageContextId}`));
    const resolved = resolveSection(ctx, sectionId);
    if ('error' in resolved) return err(new ProtocolError(resolved.error, { availableSections: resolved.availableSections }));
    return ok(resolved.repeater?.rows ?? []);
  }

  readField(pageContextId: string, fieldName: string, sectionId?: string): Result<ControlField | undefined, ProtocolError> {
    const ctx = this.repo.get(pageContextId);
    if (!ctx) return err(new ProtocolError(`Page context not found: ${pageContextId}`));
    const resolved = resolveSection(ctx, sectionId, 'header');
    if ('error' in resolved) return err(new ProtocolError(resolved.error, { availableSections: resolved.availableSections }));
    return ok(this.resolveField(resolved.form.controlTree, fieldName));
  }

  getFields(pageContextId: string, sectionId?: string): Result<ControlField[], ProtocolError> {
    const ctx = this.repo.get(pageContextId);
    if (!ctx) return err(new ProtocolError(`Page context not found: ${pageContextId}`));
    const resolved = resolveSection(ctx, sectionId, 'header');
    if ('error' in resolved) return err(new ProtocolError(resolved.error, { availableSections: resolved.availableSections }));
    return ok(resolved.form.controlTree);
  }

  async writeField(
    pageContextId: string,
    fieldName: string,
    value: string,
    options?: { sectionId?: string; bookmark?: string; rowIndex?: number },
  ): Promise<Result<FieldWriteResult, ProtocolError>> {
    const ctx = this.repo.get(pageContextId);
    if (!ctx) return err(new ProtocolError(`Page context not found: ${pageContextId}`));
    const resolved = resolveSection(ctx, options?.sectionId, 'header');
    if ('error' in resolved) return err(new ProtocolError(resolved.error, { availableSections: resolved.availableSections }));

    const { form } = resolved;
    const field = this.resolveField(form.controlTree, fieldName);
    if (!field) {
      return err(new ProtocolError(`Field not found: ${fieldName}`, {
        pageContextId,
        availableFields: form.controlTree.map(f => f.caption || f.controlPath).filter(Boolean),
      }));
    }

    const interaction: SaveValueInteraction = {
      type: 'SaveValue',
      formId: form.formId,
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

    const updatedCtx = this.repo.get(pageContextId);
    const updatedForm = updatedCtx?.forms.get(form.formId);
    const updatedField = updatedForm?.controlTree.find(f => f.controlPath === field.controlPath);

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
    options?: { sectionId?: string; bookmark?: string; rowIndex?: number },
  ): Promise<Result<FieldWriteResult[], ProtocolError>> {
    const results: FieldWriteResult[] = [];
    for (const [name, value] of Object.entries(fields)) {
      const result = await this.writeField(pageContextId, name, value, options);
      if (isErr(result)) {
        results.push({ fieldName: name, controlPath: '', success: false, error: result.error.message });
      } else {
        results.push(result.value);
      }
    }
    return ok(results);
  }

  private resolveField(controlTree: ControlField[], fieldName: string): ControlField | undefined {
    const lower = fieldName.toLowerCase();
    return controlTree.find(f =>
      f.caption.toLowerCase() === lower ||
      f.controlPath === fieldName,
    );
  }
}
