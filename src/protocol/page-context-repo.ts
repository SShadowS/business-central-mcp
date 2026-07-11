// src/protocol/page-context-repo.ts
//
// FACADE — composes PageContextStore (storage), PageEventRouter (routing),
// and FormStateReducer (state reduction) behind the original public API.
// All consumers depend only on this class; the three sub-units are internal.
//
// See CQRS split notes:
//   page-context-store.ts  — Maps + formId index
//   page-event-router.ts   — routing decisions (pure, no mutation)
//   form-state-reducer.ts  — FormState reduction (wraps FormProjection)
import type { BCEvent } from './types.js';
import type { PageContext } from './page-context.js';
import type { FormState } from './form-state.js';
import { SectionResolver, type SectionDescriptor } from './section-resolver.js';
import { buildFormTree } from './form-tree-builder.js';
import { isLogicalFormNode, type FormNode } from './form-node.js';
import { applyPropertyChange } from './form-tree-mutator.js';
import { PageContextStore } from './page-context-store.js';
import { PageEventRouter } from './page-event-router.js';
import { FormStateReducer } from './form-state-reducer.js';

/**
 * Descriptor for a child form discovered inside a parent form's control tree
 * (via fhc -> lf nodes). Used by `PageContextRepository.registerDiscoveredChildForm`
 * to create a separate FormState for the child form.
 */
export interface DiscoveredChildForm {
  readonly serverId: string;       // lf node's ServerId (used as formId)
  readonly caption: string;
  readonly controlTree: unknown;   // raw lf node, built into a FormState separately
  readonly isSubForm: boolean;     // true for lines subpages
  readonly isPart: boolean;        // true for factboxes and parts
}

/** Build a FormNode tree from a raw control tree, returning null if the input is absent or lacks the lf wrapper. */
function tryBuildFormTree(raw: unknown): FormNode | null {
  if (!raw || typeof raw !== 'object') return null;
  if ((raw as Record<string, unknown>).t !== 'lf') return null;
  return buildFormTree(raw); // any throw here = real bug, surface it
}

export class PageContextRepository {
  private readonly store = new PageContextStore();
  private readonly router = new PageEventRouter();
  private readonly reducer = new FormStateReducer();
  private readonly sectionResolver = new SectionResolver();

  get(pageContextId: string): PageContext | undefined {
    return this.store.get(pageContextId);
  }

  getByFormId(formId: string): PageContext | undefined {
    return this.store.getByFormId(formId);
  }

  create(
    pageContextId: string,
    rootFormId: string,
    options?: { isModal?: boolean; wizardState?: PageContext['wizardState'] },
  ): PageContext {
    const rootForm = this.reducer.createInitial(rootFormId);
    const headerSection = this.sectionResolver.createHeaderSection(rootFormId);

    const ctx: PageContext = {
      pageContextId,
      rootFormId,
      pageType: 'Unknown',
      caption: '',
      forms: new Map([[rootFormId, rootForm]]),
      sections: new Map([['header', headerSection]]),
      dialogs: [],
      ownedFormIds: [rootFormId],
      isModal: options?.isModal ?? false,
      wizardState: options?.wizardState ?? null,
      generation: 0,
    };

    this.store.set(pageContextId, ctx);
    this.store.indexFormId(rootFormId, pageContextId);
    return ctx;
  }

  /**
   * Mirror a NavigatePage step transition into the root form's groupVisibility
   * map. Hides every step participating in the wizard except the new active
   * one. Updates the page's wizardState pointer.
   *
   * BC's web client owns the step variable client-side and does not emit
   * PropertyChanged events when Next/Back is invoked — this method is the
   * authoritative source of step state on bc-mcp's side.
   */
  advanceWizardStep(pageContextId: string, newIndex: number): void {
    const page = this.store.get(pageContextId);
    if (!page || !page.wizardState) return;
    const ws = page.wizardState;
    if (newIndex < 0 || newIndex >= ws.stepPaths.length) return;
    if (newIndex === ws.currentStepIndex) return;

    const rootForm = page.forms.get(page.rootFormId);
    if (!rootForm) return;

    // Apply wizard step visibility directly to the tree: set visible=true on the
    // active step group and visible=false on all others.
    let newTreeRoot = rootForm.root;
    for (let i = 0; i < ws.stepPaths.length; i++) {
      newTreeRoot = applyPropertyChange(newTreeRoot, ws.stepPaths[i]!, { visible: i === newIndex });
    }

    const updatedRoot: FormState = { ...rootForm, root: newTreeRoot };
    const forms = new Map(page.forms);
    forms.set(page.rootFormId, updatedRoot);

    this.store.set(pageContextId, {
      ...page,
      forms,
      wizardState: { stepPaths: ws.stepPaths, currentStepIndex: newIndex },
      generation: page.generation + 1,
    });
  }

  applyEvents(events: BCEvent[]): void {
    // Track which pcIds were mutated so we can bump generation once per batch.
    const mutated = new Set<string>();
    for (const event of events) {
      const pcId = this.applyEvent(event);
      if (pcId !== undefined) mutated.add(pcId);
    }
    for (const pcId of mutated) this.bumpGeneration(pcId);
  }

  applyToPage(pageContextId: string, events: BCEvent[]): PageContext | undefined {
    let anyMutated = false;
    for (const event of events) {
      const pcId = this.applyEvent(event, pageContextId);
      if (pcId !== undefined) anyMutated = true;
    }
    if (anyMutated) this.bumpGeneration(pageContextId);
    return this.store.get(pageContextId);
  }

  /** Bump the generation counter on a page context by 1. */
  private bumpGeneration(pcId: string): void {
    const page = this.store.get(pcId);
    if (!page) return;
    this.store.set(pcId, { ...page, generation: page.generation + 1 });
  }

  /**
   * Apply a single event. Returns the pcId if the event mutated page state
   * (a new object was written to the store), or `undefined` for no-ops /
   * unmatched events. Callers use the return value to bump generation counters.
   */
  private applyEvent(event: BCEvent, targetPcId?: string): string | undefined {
    const decision = this.router.route(event, this.store, targetPcId);

    switch (decision.kind) {
      case 'Unmatched':
        return undefined;

      case 'AddChildForm':
        this.addChildForm(decision.pcId, event as BCEvent & { type: 'FormCreated' });
        return decision.pcId;

      case 'UpdateRootForm':
        this.applyRootControlTree(
          decision.pcId,
          (event as BCEvent & { type: 'FormCreated' }).formId,
          (event as BCEvent & { type: 'FormCreated' }).controlTree,
        );
        return decision.pcId;

      case 'FormClosed': {
        const changed = this.markFormClosed(decision.pcId, decision.formId);
        return changed ? decision.pcId : undefined;
      }

      case 'ModalRootLayout':
        this.applyRootControlTree(
          decision.pcId,
          decision.formId,
          (event as BCEvent & { type: 'DialogOpened' }).controlTree,
        );
        return decision.pcId;

      case 'AddDialog':
        this.addDialog(decision.pcId, event as BCEvent & { type: 'DialogOpened' });
        return decision.pcId;

      case 'ApplyToForm': {
        const page = this.store.get(decision.pcId);
        if (!page) return undefined;

        const form = page.forms.get(decision.formId);
        if (!form) return undefined;

        const updated = this.reducer.apply(form, event);

        // If the primary form didn't accept the event (no-op) and we have a
        // child repeater candidate, try routing to it.
        // BC sends lines data with the ROOT formId but the child repeater's controlPath.
        if (updated === form && decision.childRepeaterFormId) {
          const childForm = page.forms.get(decision.childRepeaterFormId);
          if (childForm) {
            const childUpdated = this.reducer.apply(childForm, event);
            if (childUpdated !== childForm) {
              const forms = new Map(page.forms);
              forms.set(childForm.formId, childUpdated);
              this.store.set(decision.pcId, { ...page, forms });
              return decision.pcId;
            }
          }
        }

        // Route PropertyChanged events to factbox forms when the controlPath
        // matches a factbox field. BC sends factbox data changes on the ROOT
        // formId. This fires regardless of whether the primary form accepted
        // the event (the factbox field path takes priority over root). Only
        // skipped if child-repeater already handled the event (early return above).
        // Verified from decompiled WebLogicalFormObserver.cs.
        if (decision.factboxFormId) {
          const factboxForm = page.forms.get(decision.factboxFormId);
          if (factboxForm) {
            const factboxUpdated = this.reducer.apply(factboxForm, event);
            if (factboxUpdated !== factboxForm) {
              const forms = new Map(page.forms);
              forms.set(factboxForm.formId, factboxUpdated);
              this.store.set(decision.pcId, { ...page, forms });
              return decision.pcId; // Don't also apply to root form
            }
          }
        }

        // Commit the primary result (may be unchanged if it was truly a no-op
        // and no child route matched). Only report mutation if the form actually changed.
        const forms = new Map(page.forms);
        forms.set(decision.formId, updated);
        this.store.set(decision.pcId, { ...page, forms });
        return updated !== form ? decision.pcId : undefined;
      }
    }
  }

  private addChildForm(pcId: string, event: BCEvent & { type: 'FormCreated' }): void {
    const page = this.store.get(pcId);
    if (!page) return;

    // Idempotent: a repeated FormCreated for a child already in this page
    // (factbox reload with LoadForm openForm:true, isReload FormToShow) must
    // update the tree in place — NOT reset its FormState (dropping loaded rows),
    // duplicate its section, or re-append it to ownedFormIds.
    const existingChild = page.forms.get(event.formId);
    if (existingChild) {
      const tree = tryBuildFormTree(event.controlTree);
      if (tree) {
        const forms = new Map(page.forms);
        forms.set(event.formId, { ...existingChild, root: tree });
        this.store.set(pcId, { ...page, forms });
      }
      return;
    }

    // Create FormState for child
    const childForm = this.reducer.createInitial(event.formId, event.parentFormId);
    const tree = tryBuildFormTree(event.controlTree) ?? childForm.root;
    const withData: FormState = {
      ...childForm,
      root: tree,
    };

    // Derive section. deriveSection re-parses the raw controlTree via
    // buildFormTree (unguarded), which throws on exactly the malformed inputs
    // tryBuildFormTree tolerates above. Fall back to a plain subpage so a bad
    // child tree can't abort the whole event batch mid-apply.
    let section: SectionDescriptor;
    try {
      section = this.sectionResolver.deriveSection(page, event.formId, event.controlTree);
    } catch {
      section = { sectionId: `subpage:${event.formId}`, kind: 'subpage', caption: 'Subpage', formId: event.formId, valid: true };
    }

    // Update PageContext
    const forms = new Map(page.forms);
    forms.set(event.formId, withData);

    const sections = new Map(page.sections);
    sections.set(section.sectionId, section);

    // Infer Document page type if we have a lines section
    let pageType = page.pageType;
    for (const s of sections.values()) {
      if (s.kind === 'lines') { pageType = 'Document'; break; }
    }

    this.store.set(pcId, {
      ...page,
      forms,
      sections,
      pageType,
      ownedFormIds: [...page.ownedFormIds, event.formId],
    });

    // Index the new formId AFTER creation
    this.store.indexFormId(event.formId, pcId);
  }

  /**
   * Apply a control tree as the page's root form layout. Shared between
   * `FormCreated` (regular pages) and `DialogOpened` (modal-rooted pages such
   * as wizards / request pages).
   */
  private applyRootControlTree(pcId: string, formId: string, controlTree: unknown): void {
    const page = this.store.get(pcId);
    if (!page) return;

    const existingForm = page.forms.get(formId);
    const base = existingForm ?? this.reducer.createInitial(formId);
    const tree = tryBuildFormTree(controlTree) ?? base.root;
    const updated: FormState = { ...base, root: tree };

    // Update pageType + caption from the new tree's root.
    const updatedPageType = isLogicalFormNode(tree) && tree.pageType !== 'Unknown' ? tree.pageType : page.pageType;
    const updatedCaption = isLogicalFormNode(tree) ? (tree.properties.caption || page.caption) : page.caption;

    const forms = new Map(page.forms);
    forms.set(formId, updated);

    this.store.set(pcId, {
      ...page,
      forms,
      pageType: updatedPageType,
      caption: updatedCaption,
    });
  }

  /** Mark a section as invalid (no longer surfaced via buildSection / buildAllSections). */
  invalidateSection(pageContextId: string, sectionId: string): void {
    const page = this.store.get(pageContextId);
    if (!page) return;
    const old = page.sections.get(sectionId);
    if (!old || !old.valid) return;
    const sections = new Map(page.sections);
    sections.set(sectionId, { ...old, valid: false });
    this.store.set(pageContextId, { ...page, sections });
  }

  private markFormClosed(pcId: string, formId: string): boolean {
    const page = this.store.get(pcId);
    if (!page) return false;

    // A child FormClosed must never tear down the page's own root form.
    const isRoot = formId === page.rootFormId;

    // Mark any sections that reference this formId as invalid.
    let changed = false;
    const sections = new Map(page.sections);
    for (const [sectionId, section] of sections) {
      if (section.formId === formId && section.valid) {
        sections.set(sectionId, { ...section, valid: false });
        changed = true;
      }
    }

    // For non-root forms, also drop the form itself so long-lived contexts
    // (Role Center) don't accumulate every dialog/child ever opened: remove it
    // from forms/dialogs/ownedFormIds and deindex the formId (which otherwise
    // reports closed dialogs as open and leaks the formId index forever).
    let forms = page.forms;
    let dialogs = page.dialogs;
    let ownedFormIds = page.ownedFormIds;
    if (!isRoot) {
      if (page.forms.has(formId)) {
        const nextForms = new Map(page.forms);
        nextForms.delete(formId);
        forms = nextForms;
        changed = true;
      }
      if (page.dialogs.some(d => d.formId === formId)) {
        dialogs = page.dialogs.filter(d => d.formId !== formId);
        changed = true;
      }
      if (page.ownedFormIds.includes(formId)) {
        ownedFormIds = page.ownedFormIds.filter(id => id !== formId);
        changed = true;
      }
      this.store.deindexFormId(formId);
    }

    if (!changed) return false;

    this.store.set(pcId, { ...page, sections, forms, dialogs, ownedFormIds });
    return true;
  }

  private addDialog(pcId: string, event: BCEvent & { type: 'DialogOpened' }): void {
    const page = this.store.get(pcId);
    if (!page) return;

    this.store.set(pcId, {
      ...page,
      dialogs: [...page.dialogs, { formId: event.formId, ownerFormId: event.ownerFormId, controlTree: event.controlTree }],
      ownedFormIds: [...page.ownedFormIds, event.formId],
    });

    this.store.indexFormId(event.formId, pcId);
  }

  /** Register a child form discovered from fhc/lf nodes in the control tree. */
  registerDiscoveredChildForm(pcId: string, child: DiscoveredChildForm): void {
    const page = this.store.get(pcId);
    if (!page) return;

    // Don't re-register if already known
    if (page.forms.has(child.serverId)) return;

    // Build the child form's state from the tree
    const tree = tryBuildFormTree(child.controlTree);
    const childForm: FormState = {
      ...this.reducer.createInitial(child.serverId, page.rootFormId),
      ...(tree ? { root: tree } : {}),
    };

    // Derive section: use IsSubForm to distinguish lines from factboxes
    const section = child.isSubForm
      ? this.sectionResolver.deriveSection(page, child.serverId, child.controlTree)
      : this.deriveFactboxSection(page, child);

    const forms = new Map(page.forms);
    forms.set(child.serverId, childForm);

    const sections = new Map(page.sections);
    sections.set(section.sectionId, section);

    let pageType = page.pageType;
    if (section.kind === 'lines') pageType = 'Document';

    this.store.set(pcId, {
      ...page,
      forms,
      sections,
      pageType,
      ownedFormIds: [...page.ownedFormIds, child.serverId],
    });

    this.store.indexFormId(child.serverId, pcId);
  }

  private deriveFactboxSection(page: PageContext, child: DiscoveredChildForm) {
    const caption = child.caption || 'FactBox';
    const base = `factbox:${caption}`;
    let sectionId = base;
    if (page.sections.has(sectionId)) {
      for (let i = 2; ; i++) {
        sectionId = `${base}#${i}`;
        if (!page.sections.has(sectionId)) break;
      }
    }
    return {
      sectionId,
      kind: 'factbox' as const,
      caption,
      formId: child.serverId,
      valid: true,
    };
  }

  /**
   * Directly seed repeater rows into a form's FormState.rows map.
   *
   * Used by LookupService to populate inline rows that BC delivers inside the
   * LookupFormReady control tree (rc.Data.Rows.LoadedRows) rather than via
   * separate DataLoaded events. The rows must already be in RepeaterRow format
   * (bookmark + cells with columnBinderName keys).
   *
   * No-op if the page context or form is not found, or if the repeater path
   * has no corresponding node in the form tree.
   */
  seedRepeaterRows(
    pageContextId: string,
    formId: string,
    repeaterPath: string,
    rows: ReadonlyArray<import('./types.js').RepeaterRow>,
  ): void {
    const page = this.store.get(pageContextId);
    if (!page) return;
    const form = page.forms.get(formId);
    if (!form) return;

    const newRowsMap = new Map(form.rows);
    newRowsMap.set(repeaterPath, rows);
    const updatedForm = { ...form, rows: newRowsMap };
    const forms = new Map(page.forms);
    forms.set(formId, updatedForm);
    this.store.set(pageContextId, { ...page, forms, generation: page.generation + 1 });
  }

  remove(pageContextId: string): void {
    this.store.removePage(pageContextId);
  }

  /** Remove all page contexts (e.g., after session recovery). */
  clearAll(): void {
    this.store.clear();
  }

  listPageContextIds(): string[] { return this.store.listPageContextIds(); }

  listPageContextSummaries(): Array<{ id: string; caption: string }> {
    return this.store.listPageContextSummaries();
  }

  get size(): number { return this.store.size; }
}
