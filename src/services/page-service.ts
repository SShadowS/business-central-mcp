import { v4 as uuid } from 'uuid';
import { ok, err, isOk, type Result } from '../core/result.js';
import { ProtocolError } from '../core/errors.js';
import type { BCSession } from '../session/bc-session.js';
import type { PageContextRepository } from '../protocol/page-context-repo.js';
import type { PageContext } from '../protocol/page-context.js';
import type {
  BCEvent, OpenFormInteraction, LoadFormInteraction, CloseFormInteraction, InvokeActionInteraction,
} from '../protocol/types.js';
import { parseControlTree } from '../protocol/control-tree-parser.js';
// DiscoveredChildForm is used by repo.registerDiscoveredChildForm, not directly here
import type { Logger } from '../core/logger.js';

export interface ClosePageResult {
  events: BCEvent[];
}

export class PageService {
  constructor(
    private readonly session: BCSession,
    private readonly repo: PageContextRepository,
    private readonly logger: Logger,
  ) {}

  async openPage(pageId: string, options?: { bookmark?: string; tenantId?: string }): Promise<Result<PageContext, ProtocolError>> {
    const tenantId = options?.tenantId ?? 'default';
    let query = `page=${pageId}&tenant=${tenantId}`;
    if (options?.bookmark) {
      query += `&bookmark=${encodeURIComponent(options.bookmark)}`;
    }

    const interaction: OpenFormInteraction = {
      type: 'OpenForm',
      query,
      controlPath: 'server:c[0]',
    };

    const result = await this.session.invoke(
      interaction,
      (event) => event.type === 'InvokeCompleted',
    );

    if (!isOk(result)) return result;

    const events = result.value;
    const pageContextId = `session:page:${pageId}:${uuid().substring(0, 8)}`;

    // Find the FormCreated event to get the main formId
    const formCreated = events.find(e => e.type === 'FormCreated');
    const formId = formCreated?.type === 'FormCreated' ? formCreated.formId : '';

    if (!formId) {
      this.logger.warn(`No FormCreated event for page ${pageId}. Events: ${events.map(e => e.type).join(', ')}`);
    }

    // Create page context and apply all events
    this.repo.create(pageContextId, formId);
    this.repo.applyToPage(pageContextId, events);

    // Discover child forms embedded in the root form's control tree (fhc -> lf nodes)
    await this.discoverAndLoadChildForms(pageContextId, events);

    const finalState = this.repo.get(pageContextId);
    if (!finalState) {
      return err(new ProtocolError(`Failed to create page context for page ${pageId}`));
    }

    this.logger.info(`Page opened: ${pageId} (${pageContextId}, formId: ${formId})`);
    return ok(finalState);
  }

  private async discoverAndLoadChildForms(pageContextId: string, openEvents: BCEvent[]): Promise<void> {
    const ctx = this.repo.get(pageContextId);
    if (!ctx) return;

    // Collect child form IDs to load data for
    const childFormIds: string[] = [];

    // Source 1: Child forms from separate FormCreated events (rare, but possible)
    for (const e of openEvents) {
      if (e.type === 'FormCreated' && e.formId !== ctx.rootFormId) {
        childFormIds.push(e.formId);
      }
    }

    // Source 2: Child forms embedded in root form's control tree as fhc -> lf nodes
    const rootFormCreated = openEvents.find(e => e.type === 'FormCreated' && e.formId === ctx.rootFormId);
    if (rootFormCreated?.type === 'FormCreated') {
      const parsed = parseControlTree(rootFormCreated.controlTree);
      for (const child of parsed.childForms) {
        this.repo.registerDiscoveredChildForm(pageContextId, child);
        childFormIds.push(child.serverId);
        this.logger.debug('page', `Discovered child form: ${child.serverId} (${child.caption}, subform=${child.isSubForm}, part=${child.isPart})`);
      }
    }

    // Load data for all child forms (only lines subpage and key parts, skip most factboxes)
    const updatedCtx = this.repo.get(pageContextId);
    if (!updatedCtx) return;

    for (const childFormId of childFormIds) {
      // Only load data for forms that are sections we care about (lines subpage)
      const section = Array.from(updatedCtx.sections.values()).find(s => s.formId === childFormId);
      if (!section) continue;
      if (section.kind === 'factbox') continue;

      // Step 1: LoadForm to initialize the child form on the server
      const loadInteraction: LoadFormInteraction = {
        type: 'LoadForm',
        formId: childFormId,
        loadData: true,
        delayed: false,
      };

      const loadResult = await this.session.invoke(
        loadInteraction,
        (event) => event.type === 'InvokeCompleted' || event.type === 'DataLoaded',
      );

      if (isOk(loadResult)) {
        this.repo.applyToPage(pageContextId, loadResult.value);
      }

      // Step 2: Refresh the child form's repeater to trigger DataLoaded.
      // BC sends lines data as DataLoaded on the ROOT formId with the child's controlPath.
      // LoadForm alone doesn't trigger DataLoaded for subpage repeaters.
      if (section.repeaterControlPath) {
        const refreshInteraction: InvokeActionInteraction = {
          type: 'InvokeAction',
          formId: childFormId,
          controlPath: section.repeaterControlPath,
          systemAction: 30, // SystemAction.Refresh
        };

        const refreshResult = await this.session.invoke(
          refreshInteraction,
          (event) => event.type === 'InvokeCompleted' || event.type === 'DataLoaded',
        );

        if (isOk(refreshResult)) {
          this.repo.applyToPage(pageContextId, refreshResult.value);
        }
      }
    }
  }

  async closePage(pageContextId: string): Promise<Result<ClosePageResult, ProtocolError>> {
    const ctx = this.repo.get(pageContextId);
    if (!ctx) return err(new ProtocolError(`Page context not found: ${pageContextId}`));

    const allEvents: BCEvent[] = [];
    for (const formId of ctx.ownedFormIds) {
      const closeInteraction: CloseFormInteraction = { type: 'CloseForm', formId };
      const result = await this.session.invoke(closeInteraction, (event) => event.type === 'InvokeCompleted');
      if (isOk(result)) {
        allEvents.push(...result.value);
      }
      this.session.removeOpenForm(formId);
    }

    this.repo.remove(pageContextId);
    this.logger.info(`Page closed: ${pageContextId}`);
    return ok({ events: allEvents });
  }

  getPageContext(pageContextId: string): PageContext | undefined {
    return this.repo.get(pageContextId);
  }
}
