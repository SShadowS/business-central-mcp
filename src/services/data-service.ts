import { ok, err, isErr, type Result } from '../core/result.js';
import { ProtocolError } from '../core/errors.js';
import type { BCSession } from '../session/bc-session.js';
import type { PageContextRepository } from '../protocol/page-context-repo.js';
import type { RepeaterRow, RepeaterColumn, ControlField, SaveValueInteraction } from '../protocol/types.js';
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
    if (!resolved.repeater) return ok([]);
    return ok(mapRowCellKeys(resolved.repeater.rows, resolved.repeater.columns));
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
