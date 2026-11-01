// src/protocol/wizard-classify.ts
//
// Classify a BC ActionNode as one of the wizard navigation roles
// (back/next/finish/cancel). Centralised here so MCP-boundary adapters
// (open-page, navigate, wizard-navigate, section-dto, action-service)
// share one implementation.

import type { ActionNode } from './form-node.js';
import { SystemAction, type PageType } from './types.js';

export type WizardNav = 'back' | 'next' | 'finish' | 'cancel';

/**
 * The icon roles (Back/Next/Finish) apply only on wizard pages. BC's
 * `NavigatePageActionControlHelper` maps the same images, but only for
 * NavigatePage action bars; on a list or card, `Image = Approve` or `Start`
 * is an ordinary action ("Mark as Handled", "Release", "Run Now"), and
 * tagging it let bc_wizard_navigate run it as "finish" (#50).
 */
export function classifyWizardNav(a: ActionNode, pageType: PageType | undefined): WizardNav | undefined {
  const id = a.iconIdentifier;
  if (id && (pageType === 'NavigatePage' || pageType === 'StandardDialog')) {
    if (/PreviousRecord/i.test(id)) return 'back';
    if (/NextRecord|Action_Start/i.test(id)) return 'next';
    if (/Approve/i.test(id)) return 'finish';
  }
  // Cancel shape: SystemAction.Cancel (310), SystemAction.Abort (320),
  // and SystemAction.CloseOk (350 — dialog-level "close as OK" terminator
  // verified in decompiled `Microsoft.Dynamics.Framework.UI.Client.SystemAction.cs`).
  if (a.systemAction === SystemAction.Cancel
      || a.systemAction === SystemAction.Abort
      || a.systemAction === SystemAction.CloseOk) return 'cancel';
  return undefined;
}
