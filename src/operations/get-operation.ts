import { isErr, ok, err, type Result } from '../core/result.js';
import { InputValidationError, type BCError } from '../core/errors.js';
import type { PageService } from '../services/page-service.js';
import { buildSection } from '../protocol/section-dto.js';
import { resolveSection } from '../protocol/section-resolver.js';
import { fields as treeFields } from '../protocol/form-views.js';
import { digestInput, type OperationEntry, type OperationLedger } from '../mcp/operation-ledger.js';

export interface GetOperationInput {
  operationId: string;
}

/** Fresh state of an operation's target, read in the current session. */
export interface ReadBack {
  company?: string;
  pageId: string;
  /** Record the page was re-opened on (root form bookmark, else the targeted row). */
  bookmark?: string;
  sectionId: string;
  /** Card-shape: the identified fields (key fields + written fields), caption -> value (null = not on the page). */
  fields?: Record<string, string | null>;
  /** List-shape: the targeted row's current cells; null when the row is gone (e.g. deleted). */
  row?: { bookmark: string; cells: Record<string, unknown> } | null;
}

export interface GetOperationOutput {
  entry: OperationEntry;
  /** Present when the outcome is unknown or not replay-safe and the target could be re-read. */
  readBack?: ReadBack;
  /** SHA-256 of the canonical (sorted-key JSON) readBack. */
  evidenceHash?: string;
  /** Why no read-back was done although one was needed. */
  readBackError?: { code: string; message: string };
}

export class GetOperationOperation {
  constructor(
    private readonly ledger: OperationLedger,
    private readonly pageService: PageService,
    private readonly company: () => string | undefined,
  ) {}

  async execute(input: GetOperationInput): Promise<Result<GetOperationOutput, BCError>> {
    const entry = await this.ledger.get(input.operationId);
    if (!entry) return err(new InputValidationError([{ path: 'operationId', message: `no operation recorded under '${input.operationId}'` }]));
    if (entry.status === 'completed' && entry.replaySafe === true) return ok({ entry });

    const target = entry.target;
    const pageId = target?.page?.pageId;
    if (!target || !pageId) {
      return ok({ entry, readBackError: { code: 'NO_TARGET', message: 'The ledger entry has no page identity to read back from.' } });
    }
    const company = this.company();
    if (target.company && company && target.company !== company) {
      return ok({ entry, readBackError: { code: 'COMPANY_MISMATCH', message: `The operation ran in company '${target.company}' but the session is on '${company}'. Switch with bc_switch_company, then call bc_get_operation again.` } });
    }

    const sectionId = target.section?.sectionId ?? 'header';
    const targetRow = target.rows?.[0];
    // A list page's target row is itself the record; a card/document re-opens on its root record.
    const bookmark = (sectionId === 'header' ? targetRow?.bookmark : undefined) ?? target.page!.bookmark ?? targetRow?.bookmark;
    const opened = await this.pageService.openPage(pageId, bookmark ? { bookmark } : undefined);
    if (isErr(opened)) return opened;
    const ctx = opened.value;
    try {
      // A bookmark BC cannot open (record deleted, wrong table) yields an
      // ownerless error dialog instead of the page (verified live, cronus29).
      if (ctx.isModal) {
        return ok({ entry, readBackError: { code: 'RECORD_NOT_OPENED', message: `Page ${pageId} did not open on the recorded record${bookmark ? ` (bookmark ${bookmark})` : ''}; it may have been deleted.` } });
      }
      const section = buildSection(ctx, sectionId);
      if (!section) {
        return ok({ entry, readBackError: { code: 'SECTION_NOT_FOUND', message: `Section '${sectionId}' is not on page ${pageId}.` } });
      }
      const readBack: ReadBack = { ...(company ? { company } : {}), pageId, ...(bookmark ? { bookmark } : {}), sectionId };
      if (targetRow) {
        const row = section.rows?.find(r => r.bookmark === targetRow.bookmark);
        readBack.row = row ? { bookmark: row.bookmark, cells: { ...row.cells } } : null;
      } else {
        const written = target.args['fields'];
        const names = new Set([
          ...Object.keys(target.fields ?? {}),
          ...(written && typeof written === 'object' ? Object.keys(written) : []),
        ]);
        // Named fields are looked up in the whole form tree: a written field can be
        // hidden in a fresh (view-mode, collapsed) page and so be absent from section.fields.
        const resolved = resolveSection(ctx, sectionId);
        const tree = 'error' in resolved ? [] : treeFields(resolved.form.root);
        readBack.fields = names.size > 0
          ? Object.fromEntries([...names].map(n => [n, tree.find(f => f.properties.caption === n)?.properties.stringValue ?? null]))
          : Object.fromEntries((section.fields ?? []).map(f => [f.name, f.value ?? null]));
      }
      return ok({ entry, readBack, evidenceHash: digestInput(readBack) });
    } finally {
      await this.pageService.closePage(ctx.pageContextId, { discardChanges: true }).catch(() => undefined);
    }
  }
}
