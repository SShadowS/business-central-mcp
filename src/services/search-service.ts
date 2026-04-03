import { ok, err, isErr, type Result } from '../core/result.js';
import { ProtocolError } from '../core/errors.js';
import type { BCSession } from '../session/bc-session.js';
import type { BCEvent, SessionActionInteraction, SaveValueInteraction } from '../protocol/types.js';
import type { Logger } from '../core/logger.js';

export interface SearchResult {
  name: string;
  pageId: string;
  type: string;
}

export class SearchService {
  constructor(
    private readonly session: BCSession,
    private readonly logger: Logger,
  ) {}

  async search(query: string): Promise<Result<SearchResult[], ProtocolError>> {
    // Step 1: Open Tell Me search via InvokeSessionAction
    const openSearch: SessionActionInteraction = {
      type: 'SessionAction',
      actionName: 'InvokeSessionAction',
      controlPath: 'server:c[0]',
      namedParameters: { sessionAction: 'InvokeTellMe' },
    };

    const openResult = await this.session.invoke(
      openSearch,
      (event) => event.type === 'InvokeCompleted' || event.type === 'FormCreated',
    );

    if (isErr(openResult)) return openResult;

    // Find the Tell Me form
    const tellMeForm = openResult.value.find(e => e.type === 'FormCreated');
    if (!tellMeForm || tellMeForm.type !== 'FormCreated') {
      return err(new ProtocolError('Tell Me search form did not open'));
    }

    const tellMeFormId = tellMeForm.formId;

    // Step 2: SaveValue with empty string (initialize)
    const initSave: SaveValueInteraction = {
      type: 'SaveValue',
      formId: tellMeFormId,
      controlPath: 'server:c[0]',
      newValue: '',
    };

    const initResult = await this.session.invoke(
      initSave,
      (event) => event.type === 'InvokeCompleted',
    );

    if (isErr(initResult)) return initResult;

    // Step 3: SaveValue with the actual query
    const querySave: SaveValueInteraction = {
      type: 'SaveValue',
      formId: tellMeFormId,
      controlPath: 'server:c[0]',
      newValue: query,
    };

    const queryResult = await this.session.invoke(
      querySave,
      (event) => event.type === 'DataLoaded' || event.type === 'InvokeCompleted',
    );

    if (isErr(queryResult)) return queryResult;

    // Extract search results from DataLoaded events
    const results = this.extractSearchResults(queryResult.value);

    this.logger.info(`Search "${query}": ${results.length} results`);
    return ok(results);
  }

  private extractSearchResults(events: BCEvent[]): SearchResult[] {
    const results: SearchResult[] = [];
    for (const event of events) {
      if (event.type !== 'DataLoaded') continue;
      for (const row of event.rows) {
        if (!row || typeof row !== 'object') continue;
        const r = row as Record<string, unknown>;
        const rowData = (r['DataRowInserted'] ?? r['DataRowUpdated']) as unknown[] | undefined;
        if (!Array.isArray(rowData) || rowData.length < 2) continue;
        const payload = rowData[1] as Record<string, unknown>;
        const cells = (payload['cells'] ?? payload['Cells'] ?? {}) as Record<string, unknown>;

        // Tell Me results have varying cell structures — extract what we can
        // Try to find name/description/page info from cell values
        const values = Object.values(cells).filter(v => typeof v === 'string') as string[];
        if (values.length > 0) {
          results.push({
            name: values[0] ?? '',
            pageId: '', // Page ID extraction needs refinement based on actual BC response
            type: values[1] ?? '',
          });
        }
      }
    }
    return results;
  }
}
