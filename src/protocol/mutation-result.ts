// src/protocol/mutation-result.ts
import type { BCEvent, DialogOpenedEvent } from './types.js';
import type { PageContext } from './page-context.js';

/**
 * Shared envelope returned by all mutating operations (write-data, execute-action,
 * navigate, close-page). Surfaces which sections changed, whether dialogs opened,
 * and whether the caller must respond to a dialog before continuing.
 */
export interface MutationResult<T = void> {
  readonly success: boolean;
  readonly value?: T;
  readonly changedSections: string[];
  readonly openedPages: Array<{ pageContextId: string; caption: string }>;
  readonly dialogsOpened: Array<{ formId: string; message?: string }>;
  readonly requiresDialogResponse: boolean;
}

/**
 * After a mutating invoke, check which sections received events by matching
 * event formIds to the section map. If the root formId was touched, all
 * sections are considered changed (root events cascade via cross-form routing).
 */
export function detectChangedSections(
  ctx: PageContext,
  events: BCEvent[],
): string[] {
  const changedFormIds = new Set<string>();
  for (const event of events) {
    const formId = 'formId' in event ? (event as { formId: string }).formId : undefined;
    if (formId) changedFormIds.add(formId);
  }

  const changedSections: string[] = [];
  for (const [sectionId, section] of ctx.sections) {
    if (changedFormIds.has(section.formId)) {
      changedSections.push(sectionId);
    }
  }

  // Root form events may cascade to lines via cross-form routing
  if (changedFormIds.has(ctx.rootFormId)) {
    for (const [sectionId] of ctx.sections) {
      if (!changedSections.includes(sectionId)) {
        changedSections.push(sectionId);
      }
    }
  }

  return changedSections;
}

/**
 * Extract dialog information from events. Tries to pull a human-readable
 * message from the dialog control tree (Caption or Message property).
 */
export function detectDialogs(events: BCEvent[]): Array<{ formId: string; message?: string }> {
  return events
    .filter((e): e is DialogOpenedEvent => e.type === 'DialogOpened')
    .map(e => {
      const tree = e.controlTree as Record<string, unknown> | undefined;
      const message = (tree?.Caption as string) || (tree?.Message as string) || undefined;
      return { formId: e.formId, message };
    });
}
