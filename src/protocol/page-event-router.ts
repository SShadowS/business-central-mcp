// src/protocol/page-event-router.ts
//
// Pure routing layer: given a BCEvent and the current store state, decides
// WHAT should happen and WHERE (which pcId / which formId to target). Returns
// a typed routing decision — does NOT mutate any state.
//
// The routing quirks preserved here are all verified against live BC:
//   - Child-form repeater path matching (lines data arrives on root formId)
//   - Modal-rooted page detection (DialogOpened with formId === page.rootFormId)
//   - Factbox field-path routing (PropertyChanged on root formId but factbox controlPath)
//
// Reference: WebLogicalFormObserver.cs, UISession.openedForms (decompiled)

import type { BCEvent } from './types.js';
import type { PageContext } from './page-context.js';
import type { FormState } from './form-state.js';
import {
  fields as treeFields, repeaters as treeRepeaters,
} from './form-views.js';
import type { PageContextStore } from './page-context-store.js';

// ---------------------------------------------------------------------------
// Routing decision types
// ---------------------------------------------------------------------------

/** FormCreated with a parentFormId — add it as a child of an existing page. */
export interface RouteAddChildForm {
  readonly kind: 'AddChildForm';
  readonly pcId: string;
}

/** FormCreated with no parentFormId — refresh the root form's control tree. */
export interface RouteUpdateRootForm {
  readonly kind: 'UpdateRootForm';
  readonly pcId: string;
}

/** FormClosed — invalidate sections that reference this formId. */
export interface RouteFormClosed {
  readonly kind: 'FormClosed';
  readonly pcId: string;
  readonly formId: string;
}

/**
 * DialogOpened where the dialog's formId IS the page's rootFormId.
 * The dialog control tree becomes the page's root layout (modal-rooted pages:
 * wizards, request pages). Verified from BC28 NavigatePage/RequestPage behavior.
 */
export interface RouteModalRootLayout {
  readonly kind: 'ModalRootLayout';
  readonly pcId: string;
  readonly formId: string;
}

/** DialogOpened for a regular child dialog overlaid on an existing page. */
export interface RouteAddDialog {
  readonly kind: 'AddDialog';
  readonly pcId: string;
}

/**
 * Data/property event (DataLoaded, PropertyChanged, BookmarkChanged, etc.).
 * The primary target is `formId`. When `childRepeaterFormId` is set, the
 * facade should first try to apply the event to `formId`; if the result is
 * unchanged (no-op), it falls back to `childRepeaterFormId`. When
 * `factboxFormId` is set the facade similarly tries it if the primary is a
 * no-op, but ONLY for PropertyChanged on the root form.
 *
 * This layered fallback mirrors the original applyEvent logic precisely:
 *   1. Apply to primary form.
 *   2. If no-op and childRepeaterFormId present → try child repeater.
 *   3. If no-op on primary and factboxFormId present → try factbox (for
 *      PropertyChanged where formId === rootFormId only).
 *   4. Otherwise commit the (possibly unchanged) primary result.
 *
 * Reference: page-context-repo.ts lines 185-226 (original applyEvent body)
 */
export interface RouteApplyToForm {
  readonly kind: 'ApplyToForm';
  readonly pcId: string;
  readonly formId: string;
  /** Child form that owns a repeater matching the event's controlPath (if any). */
  readonly childRepeaterFormId?: string;
  /** Factbox form that owns a field matching the event's controlPath (if any). */
  readonly factboxFormId?: string;
}

/** Event cannot be routed (no matching page context). */
export interface RouteUnmatched {
  readonly kind: 'Unmatched';
}

export type RoutingDecision =
  | RouteAddChildForm
  | RouteUpdateRootForm
  | RouteFormClosed
  | RouteModalRootLayout
  | RouteAddDialog
  | RouteApplyToForm
  | RouteUnmatched;

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export class PageEventRouter {
  /**
   * Decide how to handle `event` given current store state and an optional
   * caller-supplied `targetPcId` hint (used by `applyToPage`).
   *
   * This method is pure — it reads from the store but never writes.
   */
  route(
    event: BCEvent,
    store: PageContextStore,
    targetPcId?: string,
  ): RoutingDecision {
    const formId = 'formId' in event ? (event as { formId: string }).formId : undefined;
    if (!formId) return { kind: 'Unmatched' };

    // -----------------------------------------------------------------------
    // FormCreated — child form (has parentFormId, not yet in index)
    // -----------------------------------------------------------------------
    if (event.type === 'FormCreated' && event.parentFormId) {
      const pcId = targetPcId ?? store.lookupPcId(event.parentFormId);
      if (!pcId) return { kind: 'Unmatched' };
      // With a caller-supplied hint (applyToPage replays a whole event batch
      // onto a specific page), only attach the child if its parent genuinely
      // belongs to that page. Otherwise a drill-down's card FormCreated,
      // replayed onto the source list, would graft an unrelated form.
      if (targetPcId) {
        const page = store.get(pcId);
        if (!page || (event.parentFormId !== page.rootFormId && !page.forms.has(event.parentFormId))) {
          return { kind: 'Unmatched' };
        }
      }
      return { kind: 'AddChildForm', pcId };
    }

    // -----------------------------------------------------------------------
    // FormCreated — root form (no parentFormId)
    // -----------------------------------------------------------------------
    if (event.type === 'FormCreated' && !event.parentFormId) {
      const pcId = targetPcId ?? store.lookupPcId(formId);
      if (!pcId) return { kind: 'Unmatched' };
      // With a hint, only treat this as a root refresh when the form IS this
      // page's root (or already one of its forms). A brand-new ownerless
      // FormCreated must NOT overwrite the target page's root/caption — it
      // belongs to a different page the caller registers separately.
      if (targetPcId) {
        const page = store.get(pcId);
        if (!page || (formId !== page.rootFormId && !page.forms.has(formId))) {
          return { kind: 'Unmatched' };
        }
      }
      return { kind: 'UpdateRootForm', pcId };
    }

    // -----------------------------------------------------------------------
    // FormClosed
    // -----------------------------------------------------------------------
    if (event.type === 'FormClosed') {
      const pcId = targetPcId ?? store.lookupPcId(formId);
      if (!pcId) return { kind: 'Unmatched' };
      return { kind: 'FormClosed', pcId, formId };
    }

    // -----------------------------------------------------------------------
    // DialogOpened — modal-rooted vs child dialog
    // -----------------------------------------------------------------------
    if (event.type === 'DialogOpened') {
      const directPcId = targetPcId ?? store.lookupPcId(formId);
      if (directPcId) {
        const page = store.get(directPcId);
        if (page && page.rootFormId === formId) {
          // The dialog's formId IS the page's own root form — treat the dialog
          // control tree as the page's root layout (wizard / request page).
          return { kind: 'ModalRootLayout', pcId: directPcId, formId };
        }
      }
      // Regular child dialog: route via ownerFormId.
      const ownerPcId = event.ownerFormId
        ? (targetPcId ?? store.lookupPcId(event.ownerFormId))
        : targetPcId;
      if (!ownerPcId) return { kind: 'Unmatched' };
      return { kind: 'AddDialog', pcId: ownerPcId };
    }

    // -----------------------------------------------------------------------
    // All other events (DataLoaded, PropertyChanged, BookmarkChanged, …)
    // -----------------------------------------------------------------------
    const pcId = targetPcId ?? store.lookupPcId(formId);
    if (!pcId) return { kind: 'Unmatched' };

    const page = store.get(pcId);
    if (!page) return { kind: 'Unmatched' };

    const form = page.forms.get(formId);
    if (!form) return { kind: 'Unmatched' };

    const controlPath = 'controlPath' in event
      ? (event as { controlPath: string }).controlPath
      : undefined;

    let childRepeaterFormId: string | undefined;
    let factboxFormId: string | undefined;

    if (controlPath) {
      // Child-repeater routing: BC sends DataLoaded with the root formId but
      // a controlPath that belongs to a child form's repeater.
      const childRepeater = findChildFormByRepeaterPath(page, formId, controlPath);
      if (childRepeater) {
        childRepeaterFormId = childRepeater.formId;
      }

      // Factbox routing: PropertyChanged on the root formId whose controlPath
      // matches a field in a factbox section's form.
      if (event.type === 'PropertyChanged' && formId === page.rootFormId) {
        const factboxForm = findFactboxFormByFieldPath(page, controlPath);
        if (factboxForm) {
          factboxFormId = factboxForm.formId;
        }
      }
    }

    return { kind: 'ApplyToForm', pcId, formId, childRepeaterFormId, factboxFormId };
  }
}

// ---------------------------------------------------------------------------
// Private routing helpers (pure functions over PageContext)
// ---------------------------------------------------------------------------

/** Find a child form (not the form at excludeFormId) that owns a repeater at controlPath. */
function findChildFormByRepeaterPath(
  page: PageContext,
  excludeFormId: string,
  controlPath: string,
): FormState | undefined {
  const matches: FormState[] = [];
  for (const [fId, form] of page.forms) {
    if (fId === excludeFormId) continue;
    if (treeRepeaters(form.root).has(controlPath)) matches.push(form);
  }
  if (matches.length <= 1) return matches[0];
  // All child trees are rooted at `server:`, so the same repeater path can
  // exist in several children (e.g. a Document's lines subpage AND a ListPart
  // factbox). Prefer the form referenced by a lines section; otherwise keep
  // the original first-match behavior.
  for (const section of page.sections.values()) {
    if (section.kind !== 'lines') continue;
    const linesForm = matches.find(f => f.formId === section.formId);
    if (linesForm) return linesForm;
  }
  return matches[0];
}

/** Find a factbox form that has a field at controlPath. */
function findFactboxFormByFieldPath(
  page: PageContext,
  controlPath: string,
): FormState | undefined {
  for (const [, section] of page.sections) {
    if (section.kind !== 'factbox') continue;
    const form = page.forms.get(section.formId);
    if (!form) continue;
    if (treeFields(form.root).some(f => f.controlPath === controlPath)) return form;
  }
  return undefined;
}
