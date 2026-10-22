import { ok, err, isErr, type Result } from '../core/result.js';
import { ProtocolError } from '../core/errors.js';
import type { BCSession } from '../session/bc-session.js';
import type { PageContextRepository } from '../protocol/page-context-repo.js';
import type { BCEvent, RepeaterRow, ControlField, TabGroup, SaveValueInteraction, SetCurrentRowInteraction, ScrollRepeaterInteraction } from '../protocol/types.js';
import type { Logger } from '../core/logger.js';
import { resolveSection } from '../protocol/section-resolver.js';
import { fields as treeFields, tabs as treeTabs, actions as treeActions, groupVisibility as treeGroupVisibility, findField } from '../protocol/form-views.js';
import { isEffectivelyVisible } from '../protocol/visibility.js';
import type { PageContext } from '../protocol/page-context.js';
import { SystemAction } from '../protocol/types.js';
import { findByControlPath } from '../protocol/form-tree-walk.js';
import { isFieldNode, type NodeProperties, type RepeaterNode } from '../protocol/form-node.js';
import { fieldNodeToControlField } from '../protocol/mcp-adapters.js';
import { mapRowCellKeys, repeaterColumnFromNode, findColumnNode, availableColumnNames, DEFAULT_KEY_BY, type KeyBy } from '../protocol/row-mapping.js';
import { valueEchoed } from '../protocol/replay-safety.js';

export interface FieldWriteResult {
  fieldName: string;
  controlPath: string;
  success: boolean;
  newValue?: string;
  /** BC echoed the stored value (PropertyChanged on the written control): the write provably landed. */
  echoed?: boolean;
  error?: string;
  /** Set when BC sent no echo for the written control: the write is not confirmed (success only means BC raised no error). */
  warning?: string;
  events?: BCEvent[];
}

export interface WriteFieldsResult {
  results: FieldWriteResult[];
  events: BCEvent[];
}

/**
 * An invoke failed during a write. BCSession reports a timeout or a lost socket as
 * ProtocolError too, so the value may have reached BC (unlike a local "Field not found").
 */
class WriteInvokeError extends ProtocolError {}

const invokeFailed = (e: ProtocolError) => err(new WriteInvokeError(e.message, e.context, e.code));

/**
 * A document in view mode loads no empty rows; after Edit (SystemAction 40)
 * BC adds DraftRecord rows to write new lines into (live cronus28, Sales
 * Quote 41: 0 drafts in view mode, 15 after Edit). Issue #41.
 */
function emptyRowsHint(ctx: PageContext, rowCount: number): string {
  if (rowCount > 0) return '';
  const root = ctx.forms.get(ctx.rootFormId);
  const canEdit = root && treeActions(root.root).some(a => a.systemAction === SystemAction.Edit && a.properties.enabled !== false);
  return canEdit
    ? " The page is in view mode: run bc_execute_action 'Edit' first, then bc_read_data on this section to get the empty draft rows to write into."
    : ' Run bc_read_data on this section to load its rows.';
}

/**
 * Why a control cannot take a SaveValue, from its own published state. BC
 * serialises Visible / Enabled / Editable only when they are false (default
 * true), so only an explicit false counts. A SaveValue on such a control is a
 * silent no-op: `SaveValueInteraction.InvokeCore` returns early unless the
 * control is Editable, Enabled and Visible, with no echo and no error. The
 * published values are the effective ones (`LogicalControl` computes each from
 * the control, its column, its row and its parents), so a field in a hidden or
 * read-only group carries the false itself. `visible` overrides the node's own
 * flag: inside an active wizard step BC leaves a stale Visible=false.
 */
function unwritableReasons(props: NodeProperties, visible = props.visible !== false): string[] {
  const reasons: string[] = [];
  if (!visible) reasons.push('hidden (Visible=false, the page does not show it)');
  if (props.enabled === false) reasons.push('disabled (Enabled=false)');
  if (props.editable === false) reasons.push('not editable (Editable=false)');
  return reasons;
}

function notWritableError(kind: 'Field' | 'Column', name: string, reasons: string[], context: Record<string, unknown>): ProtocolError {
  return new ProtocolError(
    `${kind} '${name}' is ${reasons.join(' and ')}, so it cannot be written. BC ignores a write to such a control without an error; nothing was sent.`,
    { ...context, reasons },
  );
}

function unconfirmedWarning(name: string): string {
  return `BC did not echo a stored value for '${name}', so the write is not confirmed. BC echoes only a value that changed, so this is also what rewriting the current value looks like; read the field back to verify.`;
}

export class DataService {
  constructor(
    private readonly session: BCSession,
    private readonly repo: PageContextRepository,
    private readonly logger: Logger,
  ) {}

  readRows(pageContextId: string, sectionId?: string, keyBy: KeyBy = DEFAULT_KEY_BY): Result<RepeaterRow[], ProtocolError> {
    const ctx = this.repo.get(pageContextId);
    if (!ctx) return err(new ProtocolError(`Page context not found: ${pageContextId}`));
    const resolved = resolveSection(ctx, sectionId);
    if ('error' in resolved) return err(new ProtocolError(resolved.error, { availableSections: resolved.availableSections }));
    if (!resolved.repeater) return ok([]);
    const cols = resolved.repeater.columns.map(repeaterColumnFromNode);
    return ok(mapRowCellKeys([...resolved.rows], cols, keyBy));
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

  readField(pageContextId: string, fieldName: string, sectionId?: string, keyBy: KeyBy = DEFAULT_KEY_BY): Result<ControlField | undefined, ProtocolError> {
    const ctx = this.repo.get(pageContextId);
    if (!ctx) return err(new ProtocolError(`Page context not found: ${pageContextId}`));
    const resolved = resolveSection(ctx, sectionId, 'header');
    if ('error' in resolved) return err(new ProtocolError(resolved.error, { availableSections: resolved.availableSections }));
    const node = findField(resolved.form.root, fieldName, keyBy);
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
    options?: { sectionId?: string; bookmark?: string; rowIndex?: number; keyBy?: KeyBy },
  ): Promise<Result<FieldWriteResult, ProtocolError>> {
    const ctx = this.repo.get(pageContextId);
    if (!ctx) return err(new ProtocolError(`Page context not found: ${pageContextId}`));
    const resolved = resolveSection(ctx, options?.sectionId, 'header');
    if ('error' in resolved) return err(new ProtocolError(resolved.error, { availableSections: resolved.availableSections }));

    const { form } = resolved;
    const keyBy = options?.keyBy ?? DEFAULT_KEY_BY;

    // Line cell write: when targeting a specific row in a repeater section
    if (resolved.repeater && (options?.bookmark !== undefined || options?.rowIndex !== undefined)) {
      // Line interactions use the CHILD form's formId (the subpage form).
      // BC sends DataLoaded with root formId but SetCurrentRow/SaveValue use child formId.
      // Verified: SetCurrentRow with root formId -> InvalidBookmarkException;
      //           SetCurrentRow with child formId -> SUCCESS.
      return this.writeLineCell(pageContextId, form.formId, resolved.repeater, [...resolved.rows], fieldName, value, options);
    }

    // Header/card field write
    const fieldNode = findField(form.root, fieldName, keyBy);
    // A repeater column is not a form field: without a row target the lookup
    // above can only miss it. Say so instead of "Field not found".
    const isColumn = resolved.repeater ? findColumnNode(resolved.repeater.columns, fieldName, keyBy) !== undefined : undefined;
    if (!fieldNode && isColumn) {
      return err(new ProtocolError(
        `'${fieldName}' is a column of a list of rows: pass rowIndex or bookmark to write it.${emptyRowsHint(ctx, resolved.rows.length)}`,
      ));
    }
    if (!fieldNode) {
      return err(new ProtocolError(`Field not found: ${fieldName}`, {
        pageContextId,
        availableFields: treeFields(form.root).map(f => (keyBy === 'designName' ? f.properties.designName || f.properties.caption : f.properties.caption) ?? f.controlPath).filter(Boolean),
      }));
    }

    const visible = isEffectivelyVisible(form.root, fieldNode.controlPath, treeGroupVisibility(form.root), ctx.wizardState);
    const reasons = unwritableReasons(fieldNode.properties, visible);
    if (reasons.length > 0) return err(notWritableError('Field', fieldName, reasons, { pageContextId, controlPath: fieldNode.controlPath }));

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

    if (isErr(result)) return invokeFailed(result.error);
    const events = result.value;
    this.repo.applyToPage(pageContextId, events);

    const updatedCtx = this.repo.get(pageContextId);
    const updatedForm = updatedCtx?.forms.get(form.formId);
    const updatedNode = updatedForm ? findByControlPath(updatedForm.root, fieldNode.controlPath) : undefined;
    const newValue = updatedNode && isFieldNode(updatedNode) ? (updatedNode.properties.stringValue ?? value) : value;

    const echoed = valueEchoed(events, [form.formId, ctx.rootFormId], fieldNode.controlPath);
    return ok({
      fieldName,
      controlPath: fieldNode.controlPath,
      success: true,
      newValue,
      echoed,
      ...(echoed ? {} : { warning: unconfirmedWarning(fieldName) }),
      events,
    });
  }

  async writeFields(
    pageContextId: string,
    fields: Record<string, string>,
    options?: { sectionId?: string; bookmark?: string; rowIndex?: number; keyBy?: KeyBy },
  ): Promise<Result<WriteFieldsResult, ProtocolError>> {
    const results: FieldWriteResult[] = [];
    const allEvents: BCEvent[] = [];
    for (const [name, value] of Object.entries(fields)) {
      const result = await this.writeField(pageContextId, name, value, options);
      if (isErr(result)) {
        // The value may have reached BC: fail the call (the replay ledger records it as
        // unknown) instead of a definite per-field failure, and send nothing more.
        if (result.error instanceof WriteInvokeError) return result;
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
    options: { bookmark?: string; rowIndex?: number; keyBy?: KeyBy },
  ): Promise<Result<FieldWriteResult, ProtocolError>> {
    let bookmark = options.bookmark;
    if (!bookmark && options.rowIndex !== undefined) {
      const row = rows[options.rowIndex];
      if (!row) {
        const ctx = this.repo.get(pageContextId)!;
        const loaded = rows.length === 0 ? 'No rows are loaded.' : `Loaded rows: 0-${rows.length - 1}.`;
        return err(new ProtocolError(`Row index ${options.rowIndex} out of range. ${loaded}${emptyRowsHint(ctx, rows.length)}`));
      }
      bookmark = row.bookmark;
    }
    if (!bookmark) return err(new ProtocolError('No bookmark or rowIndex provided for line cell write'));

    const col = findColumnNode(repeater.columns, fieldName, options.keyBy);
    if (!col) {
      return err(new ProtocolError(`Column '${fieldName}' not found in repeater.`, {
        availableColumns: availableColumnNames(repeater.columns, options.keyBy),
      }));
    }
    const reasons = unwritableReasons(col.properties);
    if (reasons.length > 0) return err(notWritableError('Column', fieldName, reasons, { pageContextId, controlPath: col.controlPath }));
    // A row's cells carry their own editable/enabled (DataLoaded, written only when
    // false: LogicalControlSerializer.WriteDataValues), e.g. one locked line.
    const cell = rows.find(r => r.bookmark === bookmark)?.cells[col.columnBinder?.name ?? ''] as { editable?: unknown; enabled?: unknown } | undefined;
    const cellReasons = cell && typeof cell === 'object'
      ? unwritableReasons({ editable: cell.editable === false ? false : undefined, enabled: cell.enabled === false ? false : undefined })
      : [];
    if (cellReasons.length > 0) {
      return err(notWritableError('Column', fieldName, cellReasons.map(r => `${r} on this row`), { pageContextId, controlPath: col.controlPath, bookmark }));
    }

    // Step 1: select the row
    const selectInteraction: SetCurrentRowInteraction = {
      type: 'SetCurrentRow', formId, controlPath: repeater.controlPath, key: bookmark,
    };
    const selectResult = await this.session.invoke(
      selectInteraction,
      (event) => event.type === 'InvokeCompleted' || event.type === 'BookmarkChanged',
    );
    if (isErr(selectResult)) return invokeFailed(selectResult.error);
    this.repo.applyToPage(pageContextId, selectResult.value);

    // Step 2: address the column's cell in the current row
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
    if (isErr(saveResult)) return invokeFailed(saveResult.error);
    const allEvents = [...selectResult.value, ...saveResult.value];
    this.repo.applyToPage(pageContextId, saveResult.value);

    const updatedCtx = this.repo.get(pageContextId);
    const updatedForm = updatedCtx?.forms.get(formId);
    const updatedNode = updatedForm ? findByControlPath(updatedForm.root, cellPath) : undefined;
    const newValue = updatedNode && isFieldNode(updatedNode) ? (updatedNode.properties.stringValue ?? value) : value;

    const echoed = valueEchoed(saveResult.value, [formId, updatedCtx?.rootFormId ?? formId], cellPath);
    return ok({ fieldName, controlPath: cellPath, success: true, newValue, echoed, ...(echoed ? {} : { warning: unconfirmedWarning(fieldName) }), events: allEvents });
  }
}

