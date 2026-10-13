import { expect } from 'vitest';
import { isErr } from '../../../src/core/result.js';
import type { DataService, FieldWriteResult } from '../../../src/services/data-service.js';

/**
 * Assert a restore write landed. BC echoes a SaveValue only when the stored value
 * CHANGED (decompiled LogicalControlObserver.BeforeGetChanges compares to its cache),
 * so a restore is proven by its echo, or by the control already holding the original
 * (the test write never landed). A silent no-op (non-editable control,
 * SaveValueInteraction.InvokeCore returns early) fails here instead of leaving the
 * test value in the record.
 */
export function expectRestored(result: FieldWriteResult | undefined, original: string): void {
  expect(result, 'restore produced no write result').toBeDefined();
  expect(
    result!.echoed === true || result!.newValue === original,
    `restore of "${result!.fieldName}" to "${original}" was not echoed by BC (control holds "${result!.newValue}")`,
  ).toBe(true);
}

/** Write `original` back through DataService and assert it landed (see expectRestored). */
export async function restoreField(
  dataService: DataService,
  pageContextId: string,
  fieldName: string,
  original: string,
  options?: { sectionId?: string; bookmark?: string; rowIndex?: number },
): Promise<void> {
  const r = await dataService.writeField(pageContextId, fieldName, original, options);
  if (isErr(r)) throw new Error(`restore of "${fieldName}" to "${original}" failed: ${r.error.message}`);
  expectRestored(r.value, original);
}
