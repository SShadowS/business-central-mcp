import type { BCEvent, FormCreatedEvent } from './types.js';
import { extractValidationErrors } from './mutation-result.js';
import { extractRows } from './form-state.js';
import { BusinessValidationError, BusinessError } from '../core/errors.js';

/**
 * Inspect a batch of BC events and return a typed business error if the
 * operation was rejected, or null when the events represent normal success.
 *
 * Precedence (highest to lowest):
 *   1. ValidationResults with Severity='Error' -> BusinessValidationError
 *   2. MessageToShow with messageType 'Error' or 'Fatal' -> BusinessError (source:'message')
 *   3. DialogOpened with MappingHint='ErrorDialog' -> BusinessError (source:'dialog')
 *   4. Page 700 "Error Messages" opened with an Error row -> BusinessError (source:'errorMessages')
 *
 * Pure function — no side effects, no live BC interaction.
 */
export function classifyBusinessError(
  events: BCEvent[],
): BusinessValidationError | BusinessError | null {
  // 1. Field-level validation errors (highest precedence)
  const allValidation = extractValidationErrors(events);
  const errorItems = allValidation.filter(item => item.Severity === 'Error');
  if (errorItems.length > 0) {
    const fieldErrors = errorItems.map(item => ({
      field: item.OriginatingControl?.controlPath,
      description: item.Description,
      descriptionShort: item.DescriptionShort,
    }));
    return new BusinessValidationError(fieldErrors);
  }

  // 2. MessageToShow with error/fatal severity
  for (const event of events) {
    if (event.type === 'MessageToShow') {
      const { messageType, text } = event;
      if (messageType === 'Error' || messageType === 'Fatal') {
        return new BusinessError({ bcText: text, severity: messageType, source: 'message' });
      }
    }
  }

  // 3. Error dialog (MappingHint='ErrorDialog')
  for (const event of events) {
    if (event.type === 'DialogOpened') {
      const ct = event.controlTree;
      if (ct === null || ct === undefined || typeof ct !== 'object') continue;
      const tree = ct as Record<string, unknown>;
      // Accept both PascalCase and lowercase keys (decoder normalises but be defensive)
      const hint = (tree['MappingHint'] ?? tree['mappingHint']) as string | undefined;
      if (hint !== 'ErrorDialog') continue;
      const message = (tree['Message'] ?? tree['message']) as string | undefined;
      const caption = (tree['Caption'] ?? tree['caption']) as string | undefined;
      const bcText =
        (typeof message === 'string' && message) ||
        (typeof caption === 'string' && caption) ||
        '(BC raised an error dialog with no message text)';
      return new BusinessError({ bcText, severity: 'Error', source: 'dialog' });
    }
  }

  // 4. Page 700 "Error Messages" (#53). Error Message Management collects posting errors
  //    and shows them as this non-modal page instead of an error dialog: Sales-Post's
  //    "There is nothing to post" after the post confirm arrives as FormToShow (CacheKey
  //    `700:embedded(False)`) plus a DataLoaded of its rows, in the same response
  //    (live cronus291, BC 29.1). Only rows whose Message Type (table 700 field 4, cell
  //    `*_c4`) is Error (ordinal 0) count: a warnings-only page does not mean failure.
  const errorText = errorMessagesPageText(events);
  if (errorText !== null) {
    return new BusinessError({ bcText: errorText, severity: 'Error', source: 'errorMessages' });
  }

  return null;
}

const ERROR_MESSAGES_PAGE_ID = 700;

function errorMessagesPageText(events: BCEvent[]): string | null {
  const formIds = new Set(events
    .filter((e): e is FormCreatedEvent => e.type === 'FormCreated'
      && ((e.controlTree as { Metadata?: { id?: unknown } } | undefined)?.Metadata?.id === ERROR_MESSAGES_PAGE_ID))
    .map(e => e.formId));
  if (formIds.size === 0) return null;

  const texts: string[] = [];
  for (const event of events) {
    if (event.type !== 'DataLoaded' || !formIds.has(event.formId)) continue;
    for (const row of extractRows(event.rows)) {
      const cells = row.cells as Record<string, Cell>;
      const isError = Object.entries(cells).some(([key, c]) => key.endsWith('_c4') && c.objectValue === 0);
      if (!isError) continue;
      // The message is the row's longest text cell (selection cells hold the option captions).
      const text = Object.values(cells)
        .filter(c => c.type !== 'selection' && typeof c.stringValue === 'string')
        .map(c => (c.stringValue as string).trim())
        .sort((a, b) => b.length - a.length)[0];
      if (text) texts.push(text);
    }
  }
  return texts.length > 0 ? texts.join('\n') : null;
}

type Cell = { type?: unknown; objectValue?: unknown; stringValue?: unknown };
