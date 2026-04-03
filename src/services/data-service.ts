import { ok, err, isErr, type Result } from '../core/result.js';
import { ProtocolError } from '../core/errors.js';
import type { BCSession } from '../session/bc-session.js';
import type { PageContextRepository } from '../protocol/page-context-repo.js';
import type { BCEvent, RepeaterRow, RepeaterColumn, RepeaterState, ControlField, TabGroup, SaveValueInteraction, SetCurrentRowInteraction } from '../protocol/types.js';
import type { Logger } from '../core/logger.js';
import { resolveSection } from '../protocol/section-resolver.js';

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
    return ok(mapRowCellKeys(resolved.repeater.rows, resolved.repeater.columns));
  }

  getRepeaterTotalRowCount(pageContextId: string, sectionId?: string): number | null {
    const ctx = this.repo.get(pageContextId);
    if (!ctx) return null;
    const resolved = resolveSection(ctx, sectionId);
    if ('error' in resolved) return null;
    return resolved.repeater?.totalRowCount ?? null;
  }

  getTabs(pageContextId: string, sectionId?: string): Result<TabGroup[] | undefined, ProtocolError> {
    const ctx = this.repo.get(pageContextId);
    if (!ctx) return err(new ProtocolError(`Page context not found: ${pageContextId}`));
    const resolved = resolveSection(ctx, sectionId, 'header');
    if ('error' in resolved) return err(new ProtocolError(resolved.error, { availableSections: resolved.availableSections }));
    return ok(resolved.form.tabs);
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

    const { form, repeater } = resolved;

    // Line cell write: when targeting a specific row in a repeater section
    if (repeater && (options?.bookmark !== undefined || options?.rowIndex !== undefined)) {
      // Line interactions use the CHILD form's formId (the subpage form).
      // BC sends DataLoaded with root formId but SetCurrentRow/SaveValue use child formId.
      // Verified: SetCurrentRow with root formId -> InvalidBookmarkException;
      //           SetCurrentRow with child formId -> SUCCESS.
      return this.writeLineCell(pageContextId, form.formId, repeater, fieldName, value, options);
    }

    // Header/card field write
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
    const events = result.value;
    this.repo.applyToPage(pageContextId, events);

    const updatedCtx = this.repo.get(pageContextId);
    const updatedForm = updatedCtx?.forms.get(form.formId);
    const updatedField = updatedForm?.controlTree.find(f => f.controlPath === field.controlPath);

    return ok({
      fieldName,
      controlPath: field.controlPath,
      success: true,
      newValue: updatedField?.stringValue ?? value,
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
    repeater: RepeaterState,
    fieldName: string,
    value: string,
    options: { bookmark?: string; rowIndex?: number },
  ): Promise<Result<FieldWriteResult, ProtocolError>> {
    // Resolve bookmark from rowIndex if needed
    let bookmark = options.bookmark;
    if (!bookmark && options.rowIndex !== undefined) {
      const row = repeater.rows[options.rowIndex];
      if (!row) {
        return err(new ProtocolError(
          `Row index ${options.rowIndex} out of range. Loaded rows: 0-${repeater.rows.length - 1}.`,
        ));
      }
      bookmark = row.bookmark;
    }
    if (!bookmark) return err(new ProtocolError('No bookmark or rowIndex provided for line cell write'));

    // Step 1: Select the row (on the ROOT form -- BC routes line interactions through root)
    const selectInteraction: SetCurrentRowInteraction = {
      type: 'SetCurrentRow',
      formId,
      controlPath: repeater.controlPath,
      key: bookmark,
    };
    const selectResult = await this.session.invoke(selectInteraction, (event) =>
      event.type === 'InvokeCompleted' || event.type === 'BookmarkChanged',
    );
    if (isErr(selectResult)) return selectResult;
    this.repo.applyToPage(pageContextId, selectResult.value);

    // Step 2: Find column by caption
    const col = repeater.columns.find(c => c.caption.toLowerCase() === fieldName.toLowerCase());
    if (!col) {
      return err(new ProtocolError(`Column '${fieldName}' not found in repeater.`, {
        availableColumns: repeater.columns.map(c => c.caption).filter(Boolean),
      }));
    }

    // Extract column index from controlPath (e.g., ".../co[2]" -> 2)
    const match = col.controlPath.match(/co\[(\d+)\]/);
    if (!match) return err(new ProtocolError(`Cannot determine column index from ${col.controlPath}`));
    const colIndex = parseInt(match[1]!, 10);

    // Step 3: SaveValue on the cell via {repeater}/cr/c[N]
    // cr -> CurrentRowViewport.Children[0] (the current data row)
    // c[N] -> data row's Children[N] (the cell control at column index N)
    // Note: NOT cr/co[N] -- co resolves on the RepeaterControl to DefaultRowTemplate,
    // but we need the CURRENT row's cell. Verified from decompiled LogicalControl.ResolvePathName.
    const cellPath = `${repeater.controlPath}/cr/c[${colIndex}]`;
    const saveInteraction: SaveValueInteraction = {
      type: 'SaveValue',
      formId,
      controlPath: cellPath,
      newValue: value,
    };

    this.logger.info(`writeLineCell: ${fieldName} = ${value} at ${cellPath} (formId=${formId})`);

    const saveResult = await this.session.invoke(saveInteraction, (event) =>
      event.type === 'InvokeCompleted' || event.type === 'PropertyChanged',
    );
    if (isErr(saveResult)) return saveResult;
    const saveEvents = saveResult.value;
    this.repo.applyToPage(pageContextId, saveEvents);

    // Combine events from select + save steps
    const allEvents = [...(isErr(selectResult) ? [] : selectResult.value), ...saveEvents];
    return ok({ fieldName, controlPath: cellPath, success: true, newValue: value, events: allEvents });
  }

  private resolveField(controlTree: ControlField[], fieldName: string): ControlField | undefined {
    const lower = fieldName.toLowerCase();
    return controlTree.find(f =>
      f.caption.toLowerCase() === lower ||
      f.controlPath === fieldName,
    );
  }
}

/** @internal exported for use by operations that format rows for MCP output */
export { mapRowCellKeys };

/**
 * Build a mapping from columnBinderName to column caption.
 * Used to remap row.cells keys from internal binder names to human-readable captions.
 */
function buildBinderToCaptionMap(columns: RepeaterColumn[]): Map<string, string> {
  const map = new Map<string, string>();
  const usedCaptions = new Map<string, number>();
  for (const col of columns) {
    if (!col.columnBinderName) continue;
    let caption = col.caption || col.columnBinderName;
    // Disambiguate duplicate captions with ordinal suffix
    const count = usedCaptions.get(caption) ?? 0;
    if (count > 0) {
      caption = `${caption}#${count + 1}`;
    }
    usedCaptions.set(col.caption || col.columnBinderName, count + 1);
    map.set(col.columnBinderName, caption);
  }
  return map;
}

/**
 * Remap row cell keys from columnBinderName to caption.
 * Cell values are extracted: if value is an object with stringValue, use that.
 */
function mapRowCellKeys(rows: RepeaterRow[], columns: RepeaterColumn[]): RepeaterRow[] {
  const binderMap = buildBinderToCaptionMap(columns);
  return rows.map(row => ({
    bookmark: row.bookmark,
    cells: remapCells(row.cells, binderMap),
  }));
}

function remapCells(
  cells: Record<string, unknown>,
  binderMap: Map<string, string>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, rawValue] of Object.entries(cells)) {
    const caption = binderMap.get(key) ?? key;
    // Extract the display value from BC's cell structure
    // BC sends cells as objects like { stringValue: "...", objectValue: ..., editable: ..., ... }
    if (rawValue && typeof rawValue === 'object') {
      const cell = rawValue as Record<string, unknown>;
      // Prefer stringValue (formatted), fall back to objectValue (raw), then null for empty cells
      result[caption] = cell.stringValue ?? cell.objectValue ?? null;
    } else {
      result[caption] = rawValue;
    }
  }
  return result;
}
