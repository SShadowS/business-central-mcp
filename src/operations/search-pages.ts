import { isOk, type Result } from '../core/result.js';
import type { ProtocolError } from '../core/errors.js';
import type { SearchService, SearchResult } from '../services/search-service.js';

export interface SearchPagesInput {
  query: string;
}

export class SearchPagesOperation {
  constructor(private readonly searchService: SearchService) {}

  async execute(input: SearchPagesInput): Promise<Result<{ results: SearchResult[] }, ProtocolError>> {
    const result = await this.searchService.search(input.query);
    if (!isOk(result)) return result;
    return { ok: true, value: { results: result.value } };
  }
}
