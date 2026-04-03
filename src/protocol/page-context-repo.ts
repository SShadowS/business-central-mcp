// src/protocol/page-context-repo.ts
import type { BCEvent } from './types.js';
import type { PageContext } from './page-context.js';
import type { FormState } from './form-state.js';
import { FormProjection } from './form-state.js';
import { SectionResolver } from './section-resolver.js';
import { parseControlTree } from './control-tree-parser.js';
import type { DiscoveredChildForm } from './control-tree-parser.js';

export class PageContextRepository {
  private readonly pages = new Map<string, PageContext>();
  private readonly formIdIndex = new Map<string, string>();  // formId -> pageContextId
  private readonly formProjection = new FormProjection();
  private readonly sectionResolver = new SectionResolver();

  get(pageContextId: string): PageContext | undefined {
    return this.pages.get(pageContextId);
  }

  getByFormId(formId: string): PageContext | undefined {
    const id = this.formIdIndex.get(formId);
    return id ? this.pages.get(id) : undefined;
  }

  create(pageContextId: string, rootFormId: string): PageContext {
    const rootForm = this.formProjection.createInitial(rootFormId);
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
    };

    this.pages.set(pageContextId, ctx);
    this.formIdIndex.set(rootFormId, pageContextId);
    return ctx;
  }

  applyEvents(events: BCEvent[]): void {
    for (const event of events) {
      this.applyEvent(event);
    }
  }

  applyToPage(pageContextId: string, events: BCEvent[]): PageContext | undefined {
    for (const event of events) {
      this.applyEvent(event, pageContextId);
    }
    return this.pages.get(pageContextId);
  }

  private applyEvent(event: BCEvent, targetPcId?: string): void {
    const formId = 'formId' in event ? (event as { formId: string }).formId : undefined;
    if (!formId) return;

    // New child form: route by parentFormId (not indexed yet)
    if (event.type === 'FormCreated' && event.parentFormId) {
      const parentPcId = targetPcId ?? this.formIdIndex.get(event.parentFormId);
      if (parentPcId) {
        this.addChildForm(parentPcId, event);
      }
      return;
    }

    // FormCreated for root form (no parentFormId): update existing form
    if (event.type === 'FormCreated' && !event.parentFormId) {
      const pcId = targetPcId ?? this.formIdIndex.get(formId);
      if (pcId) {
        this.updateRootForm(pcId, event);
      }
      return;
    }

    // FormClosed: mark sections referencing this form as invalid
    if (event.type === 'FormClosed') {
      const pcId = targetPcId ?? this.formIdIndex.get(formId);
      if (pcId) {
        this.markFormClosed(pcId, formId);
      }
      return;
    }

    // Dialog: route by ownerFormId
    if (event.type === 'DialogOpened' && event.ownerFormId) {
      const ownerPcId = targetPcId ?? this.formIdIndex.get(event.ownerFormId);
      if (ownerPcId) {
        this.addDialog(ownerPcId, event);
      }
      return;
    }

    // All other events: route by formId
    const pcId = targetPcId ?? this.formIdIndex.get(formId);
    if (!pcId) return;

    const page = this.pages.get(pcId);
    if (!page) return;

    const form = page.forms.get(formId);
    if (form) {
      const updated = this.formProjection.apply(form, event);

      // Check if the event was actually applied (repeater matched).
      // If not, and this is a DataLoaded/PropertyChanged/BookmarkChanged with a controlPath,
      // try routing to a child form whose repeater matches that controlPath.
      // BC sends lines data with the ROOT formId but a controlPath matching the child repeater.
      const controlPath = 'controlPath' in event ? (event as { controlPath: string }).controlPath : undefined;
      if (controlPath && updated === form) {
        const childForm = this.findChildFormByRepeaterPath(page, formId, controlPath);
        if (childForm) {
          const childUpdated = this.formProjection.apply(childForm, event);
          if (childUpdated !== childForm) {
            const forms = new Map(page.forms);
            forms.set(childForm.formId, childUpdated);
            this.pages.set(pcId, { ...page, forms });
            return;
          }
        }
      }

      const forms = new Map(page.forms);
      forms.set(formId, updated);
      this.pages.set(pcId, { ...page, forms });
    }
  }

  private addChildForm(pcId: string, event: BCEvent & { type: 'FormCreated' }): void {
    const page = this.pages.get(pcId);
    if (!page) return;

    // Create FormState for child
    const childForm = this.formProjection.createInitial(event.formId, event.parentFormId);
    // Parse control tree to populate fields/repeaters/actions
    const parsed = parseControlTree(event.controlTree);
    const withData: FormState = {
      ...childForm,
      controlTree: parsed.fields,
      tabs: parsed.tabs,
      repeaters: parsed.repeaters,
      actions: parsed.actions,
      filterControlPath: parsed.filterControlPath,
    };

    // Derive section
    const section = this.sectionResolver.deriveSection(page, event.formId, event.controlTree);

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

    this.pages.set(pcId, {
      ...page,
      forms,
      sections,
      pageType,
      ownedFormIds: [...page.ownedFormIds, event.formId],
    });

    // Index the new formId AFTER creation
    this.formIdIndex.set(event.formId, pcId);
  }

  private updateRootForm(pcId: string, event: BCEvent & { type: 'FormCreated' }): void {
    const page = this.pages.get(pcId);
    if (!page) return;

    const parsed = parseControlTree(event.controlTree);
    const existingForm = page.forms.get(event.formId);
    const updated: FormState = {
      ...(existingForm ?? this.formProjection.createInitial(event.formId)),
      controlTree: parsed.fields.length > 0 ? parsed.fields : (existingForm?.controlTree ?? []),
      tabs: parsed.tabs ?? existingForm?.tabs,
      repeaters: parsed.repeaters.size > 0 ? parsed.repeaters : (existingForm?.repeaters ?? new Map()),
      actions: parsed.actions.length > 0 ? parsed.actions : (existingForm?.actions ?? []),
      filterControlPath: parsed.filterControlPath ?? existingForm?.filterControlPath ?? null,
    };

    const forms = new Map(page.forms);
    forms.set(event.formId, updated);

    this.pages.set(pcId, {
      ...page,
      forms,
      pageType: parsed.pageType !== 'Unknown' ? parsed.pageType : page.pageType,
      caption: parsed.caption || page.caption,
    });
  }

  private markFormClosed(pcId: string, formId: string): void {
    const page = this.pages.get(pcId);
    if (!page) return;

    // Mark any sections that reference this formId as invalid
    let changed = false;
    const sections = new Map(page.sections);
    for (const [sectionId, section] of sections) {
      if (section.formId === formId && section.valid) {
        sections.set(sectionId, { ...section, valid: false });
        changed = true;
      }
    }
    if (!changed) return;

    this.pages.set(pcId, { ...page, sections });
  }

  private addDialog(pcId: string, event: BCEvent & { type: 'DialogOpened' }): void {
    const page = this.pages.get(pcId);
    if (!page) return;

    this.pages.set(pcId, {
      ...page,
      dialogs: [...page.dialogs, { formId: event.formId, ownerFormId: event.ownerFormId, controlTree: event.controlTree }],
      ownedFormIds: [...page.ownedFormIds, event.formId],
    });

    this.formIdIndex.set(event.formId, pcId);
  }

  /** Find a child form (not rootFormId) that has a repeater at the given controlPath. */
  private findChildFormByRepeaterPath(page: PageContext, excludeFormId: string, controlPath: string): FormState | undefined {
    for (const [fId, form] of page.forms) {
      if (fId === excludeFormId) continue;
      if (form.repeaters.has(controlPath)) return form;
    }
    return undefined;
  }

  /** Register a child form discovered from fhc/lf nodes in the control tree. */
  registerDiscoveredChildForm(pcId: string, child: DiscoveredChildForm): void {
    const page = this.pages.get(pcId);
    if (!page) return;

    // Don't re-register if already known
    if (page.forms.has(child.serverId)) return;

    // Parse the child form's control tree
    const parsed = parseControlTree(child.controlTree);
    const childForm: FormState = {
      ...this.formProjection.createInitial(child.serverId, page.rootFormId),
      controlTree: parsed.fields,
      tabs: parsed.tabs,
      repeaters: parsed.repeaters,
      actions: parsed.actions,
      filterControlPath: parsed.filterControlPath,
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

    this.pages.set(pcId, {
      ...page,
      forms,
      sections,
      pageType,
      ownedFormIds: [...page.ownedFormIds, child.serverId],
    });

    this.formIdIndex.set(child.serverId, pcId);
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

  remove(pageContextId: string): void {
    const page = this.pages.get(pageContextId);
    if (page) {
      for (const fId of page.ownedFormIds) this.formIdIndex.delete(fId);
    }
    this.pages.delete(pageContextId);
  }

  /** Remove all page contexts (e.g., after session recovery). */
  clearAll(): void {
    this.pages.clear();
    this.formIdIndex.clear();
  }

  listPageContextIds(): string[] { return Array.from(this.pages.keys()); }
  get size(): number { return this.pages.size; }
}
