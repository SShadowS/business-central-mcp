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
//   5. Register lookup form in repo, LoadForm(loadData:true)
//   6. Optionally apply search (Filter(AddLine) preferred, SaveValue fallback)
//   7. Collect DataLoaded rows, map via row-mapping helpers
//   8. Always: InvokeAction(LookupCancel=340) in finally block

import { ok, err, isErr, type Result } from '../core/result.js';
import { ProtocolError } from '../core/errors.js';
import type { BCSession } from '../session/bc-session.js';
import type { PageContextRepository } from '../protocol/page-context-repo.js';
import type { Logger } from '../core/logger.js';
import { SystemAction } from '../protocol/types.js';
import { fields as treeFields, repeaters as treeRepeaters, filterControlPath as treeFilterControlPath } from '../protocol/form-views.js';
import { mapRowCellKeys } from '../protocol/row-mapping.js';
import { buildFormTree } from '../protocol/form-tree-builder.js';
import type { FormNode } from '../protocol/form-node.js';

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

    // Pre-build the form tree for search (in case repo state doesn't have it yet)
    let lookupRoot: FormNode | null = null;
    try {
      lookupRoot = buildFormTree(lookupFormCreated.controlTree);
    } catch {
      // non-fatal -- repo state from applyToPage will be used
    }

    // 9. Always cancel in finally (non-mutating cleanup)
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
    // 10. LoadForm(loadData:true) to populate rows
    const loadResult = await this.session.invoke(
      { type: 'LoadForm', formId: lookupFormId, loadData: true },
      (e) => e.type === 'InvokeCompleted' || e.type === 'DataLoaded',
    );
    if (isErr(loadResult)) {
      return err(new ProtocolError(`LoadForm on lookup form failed: ${loadResult.error.message}`));
    }
    this.repo.applyToPage(lookupPcId, loadResult.value);

    // 11. Optional search
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

    // Prefer Filter(AddLine) if a filc node exists
    const filterPath = treeFilterControlPath(root);
    if (filterPath) {
      try {
        const filterResult = await this.session.invoke(
          { type: 'Filter', formId: lookupFormId, controlPath: filterPath, filterOperation: 1, filterValue: search },
          (e) => e.type === 'InvokeCompleted' || e.type === 'DataLoaded',
        );
        if (!isErr(filterResult)) {
          this.repo.applyToPage(lookupPcId, filterResult.value);
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
