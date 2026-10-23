import type { PageContextRepository } from '../protocol/page-context-repo.js';
import type { FilterNode, FormNode, LogicalFormNode } from '../protocol/form-node.js';
import { walkTree } from '../protocol/form-tree-walk.js';
import { primaryKeyFields } from '../protocol/form-views.js';
import { buildSection, sectionOptionsFrom } from '../protocol/section-dto.js';
import { resolveSection } from '../protocol/section-resolver.js';
import { decodeBookmark } from '../protocol/record-bookmark.js';

/**
 * What a mutating tool call was aimed at, snapshotted from the live page
 * context just before the call runs (epic #17, #23). Stored on the call's
 * operation-ledger entry so it outlives `PageContextRepository.clearAll()`
 * after session loss: the pageContextId dies with the session, but page id,
 * company, record caption and row cells are enough to find the record again
 * with a fresh read.
 */
export interface TargetDescriptor {
  capturedAt: string;
  company?: string;
  /** The tool input, minus file payloads and staleness guards. */
  args: Record<string, unknown>;
  /** `bookmark` is the root form's current record (card/document), from `PropertyChanged { Bookmark }` on `server:`. */
  page?: { pageContextId: string; pageId?: string; bookmark?: string; caption: string; pageType: string; isModal: boolean };
  section?: { sectionId: string; kind: string; caption: string };
  /** Targeted rows (bookmark/bookmarks/rowIndex, else BC's current row) with captioned cell values. */
  rows?: Array<{ bookmark: string; cells: Record<string, unknown> }>;
  /**
   * Card-shape sections: the record's primary key, from the form's
   * `Metadata.primaryKeyIds` joined to the controls' `TableFieldNo` (key order);
   * key fields without a control come from the record bookmark (`source: 'bookmark'`).
   */
  keyFields?: KeyField[];
  /** Card-shape fallback when the form is unbound or no key field has a control (key only from the bookmark): leading non-empty field values. */
  fields?: Record<string, string>;
  dialog?: { formId: string; message?: string };
}

/**
 * `source: 'bookmark'`: no control on the page; value decoded from the record bookmark.
 * Caption comes from the form's filter-control columns ('' when the form has none). An
 * Option stays its ordinal: BC sends option captions only on a control's `Items`, and this
 * field has no control, so nothing we receive names the option (live cronus29 page 42).
 */
export interface KeyField { fieldNo: number; caption: string; value: string; source?: 'bookmark' }

/**
 * A form's primary key in key order; [] for an unbound form. Fields with a
 * control read its value; the rest come from the form's record bookmark, which
 * is the serialized RecordId (see record-bookmark.ts), when it decodes to the
 * form's source table with exactly one value per key field.
 */
export function readKeyFields(root: FormNode): KeyField[] {
  const controls = primaryKeyFields(root);
  const meta = root.type === 'lf' ? (root as LogicalFormNode).metadata : undefined;
  const ids = meta?.primaryKeyIds ?? [];
  const bm = root.properties.bookmark;
  const decoded = bm && controls.length < ids.length ? decodeBookmark(bm) : undefined;
  const fromBookmark = decoded && decoded.tableNo === meta?.sourceTableId && decoded.values.length === ids.length ? decoded.values : undefined;
  // Field captions for control-less key fields: the form's filter control lists every
  // table field as `<sourceTableId>_<table name>.<fieldNo>` (live cronus29 Sales Order 42:
  // "36_Sales Header.1" = "Document Type"). The lines subpage's filc carries its own table's prefix.
  const columns = fromBookmark ? [...walkTree(root)].flatMap(n => (n.type === 'filc' ? (n as FilterNode).filterColumns ?? [] : [])) : [];
  const captionOf = (fieldNo: number) => {
    const id = new RegExp(`^${meta?.sourceTableId}_[^.]*\\.${fieldNo}$`);
    return columns.find(c => id.test(c.id))?.caption ?? '';
  };
  return ids.flatMap((fieldNo, i): KeyField[] => {
    const node = controls.find(c => c.fieldNo === fieldNo)?.node;
    if (node) return [{ fieldNo, caption: node.properties.caption ?? '', value: node.properties.stringValue ?? '' }];
    return fromBookmark ? [{ fieldNo, caption: captionOf(fieldNo), value: fromBookmark[i]!, source: 'bookmark' }] : [];
  });
}

const OMIT_ARGS = new Set(['base64', 'expectedStateVersion']);
// Fallback identity for unbound forms: the first N non-empty captioned fields (BC cards lead with No./Name).
const CARD_KEY_FIELDS = 5;

export type DescribeTarget = (input: unknown) => TargetDescriptor;

export function createTargetDescriber(repo: Pick<PageContextRepository, 'get'>, company: () => string | undefined): DescribeTarget {
  return (input) => {
    const raw = (input ?? {}) as Record<string, unknown>;
    const args = Object.fromEntries(Object.entries(raw).filter(([k]) => !OMIT_ARGS.has(k)));
    const out: TargetDescriptor = { capturedAt: new Date().toISOString(), args };
    const co = company();
    if (co) out.company = co;

    const pcId = typeof raw['pageContextId'] === 'string' ? raw['pageContextId'] : undefined;
    const ctx = pcId ? repo.get(pcId) : undefined;
    if (!pcId || !ctx) return out;

    // The page object id from the root form's wire Metadata, so pages opened by
    // drill-down / action / cue (session:page:action:...) are identified too.
    const root = ctx.forms.get(ctx.rootFormId)?.root;
    const metaId = root?.type === 'lf' ? (root as LogicalFormNode).metadata?.id : undefined;
    const pageId = metaId ? String(metaId) : /^session:page:(\d+):/.exec(pcId)?.[1];
    const bookmark = root?.properties.bookmark;
    out.page = { pageContextId: pcId, ...(pageId ? { pageId } : {}), ...(bookmark ? { bookmark } : {}), caption: ctx.caption, pageType: String(ctx.pageType), isModal: ctx.isModal };

    const section = buildSection(ctx, typeof raw['section'] === 'string' ? raw['section'] : 'header', sectionOptionsFrom(raw));
    if (section) {
      out.section = { sectionId: section.sectionId, kind: section.kind, caption: section.caption };
      const rows = section.rows ?? [];
      const wanted = Array.isArray(raw['bookmarks']) ? raw['bookmarks'] as string[]
        : typeof raw['bookmark'] === 'string' ? [raw['bookmark']] : undefined;
      // No explicit row: a row-scoped call runs against BC's current row
      // ({repeater}/cr), tracked from BookmarkChanged on the repeater node.
      const resolved = resolveSection(ctx, section.sectionId);
      const current = 'error' in resolved ? undefined : resolved.repeater?.properties.bookmark;
      const picked = wanted ? rows.filter(r => wanted.includes(r.bookmark))
        : typeof raw['rowIndex'] === 'number' ? (rows[raw['rowIndex']] ? [rows[raw['rowIndex']]!] : [])
          : rows.filter(r => r.bookmark === current);
      if (picked.length > 0) out.rows = picked.map(r => ({ bookmark: r.bookmark, cells: { ...r.cells } }));
      else {
        // Whole form tree: a key field can sit outside the first group or be hidden (Sales Order "No.").
        const keyFields = 'error' in resolved ? [] : readKeyFields(resolved.form.root);
        if (keyFields.length > 0) out.keyFields = keyFields;
        // A key decoded only from the bookmark is no evidence: bc_get_operation already
        // checks the landed bookmark, so keep the leading fields as the record's state.
        if (!keyFields.some(k => !k.source)) {
          const leading = (section.fields ?? []).filter(f => f.value).slice(0, CARD_KEY_FIELDS);
          if (leading.length > 0) out.fields = Object.fromEntries(leading.map(f => [f.name, f.value!]));
        }
      }
    }

    const dialogId = typeof raw['dialogFormId'] === 'string' ? raw['dialogFormId'] : typeof raw['formId'] === 'string' ? raw['formId'] : undefined;
    const dialog = dialogId ? ctx.dialogs.find(d => d.formId === dialogId) : undefined;
    if (dialog) {
      const tree = dialog.controlTree as Record<string, unknown> | undefined;
      const message = (tree?.['Caption'] as string) || (tree?.['Message'] as string) || undefined;
      out.dialog = { formId: dialog.formId, ...(message ? { message } : {}) };
    }
    return out;
  };
}
