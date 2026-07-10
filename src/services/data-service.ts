import { ok, err, isErr, type Result } from '../core/result.js';
import { ProtocolError } from '../core/errors.js';
import type { BCSession } from '../session/bc-session.js';
import type { PageContextRepository } from '../protocol/page-context-repo.js';
import type { BCEvent, RepeaterRow, ControlField, TabGroup, SaveValueInteraction, SetCurrentRowInteraction, ScrollRepeaterInteraction } from '../protocol/types.js';
import type { Logger } from '../core/logger.js';
import { resolveSection } from '../protocol/section-resolver.js';
import { fields as treeFields, tabs as treeTabs } from '../protocol/form-views.js';
import { findByControlPath } from '../protocol/form-tree-walk.js';
import { isFieldNode, type FieldNode, type FormNode, type RepeaterNode } from '../protocol/form-node.js';
import { fieldNodeToControlField } from '../protocol/mcp-adapters.js';
import { mapRowCellKeys } from '../protocol/row-mapping.js';

export interface FieldWriteResult {
  fieldName: string;
  controlPath: string;
  success: boolean;
  newValue?: string;
  error?: string;
  events?: BCEvent[];
}

export interface WriteFieldsResult {
  results: FieldWriteResult[];
  events: BCEvent[];
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
    if (!resolved.repeater) return ok([]);
    const cols = resolved.repeater.columns.map(c => ({
      controlPath: c.controlPath,
      caption: c.properties.caption ?? '',
      type: 'rcc' as const,
      columnBinderName: c.columnBinder?.name,
      columnBinderPath: c.columnBinder?.path,
    }));
    return ok(mapRowCellKeys([...resolved.rows], cols));
  }

  getRepeaterTotalRowCount(pageContextId: string, sectionId?: string): number | null {
    const ctx = this.repo.get(pageContextId);
    if (!ctx) return null;
    const resolved = resolveSection(ctx, sectionId);
    if ('error' in resolved) return null;
    return resolved.repeater?.properties.totalRowCount ?? null;
  }

  getTabs(pageContextId: string, sectionId?: string): Result<TabGroup[] | undefined, ProtocolError> {
    const ctx = this.repo.get(pageContextId);
    if (!ctx) return err(new ProtocolError(`Page context not found: ${pageContextId}`));
    const resolved = resolveSection(ctx, sectionId, 'header');
    if ('error' in resolved) return err(new ProtocolError(resolved.error, { availableSections: resolved.availableSections }));
    const ts = treeTabs(resolved.form.root);
    if (ts.length === 0) return ok(undefined);
    return ok(ts.map(t => ({
      caption: t.caption,
      fields: t.fields.map(f => fieldNodeToControlField(resolved.form.root, f)),
    })));
  }

  /**
   * Scroll a repeater to load additional rows beyond the current viewport.
   * BC uses ContinuousScrolling: delta > 0 loads next rows, delta < 0 loads previous.
   * Returns all rows after scrolling (including newly loaded ones).
   */
  async scrollRepeater(pageContextId: string, delta: number, sectionId?: string): Promise<Result<RepeaterRow[], ProtocolError>> {
    const ctx = this.repo.get(pageContextId);
    if (!ctx) return err(new ProtocolError(`Page context not found: ${pageContextId}`));
    const resolved = resolveSection(ctx, sectionId);
    if ('error' in resolved) return err(new ProtocolError(resolved.error, { availableSections: resolved.availableSections }));
    if (!resolved.repeater) return ok([]);

    const interaction: ScrollRepeaterInteraction = {
      type: 'ScrollRepeater',
      formId: resolved.form.formId,
      controlPath: resolved.repeater.controlPath,
      delta,
    };

    const result = await this.session.invoke(
      interaction,
      (event) => event.type === 'InvokeCompleted' || event.type === 'DataLoaded',
    );

    if (isErr(result)) return result;
    this.repo.applyToPage(pageContextId, result.value);

    // Return all rows after scroll (newly loaded rows merged by form-state)
    return this.readRows(pageContextId, sectionId);
  }

  readField(pageContextId: string, fieldName: string, sectionId?: string): Result<ControlField | undefined, ProtocolError> {
    const ctx = this.repo.get(pageContextId);
    if (!ctx) return err(new ProtocolError(`Page context not found: ${pageContextId}`));
    const resolved = resolveSection(ctx, sectionId, 'header');
    if ('error' in resolved) return err(new ProtocolError(resolved.error, { availableSections: resolved.availableSections }));
    const node = this.resolveFieldNode(resolved.form.root, fieldName);
    return ok(node ? fieldNodeToControlField(resolved.form.root, node) : undefined);
  }

  getFields(pageContextId: string, sectionId?: string): Result<ControlField[], ProtocolError> {
    const ctx = this.repo.get(pageContextId);
    if (!ctx) return err(new ProtocolError(`Page context not found: ${pageContextId}`));
    const resolved = resolveSection(ctx, sectionId, 'header');
    if ('error' in resolved) return err(new ProtocolError(resolved.error, { availableSections: resolved.availableSections }));
    return ok(treeFields(resolved.form.root).map(f => fieldNodeToControlField(resolved.form.root, f)));
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

    // Line cell write: when targeting a specific row in a repeater section
    if (resolved.repeater && (options?.bookmark !== undefined || options?.rowIndex !== undefined)) {
      // Line interactions use the CHILD form's formId (the subpage form).
      // BC sends DataLoaded with root formId but SetCurrentRow/SaveValue use child formId.
      // Verified: SetCurrentRow with root formId -> InvalidBookmarkException;
      //           SetCurrentRow with child formId -> SUCCESS.
      return this.writeLineCell(pageContextId, form.formId, resolved.repeater, [...resolved.rows], fieldName, value, options);
    }

    // Header/card field write
    const fieldNode = this.resolveFieldNode(form.root, fieldName);
    if (!fieldNode) {
      return err(new ProtocolError(`Field not found: ${fieldName}`, {
        pageContextId,
        availableFields: treeFields(form.root).map(f => f.properties.caption ?? f.controlPath).filter(Boolean),
      }));
    }

    const interaction: SaveValueInteraction = {
      type: 'SaveValue',
      formId: form.formId,
      controlPath: fieldNode.controlPath,
      newValue: value,
    };

    this.logger.debug('data', `writeField: ${fieldName} = ${value}`, { pageContextId, controlPath: fieldNode.controlPath });

    const result = await this.session.invoke(
      interaction,
      (event) => event.type === 'InvokeCompleted' || event.type === 'PropertyChanged',
    );

    if (isErr(result)) return result;
    const events = result.value;
    this.repo.applyToPage(pageContextId, events);

    const updatedCtx = this.repo.get(pageContextId);
    const updatedForm = updatedCtx?.forms.get(form.formId);
    const updatedNode = updatedForm ? findByControlPath(updatedForm.root, fieldNode.controlPath) : undefined;
    const newValue = updatedNode && isFieldNode(updatedNode) ? (updatedNode.properties.stringValue ?? value) : value;

    return ok({
      fieldName,
      controlPath: fieldNode.controlPath,
      success: true,
      newValue,
      events,
    });
  }

  async writeFields(
    pageContextId: string,
    fields: Record<string, string>,
    options?: { sectionId?: string; bookmark?: string; rowIndex?: number },
  ): Promise<Result<WriteFieldsResult, ProtocolError>> {
    const results: FieldWriteResult[] = [];
    const allEvents: BCEvent[] = [];
    for (const [name, value] of Object.entries(fields)) {
      const result = await this.writeField(pageContextId, name, value, options);
      if (isErr(result)) {
        results.push({ fieldName: name, controlPath: '', success: false, error: result.error.message });
      } else {
        results.push(result.value);
        if (result.value.events) allEvents.push(...result.value.events);
      }
    }
    return ok({ results, events: allEvents });
  }

  private async writeLineCell(
    pageContextId: string,
    formId: string,
    repeater: RepeaterNode,
    rows: readonly RepeaterRow[],
    fieldName: string,
    value: string,
    options: { bookmark?: string; rowIndex?: number },
  ): Promise<Result<FieldWriteResult, ProtocolError>> {
    let bookmark = options.bookmark;
    if (!bookmark && options.rowIndex !== undefined) {
      const row = rows[options.rowIndex];
      if (!row) return err(new ProtocolError(`Row index ${options.rowIndex} out of range. Loaded rows: 0-${rows.length - 1}.`));
      bookmark = row.bookmark;
    }
    if (!bookmark) return err(new ProtocolError('No bookmark or rowIndex provided for line cell write'));

    // Step 1: select the row
    const selectInteraction: SetCurrentRowInteraction = {
      type: 'SetCurrentRow', formId, controlPath: repeater.controlPath, key: bookmark,
    };
    const selectResult = await this.session.invoke(
      selectInteraction,
      (event) => event.type === 'InvokeCompleted' || event.type === 'BookmarkChanged',
    );
    if (isErr(selectResult)) return selectResult;
    this.repo.applyToPage(pageContextId, selectResult.value);

    // Step 2: find column by caption
    const col = repeater.columns.find(c => (c.properties.caption ?? '').toLowerCase() === fieldName.toLowerCase());
    if (!col) {
      return err(new ProtocolError(`Column '${fieldName}' not found in repeater.`, {
        availableColumns: repeater.columns.map(c => c.properties.caption ?? '').filter(Boolean),
      }));
    }
    const match = col.controlPath.match(/co\[(\d+)\]/);
    if (!match) return err(new ProtocolError(`Cannot determine column index from ${col.controlPath}`));
    const colIndex = parseInt(match[1]!, 10);
    const cellPath = `${repeater.controlPath}/cr/c[${colIndex}]`;
    const saveInteraction: SaveValueInteraction = {
      type: 'SaveValue', formId, controlPath: cellPath, newValue: value,
    };
    this.logger.info(`writeLineCell: ${fieldName} = ${value} at ${cellPath} (formId=${formId})`);
    const saveResult = await this.session.invoke(
      saveInteraction,
      (event) => event.type === 'InvokeCompleted' || event.type === 'PropertyChanged',
    );
    if (isErr(saveResult)) return saveResult;
    const allEvents = [...selectResult.value, ...saveResult.value];
    this.repo.applyToPage(pageContextId, saveResult.value);

    const updatedCtx = this.repo.get(pageContextId);
    const updatedForm = updatedCtx?.forms.get(formId);
    const updatedNode = updatedForm ? findByControlPath(updatedForm.root, cellPath) : undefined;
    const newValue = updatedNode && isFieldNode(updatedNode) ? (updatedNode.properties.stringValue ?? value) : value;

    return ok({ fieldName, controlPath: cellPath, success: true, newValue, events: allEvents });
  }

  private resolveFieldNode(root: FormNode, fieldName: string): FieldNode | undefined {
    const lower = fieldName.toLowerCase();
    for (const f of treeFields(root)) {
      if ((f.properties.caption ?? '').toLowerCase() === lower) return f;
      if (f.controlPath === fieldName) return f;
    }
    return undefined;
  }
}

