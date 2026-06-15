import type { BCEvent } from './types.js';
import { extractValidationErrors } from './mutation-result.js';
import { BusinessValidationError, BusinessError } from '../core/errors.js';

/**
 * Inspect a batch of BC events and return a typed business error if the
 * operation was rejected, or null when the events represent normal success.
 *
 * Precedence (highest to lowest):
 *   1. ValidationResults with Severity='Error' -> BusinessValidationError
 *   2. MessageToShow with messageType 'Error' or 'Fatal' -> BusinessError (source:'message')
 *   3. DialogOpened with MappingHint='ErrorDialog' -> BusinessError (source:'dialog')
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

  return null;
}
