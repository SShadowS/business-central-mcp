// src/operations/lookup.ts
import type { Result } from '../core/result.js';
import type { ProtocolError } from '../core/errors.js';
import type { KeyByInput } from '../protocol/section-dto.js';
import { resolveKeyBy } from '../protocol/row-mapping.js';
import type { LookupService, LookupRow } from '../services/lookup-service.js';

export interface LookupInput extends Pick<KeyByInput, 'keyBy'> {
  pageContextId: string;
  field: string;
  search?: string;
  maxRows?: number;
}

export interface LookupOutput {
  rows: LookupRow[];
  totalFound: number;
}

export class LookupOperation {
  constructor(private readonly lookupService: LookupService) {}

  async execute(input: LookupInput): Promise<Result<LookupOutput, ProtocolError>> {
    return this.lookupService.lookup(input.pageContextId, input.field, {
      search: input.search,
      maxRows: input.maxRows,
      ...(resolveKeyBy(input.keyBy) === 'designName' ? { keyBy: 'designName' as const } : {}),
    });
  }
}
