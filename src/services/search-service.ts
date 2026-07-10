import { ok, err, isErr, type Result } from '../core/result.js';
import { ProtocolError } from '../core/errors.js';
import type { BCSession } from '../session/bc-session.js';
import type { SessionActionInteraction, SaveValueInteraction } from '../protocol/types.js';
import type { Logger } from '../core/logger.js';
import { extractTellMeResults } from './tell-me-extractor.js';

export interface SearchResult {
  /** Display name of the page/report/etc. -- what the BC web client shows. */
  name: string;
  /** Object kind: 'page' | 'report' | 'codeunit' | etc. Lowercase per BC's wire format. */
  objectType: string;
  /** AL object name BC uses to run the target. Pass to OpenForm or its equivalent. */
  runTarget: string;
  /** Department path (e.g. "Departments/Financial Management/Receivables"). Optional. */
  departmentPath?: string;
  /** Category label ("Lists", "Tasks", "Reports", ...). Optional. */
  category?: string;
  /** Search relevance score from BC. Higher = better match. Optional. */
  score?: number;
}

export class SearchService {
  constructor(
    private readonly session: BCSession,
    private readonly logger: Logger,
  ) {}

  async search(query: string): Promise<Result<SearchResult[], ProtocolError>> {
    // Step 1: Open Tell Me search via InvokeSessionAction with SystemAction 220 (PageSearch)
    const openSearch: SessionActionInteraction = {
      type: 'SessionAction',
      actionName: 'InvokeSessionAction',
      namedParameters: { SystemAction: 220 },
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

    // SaveValue against the actual sc input at server:c[0]/c[0], NOT the gc
    // container at server:c[0]. Verified via live capture (BC28): only the
    // nested path triggers the DataLoaded result stream. The root cause of
    // limits.md #5's empty-result symptom on certain envs.

    // Step 2: SaveValue with empty string (initialize)
    const initSave: SaveValueInteraction = {
      type: 'SaveValue',
      formId: tellMeFormId,
      controlPath: 'server:c[0]/c[0]',
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
      controlPath: 'server:c[0]/c[0]',
      newValue: query,
    };

    const queryResult = await this.session.invoke(
      querySave,
      (event) => event.type === 'DataLoaded' || event.type === 'InvokeCompleted',
    );

    if (isErr(queryResult)) return queryResult;

    // Extract search results from DataLoaded events
    const results = extractTellMeResults(queryResult.value);

    // Close the Tell Me form so it doesn't leak server-side and accumulate in
    // the session's openFormIds (serialized into every later request). Best
    // effort — a failed close must not fail the search.
    const closeResult = await this.session.invoke(
      { type: 'CloseForm' as const, formId: tellMeFormId },
      (event) => event.type === 'InvokeCompleted',
    );
    if (isErr(closeResult)) {
      this.logger.warn(`Failed to close Tell Me form ${tellMeFormId}: ${closeResult.error.message}`);
    }
    this.session.removeOpenForm(tellMeFormId);

    this.logger.info(`Search "${query}": ${results.length} results`);
    return ok(results);
  }
}
