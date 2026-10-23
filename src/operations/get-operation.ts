import { isErr, ok, err, type Result } from '../core/result.js';
import { InputValidationError, type BCError } from '../core/errors.js';
import type { PageService } from '../services/page-service.js';
import { buildSection, sectionOptionsFrom, type KeyByInput } from '../protocol/section-dto.js';
import { resolveSection } from '../protocol/section-resolver.js';
import { resolveKeyBy } from '../protocol/row-mapping.js';
import { findField } from '../protocol/form-views.js';
import { readKeyFields } from './target-descriptor.js';
import { digestInput, type OperationEntry, type OperationLedger } from '../mcp/operation-ledger.js';

export interface GetOperationInput extends KeyByInput {
  operationId: string;
}

/** Fresh state of an operation's target, read in the current session. */
export interface ReadBack {
  company?: string;
  pageId: string;
  /** Record the page was re-opened on (a list's targeted row, else the root form bookmark). */
  bookmark: string;
  sectionId: string;
  /**
   * Card-shape: the recorded primary-key fields re-read by table field number
   * (value null = not readable now). `source: 'bookmark'` fields come from the
   * landed record bookmark, not a control.
   */
  keyFields?: Array<{ fieldNo: number; caption: string; value: string | null; source?: 'bookmark' }>;
  /** Card-shape: the written fields (plus the leading-field fallback identity on unbound forms), caption -> value (null = not on the page). */
  fields?: Record<string, string | null>;
  /** List-shape: the targeted row's current cells; null when the row is gone (e.g. deleted). */
  row?: { bookmark: string; cells: Record<string, unknown> } | null;
  /**
   * Document-shape (a header target on a page with a lines subpage): the loaded
   * lines. A posting or release changes nothing in the header's leading key fields
   * but does change line state (e.g. "Quantity Shipped"), so without this the
   * read-back would only identify the record, not attest the outcome.
   */
  lines?: Array<{ bookmark: string; cells: Record<string, unknown> }>;
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
    private readonly hasOpenModal: () => boolean,
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

    // OpenForm runs LogicalModalityVerifier.VerifyAnyModalFormOpen (decompiled
    // NavPropertyBagInvokedActionBase / NavRunPagePropertyBagInvokedAction), and
    // BCSession answers that violation by closing the open dialogs (or resetting
    // the session for a modal it cannot safely close). A read-only
    // lookup must not cancel the pending confirm the caller is about to answer.
    if (this.hasOpenModal()) {
      return ok({ entry, readBackError: { code: 'MODAL_OPEN', message: 'A dialog is open in this session. Answer or close it (bc_respond_dialog / bc_close_page), then call bc_get_operation again.' } });
    }

    const sectionId = target.section?.sectionId ?? 'header';
    // Recorded field names resolve with the recorded keyBy; output keys use the
    // caller's keyBy, else the recorded one. Neither = caption (historical).
    const recordedKeyBy = resolveKeyBy(typeof target.args?.['keyBy'] === 'string' ? target.args['keyBy'] as string : undefined);
    const keyBy = resolveKeyBy(input.keyBy ?? recordedKeyBy);
    const sectionOpts = sectionOptionsFrom({ keyBy, includeColumnMetadata: input.includeColumnMetadata });
    const targetRow = target.rows?.[0];
    // A list page's target row is itself the record; a card/document re-opens on
    // its root record. Never open unkeyed: BC would land on an arbitrary record.
    const bookmark = sectionId === 'header' && targetRow ? targetRow.bookmark : target.page!.bookmark;
    if (!bookmark) {
      return ok({ entry, readBackError: { code: 'NO_TARGET', message: 'The ledger entry has no record bookmark to re-open the page on.' } });
    }
    const opened = await this.pageService.openPage(pageId, { bookmark });
    if (isErr(opened)) return opened;
    const ctx = opened.value;
    try {
      // A bookmark BC cannot open (record deleted, wrong table) yields an
      // ownerless error dialog instead of the page (verified live, cronus29).
      if (ctx.isModal) {
        return ok({ entry, readBackError: { code: 'RECORD_NOT_OPENED', message: `Page ${pageId} did not open on the recorded record (bookmark ${bookmark}); it may have been deleted.` } });
      }
      // A deleted record does not error: BC opens the nearest record instead (live,
      // cronus29: a fully posted Sales Order's bookmark landed on the next order).
      const landed = ctx.forms.get(ctx.rootFormId)?.root.properties.bookmark;
      if (bookmark === target.page!.bookmark && landed !== undefined && landed !== bookmark) {
        return ok({ entry, readBackError: { code: 'RECORD_NOT_OPENED', message: `Page ${pageId} opened a different record (bookmark ${landed}) than the recorded one (${bookmark}); the recorded record no longer exists. A posting that fully ships and invoices a document deletes it.` } });
      }
      const section = buildSection(ctx, sectionId, sectionOpts);
      if (!section) {
        return ok({ entry, readBackError: { code: 'SECTION_NOT_FOUND', message: `Section '${sectionId}' is not on page ${pageId}.` } });
      }
      const readBack: ReadBack = { ...(company ? { company } : {}), pageId, bookmark, sectionId };
      if (targetRow) {
        const row = section.rows?.find(r => r.bookmark === targetRow.bookmark);
        readBack.row = row ? { bookmark: row.bookmark, cells: { ...row.cells } } : null;
      } else {
        const resolved = resolveSection(ctx, sectionId);
        const root = 'error' in resolved ? undefined : resolved.form.root;
        if (target.keyFields) {
          // Read the key back by table field number, not caption (captions can repeat or be personalized).
          const now = root ? readKeyFields(root) : [];
          readBack.keyFields = target.keyFields.map(k => {
            const n = now.find(f => f.fieldNo === k.fieldNo);
            return { fieldNo: k.fieldNo, caption: k.caption, value: n?.value ?? null, ...(n?.source ? { source: n.source } : {}) };
          });
          const diff = readBack.keyFields.filter((k, i) => k.value !== null && k.value !== target.keyFields![i]!.value);
          if (diff.length > 0) {
            return ok({ entry, readBack, readBackError: { code: 'KEY_MISMATCH', message: `Page ${pageId} opened a record whose primary key differs from the recorded one (${diff.map((k) => `${k.caption || `field ${k.fieldNo}`}: '${target.keyFields!.find(t => t.fieldNo === k.fieldNo)!.value}' -> '${k.value}'`).join(', ')}).` } });
          }
        }
        const written = target.args['fields'];
        const names = new Set([
          ...Object.keys(target.fields ?? {}),
          ...(written && typeof written === 'object' ? Object.keys(written) : []),
        ]);
        // Named fields are looked up in the whole form tree: a written field can be
        // hidden in a fresh (view-mode, collapsed) page and so be absent from section.fields.
        // Same name resolution as bc_write_data: caption case-insensitively, or controlPath.
        if (names.size > 0) readBack.fields = Object.fromEntries([...names].map(n => {
          const p = root && findField(root, n, recordedKeyBy)?.properties;
          return [(keyBy !== recordedKeyBy && p && (keyBy === 'designName' && p.designName || p.caption)) || n, p?.stringValue ?? null];
        }));
        else if (!target.keyFields?.some(k => !k.source)) readBack.fields = Object.fromEntries((section.fields ?? []).map(f => [f.name, f.value ?? null]));
        if (sectionId === 'header') {
          const linesId = [...ctx.sections.values()].find(s => s.kind === 'lines')?.sectionId;
          const rows = linesId ? buildSection(ctx, linesId, sectionOpts)?.rows : undefined;
          if (rows) readBack.lines = rows.map(r => ({ bookmark: r.bookmark, cells: { ...r.cells } }));
        }
      }
      return ok({ entry, readBack, evidenceHash: digestInput(readBack) });
    } finally {
      await this.pageService.closePage(ctx.pageContextId, { discardChanges: true }).catch(() => undefined);
    }
  }
}
