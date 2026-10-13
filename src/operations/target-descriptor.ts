import type { PageContextRepository } from '../protocol/page-context-repo.js';
import type { FormNode, LogicalFormNode } from '../protocol/form-node.js';
import { primaryKeyFields } from '../protocol/form-views.js';
import { buildSection } from '../protocol/section-dto.js';
import { resolveSection } from '../protocol/section-resolver.js';

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
   * `Metadata.primaryKeyIds` joined to the controls' `TableFieldNo` (key order;
   * key fields without a control on the page are absent).
   */
  keyFields?: KeyField[];
  /** Card-shape fallback when the form is unbound or no key field has a control: leading non-empty field values. */
  fields?: Record<string, string>;
  dialog?: { formId: string; message?: string };
}

export interface KeyField { fieldNo: number; caption: string; value: string }

/** A form's primary-key controls with their current values; [] for an unbound form. */
export function readKeyFields(root: FormNode): KeyField[] {
  return primaryKeyFields(root).map(({ fieldNo, node }) => ({ fieldNo, caption: node.properties.caption ?? '', value: node.properties.stringValue ?? '' }));
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

    const section = buildSection(ctx, typeof raw['section'] === 'string' ? raw['section'] : 'header');
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
        else {
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
