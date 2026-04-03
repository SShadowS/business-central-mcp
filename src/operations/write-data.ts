import { isOk, type Result } from '../core/result.js';
import type { ProtocolError } from '../core/errors.js';
import type { DataService, FieldWriteResult } from '../services/data-service.js';

export interface WriteDataInput {
  pageContextId: string;
  fields: Record<string, string>;
}

export interface WriteDataOutput {
  results: FieldWriteResult[];
  allSucceeded: boolean;
}

export class WriteDataOperation {
  constructor(private readonly dataService: DataService) {}

  async execute(input: WriteDataInput): Promise<Result<WriteDataOutput, ProtocolError>> {
    const result = await this.dataService.writeFields(input.pageContextId, input.fields);
    if (!isOk(result)) return result;
    return { ok: true, value: { results: result.value, allSucceeded: result.value.every(r => r.success) } };
  }
}
