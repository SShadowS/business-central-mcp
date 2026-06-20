// src/services/lookup-service.ts
//
// Drives BC's field Lookup flow to enumerate related-table (FK) candidate values.
// Non-mutating: always cancels with LookupCancel=340 even on error.
//
// Protocol flow (live-verified on BC28, Customer Card page 21, Salesperson Code):
//   1. Validate field has hasLookup=true and canShowSimpleLookup !== false
//   2. Ensure edit mode (InvokeAction Edit=40 if field is read-only)
//   3. InvokeAction(Lookup=110) on the field controlPath
//   4. LookupFormReady event decoded as FormCreated (see event-decoder.ts)
//   5. Register lookup form in repo; extract inline rows from rc.Data.Rows.LoadedRows
//      (BC embeds rows in the control tree, NOT via separate DataLoaded events)
//   6. Optionally apply search (Filter(AddLine) preferred, SaveValue fallback)
//   7. Collect rows (inline or from DataLoaded after filter), map via row-mapping helpers
//   8. Always: InvokeAction(LookupCancel=340) in finally block
//
// Live-verified protocol finding (BC28, 2026-06-20):
//   LoadForm(loadData:true) on a lookup form returns only InvokeCompleted — no DataLoaded.
//   Rows are delivered inline in the LookupFormReady control tree under:
//     rc.Data.Rows.LoadedRows  (Array of { bookmark, cells: { "<binderName>": { stringValue } } })
//   The binderName keys match rcc ColumnBinder.Name (e.g. "1", "2") which mapRowCellKeys
//   remaps to column captions ("Code", "Name") via buildBinderToCaptionMap.

import { ok, err, isErr, type Result } from '../core/result.js';
import { ProtocolError } from '../core/errors.js';
import type { BCSession } from '../session/bc-session.js';
import type { PageContextRepository } from '../protocol/page-context-repo.js';
import type { Logger } from '../core/logger.js';
import { SystemAction } from '../protocol/types.js';
import type { RepeaterRow } from '../protocol/types.js';
import { fields as treeFields, repeaters as treeRepeaters } from '../protocol/form-views.js';
import { mapRowCellKeys } from '../protocol/row-mapping.js';
import { buildFormTree } from '../protocol/form-tree-builder.js';
import type { FormNode } from '../protocol/form-node.js';
import { walkTree } from '../protocol/form-tree-walk.js';

export interface LookupRow {
  /** Bookmark for this row (empty string if not available). */
  key: string;
  /** Column caption -> string value mapping. */
  values: Record<string, string>;
}

export interface LookupResult {
  rows: LookupRow[];
  /** Count of returned rows (may equal maxRows if BC has more). */
  totalFound: number;
}

const DEFAULT_MAX_ROWS = 50;

export class LookupService {
  constructor(
    private readonly session: BCSession,
    private readonly repo: PageContextRepository,
    private readonly logger: Logger,
  ) {}

  async lookup(
    pageContextId: string,
    fieldCaption: string,
    opts?: { search?: string; maxRows?: number },
  ): Promise<Result<LookupResult, ProtocolError>> {
    const maxRows = opts?.maxRows ?? DEFAULT_MAX_ROWS;

    // 1. Resolve page context
    const ctx = this.repo.get(pageContextId);
    if (!ctx) return err(new ProtocolError(`Page context not found: ${pageContextId}`));

    const rootForm = ctx.forms.get(ctx.rootFormId);
    if (!rootForm) return err(new ProtocolError(`Root form not loaded for page: ${pageContextId}`));

    // 2. Find the field by caption (case-insensitive)
    const lower = fieldCaption.toLowerCase();
    const fieldNode = treeFields(rootForm.root).find(
      f => (f.properties.caption ?? '').toLowerCase() === lower,
    );
    if (!fieldNode) {
      const available = treeFields(rootForm.root)
        .filter(f => f.hasLookup)
        .map(f => f.properties.caption ?? '')
        .filter(Boolean);
      return err(new ProtocolError(`Field not found: "${fieldCaption}"`, { lookupableFields: available }));
    }

    // 3. Check field has a lookup
    if (!fieldNode.hasLookup) {
      return err(new ProtocolError(
        `Field "${fieldCaption}" has no lookup. Use bc_lookup only on fields with isLookup=true (FK/related-table fields).`,
      ));
    }

    // 4. Detect AL OnLookup trigger (CanShowSimpleLookup=false -> BC won't emit LookupFormReady)
    if (fieldNode.canShowSimpleLookup === false) {
      return err(new ProtocolError(
        `Field "${fieldCaption}" uses an AL OnLookup trigger; not browseable via bc_lookup. ` +
        `BC will not emit a lookup form for this field — it drives a custom lookup instead.`,
      ));
    }

    // 5. Ensure edit mode if field is read-only
    if (fieldNode.properties.editable === false) {
      const editResult = await this.session.invoke(
        { type: 'InvokeAction', formId: ctx.rootFormId, controlPath: 'server:', systemAction: SystemAction.Edit },
        (e) => e.type === 'InvokeCompleted',
      );
      if (isErr(editResult)) {
        return err(new ProtocolError(
          `Field "${fieldCaption}" is read-only and entering edit mode failed: ${editResult.error.message}`,
        ));
      }
      this.repo.applyToPage(pageContextId, editResult.value);
    }

    // 6. Invoke Lookup=110 on the field controlPath
    const lookupResult = await this.session.invoke(
      {
        type: 'InvokeAction',
        formId: ctx.rootFormId,
        controlPath: fieldNode.controlPath,
        systemAction: SystemAction.Lookup,
      },
      (e) => e.type === 'InvokeCompleted' || e.type === 'FormCreated',
    );

    if (isErr(lookupResult)) {
      return err(new ProtocolError(`Lookup=110 failed on field "${fieldCaption}": ${lookupResult.error.message}`));
    }

    // 7. Find the FormCreated event (emitted by EventDecoder from LookupFormReady)
    const lookupFormCreated = lookupResult.value.find(e => e.type === 'FormCreated');
    if (!lookupFormCreated || lookupFormCreated.type !== 'FormCreated' || !lookupFormCreated.formId) {
      return err(new ProtocolError(
        `Field "${fieldCaption}" did not open a lookup form. ` +
        `Ensure the page is open at a record (not a blank new record).`,
      ));
    }
    const lookupFormId = lookupFormCreated.formId;

    // 8. Register the lookup form as a temporary page context
    const lookupPcId = `session:lookup:${lookupFormId.substring(0, 8)}`;
    this.repo.create(lookupPcId, lookupFormId);
    this.repo.applyToPage(lookupPcId, lookupResult.value);

    // Build the form tree for the lookup form (needed for search path discovery)
    let lookupRoot: FormNode | null = null;
    try {
      lookupRoot = buildFormTree(lookupFormCreated.controlTree);
    } catch {
      // non-fatal -- repo state from applyToPage will be used
    }

    // 9. Seed inline rows from rc.Data.Rows.LoadedRows in the control tree.
    //    BC embeds rows directly in LookupFormReady — LoadForm(loadData:true) returns
    //    only InvokeCompleted with no DataLoaded. (Live-verified BC28, 2026-06-20.)
    if (lookupRoot) {
      const inlineRows = extractInlineRows(lookupFormCreated.controlTree);
      const repeaterMap = treeRepeaters(lookupRoot);
      const firstRepeater = repeaterMap.values().next();
      if (!firstRepeater.done && inlineRows.length > 0) {
        this.repo.seedRepeaterRows(lookupPcId, lookupFormId, firstRepeater.value.controlPath, inlineRows);
      }
    }

    // 10. Always cancel in finally (non-mutating cleanup)
    try {
      return await this.doLookupWork(lookupFormId, lookupPcId, lookupRoot, fieldCaption, maxRows, opts?.search);
    } finally {
      try {
        await this.session.invoke(
          { type: 'InvokeAction', formId: lookupFormId, controlPath: 'server:', systemAction: SystemAction.LookupCancel },
          (e) => e.type === 'InvokeCompleted',
        );
      } catch {
        // best effort
      }
      this.session.removeOpenForm(lookupFormId);
    }
  }

  private async doLookupWork(
    lookupFormId: string,
    lookupPcId: string,
    lookupRoot: FormNode | null,
    fieldCaption: string,
    maxRows: number,
    search?: string,
  ): Promise<Result<LookupResult, ProtocolError>> {
    // Rows are already seeded from inline rc.Data.Rows.LoadedRows (see caller).
    // No LoadForm call is needed: BC returns only InvokeCompleted with no DataLoaded
    // for lookup forms. (Live-verified on BC28, 2026-06-20.)

    // 11. Optional search — filter on the already-open lookup form
    if (search) {
      await this.applyLookupSearch(lookupFormId, lookupPcId, lookupRoot, search);
    }

    // 12. Collect rows
    const lookupCtx = this.repo.get(lookupPcId);
    if (!lookupCtx) return ok({ rows: [], totalFound: 0 });

    const lookupForm = lookupCtx.forms.get(lookupFormId);
    if (!lookupForm) return ok({ rows: [], totalFound: 0 });

    const repeatersMap = treeRepeaters(lookupForm.root);
    const repeaterEntry = repeatersMap.values().next();
    if (repeaterEntry.done) {
      this.logger.warn(`bc_lookup: lookup form for "${fieldCaption}" has no repeater — returning empty`);
      return ok({ rows: [], totalFound: 0 });
    }
    const repeaterNode = repeaterEntry.value;
    const rawRows = lookupForm.rows.get(repeaterNode.controlPath) ?? [];

    const columns = repeaterNode.columns.map(c => ({
      controlPath: c.controlPath,
      caption: c.properties.caption ?? '',
      type: 'rcc' as const,
      columnBinderName: c.columnBinder?.name,
    }));

    const remapped = mapRowCellKeys([...rawRows], columns);
    const capped = remapped.slice(0, maxRows);

    const rows: LookupRow[] = capped.map(row => ({
      key: row.bookmark,
      values: Object.fromEntries(
        Object.entries(row.cells).map(([k, v]) => [k, v != null ? String(v) : '']),
      ),
    }));

    this.logger.info(`bc_lookup: "${fieldCaption}" -> ${rows.length} candidates (capped at ${maxRows})`);
    return ok({ rows, totalFound: rows.length });
  }

  private async applyLookupSearch(
    lookupFormId: string,
    lookupPcId: string,
    lookupRoot: FormNode | null,
    search: string,
  ): Promise<void> {
    const lookupCtx = this.repo.get(lookupPcId);
    const lookupForm = lookupCtx?.forms.get(lookupFormId);
    const root = lookupForm?.root ?? lookupRoot;
    if (!root) return;

    // Lookup forms use a filter value control (type "fvc") for search input.
    // Live-verified on BC28 (Salesperson/Purchaser lookup, 2026-06-20):
    //   - The filc node at server:c[3] is present but Filter(AddLine) is REJECTED by BC
    //     with InteractionParameterException, which then causes LookupCancel to fail
    //     with InvalidSessionException (fatal). DO NOT use Filter(AddLine) on lookup forms.
    //   - The correct path is SaveValue on the fvc (filter value control) node inside
    //     the filc subtree: filc -> sfcl -> fvc (caption "Search").
    //   - SaveValue on fvc triggers DataLoaded with the filtered row set.
    let fvcPath: string | undefined;
    for (const node of walkTree(root)) {
      if (node.type === 'fvc') {
        fvcPath = node.controlPath;
        break;
      }
    }

    if (fvcPath) {
      try {
        const svResult = await this.session.invoke(
          { type: 'SaveValue', formId: lookupFormId, controlPath: fvcPath, newValue: search },
          (e) => e.type === 'InvokeCompleted' || e.type === 'DataLoaded',
        );
        if (!isErr(svResult)) {
          this.repo.applyToPage(lookupPcId, svResult.value);
        }
      } catch {
        // ignore -- return unfiltered
      }
      return;
    }

    // Fallback: SaveValue into first visible editable sc field
    const firstScField = treeFields(root).find(
      f => f.type === 'sc' && (f.properties.editable ?? false) && (f.properties.visible ?? true),
    );
    if (firstScField) {
      try {
        const svResult = await this.session.invoke(
          { type: 'SaveValue', formId: lookupFormId, controlPath: firstScField.controlPath, newValue: search },
          (e) => e.type === 'InvokeCompleted' || e.type === 'DataLoaded',
        );
        if (!isErr(svResult)) {
          this.repo.applyToPage(lookupPcId, svResult.value);
        }
      } catch {
        // ignore -- return unfiltered
      }
    }
  }
}

/**
 * Extract inline rows from the LookupFormReady control tree.
 *
 * BC embeds the initial row set in the first rc child node under:
 *   controlTree.Children[N].Data.Rows.LoadedRows
 * where Children[N] is the repeater (t="rc"). Each LoadedRow is already in
 * RepeaterRow format: { bookmark, cells: { "<binderName>": { stringValue } } }.
 *
 * Live-verified: Salesperson/Purchaser lookup form (Cronus28, 2026-06-20).
 */
function extractInlineRows(controlTree: unknown): RepeaterRow[] {
  if (!controlTree || typeof controlTree !== 'object') return [];
  const lf = controlTree as Record<string, unknown>;
  const children = lf.Children;
  if (!Array.isArray(children)) return [];

  for (const child of children) {
    if (!child || typeof child !== 'object') continue;
    const node = child as Record<string, unknown>;
    if (node.t !== 'rc') continue;

    const data = node.Data as Record<string, unknown> | undefined;
    if (!data) continue;
    const rowsBlock = data.Rows as Record<string, unknown> | undefined;
    if (!rowsBlock) continue;
    const loadedRows = rowsBlock.LoadedRows;
    if (!Array.isArray(loadedRows)) continue;

    const result: RepeaterRow[] = [];
    for (const raw of loadedRows) {
      if (!raw || typeof raw !== 'object') continue;
      const r = raw as Record<string, unknown>;
      const bookmark = typeof r.bookmark === 'string' ? r.bookmark : '';
      const cells = (r.cells && typeof r.cells === 'object') ? r.cells as Record<string, unknown> : {};
      result.push({ bookmark, cells });
    }
    return result; // Only the first rc node's rows
  }
  return [];
}
