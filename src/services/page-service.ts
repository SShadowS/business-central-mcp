import { v4 as uuid } from 'uuid';
import { ok, err, isOk, type Result } from '../core/result.js';
import { ProtocolError } from '../core/errors.js';
import type { BCSession } from '../session/bc-session.js';
import type { PageContextRepository } from '../protocol/page-context-repo.js';
import type {
  PageState, BCEvent, OpenFormInteraction, LoadFormInteraction, CloseFormInteraction,
} from '../protocol/types.js';
import type { Logger } from '../core/logger.js';

export class PageService {
  constructor(
    private readonly session: BCSession,
    private readonly repo: PageContextRepository,
    private readonly logger: Logger,
  ) {}

  async openPage(pageId: string, options?: { bookmark?: string; tenantId?: string }): Promise<Result<PageState, ProtocolError>> {
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

    // Load data for child forms (list pages need LoadForm with loadData)
    await this.loadChildFormData(pageContextId, events);

    const finalState = this.repo.get(pageContextId);
    if (!finalState) {
      return err(new ProtocolError(`Failed to create page context for page ${pageId}`));
    }

    this.logger.info(`Page opened: ${pageId} (${pageContextId}, formId: ${formId})`);
    return ok(finalState);
  }

  private async loadChildFormData(pageContextId: string, openEvents: BCEvent[]): Promise<void> {
    const state = this.repo.get(pageContextId);
    if (!state) return;

    // Find child forms from FormCreated events (forms that aren't the main form)
    const childForms = openEvents
      .filter(e => e.type === 'FormCreated' && e.formId !== state.formId)
      .map(e => e.type === 'FormCreated' ? e.formId : '')
      .filter(id => id !== '');

    for (const childFormId of childForms) {
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
    }
  }

  async closePage(pageContextId: string): Promise<Result<void, ProtocolError>> {
    const state = this.repo.get(pageContextId);
    if (!state) return err(new ProtocolError(`Page context not found: ${pageContextId}`));

    for (const formId of state.openFormIds) {
      const closeInteraction: CloseFormInteraction = { type: 'CloseForm', formId };
      await this.session.invoke(closeInteraction, (event) => event.type === 'InvokeCompleted');
      this.session.removeOpenForm(formId);
    }

    this.repo.remove(pageContextId);
    this.logger.info(`Page closed: ${pageContextId}`);
    return ok(undefined);
  }

  getPageState(pageContextId: string): PageState | undefined {
    return this.repo.get(pageContextId);
  }
}
