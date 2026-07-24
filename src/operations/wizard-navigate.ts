import { ok, err, isOk, type Result } from '../core/result.js';
import type { BCError } from '../core/errors.js';
import { classifyBusinessError } from '../protocol/error-classifier.js';
import type { ActionService } from '../services/action-service.js';
import type { PageContextRepository } from '../protocol/page-context-repo.js';
import { resolveSection } from '../protocol/section-resolver.js';
import { detectChangedSections, detectDialogs } from '../protocol/mutation-result.js';
import { isEffectivelyVisible } from '../protocol/visibility.js';
import type { ControlField } from '../protocol/types.js';
import { fields as treeFields, actions as treeActions, groupVisibility as treeGroupVisibility } from '../protocol/form-views.js';
import { classifyWizardNav, type WizardNav } from '../protocol/wizard-classify.js';
import type { Download, DownloadService } from '../services/download-service.js';

export type { WizardNav };

export interface WizardNavigateInput {
  pageContextId: string;
  action: WizardNav;
}

export interface WizardNavigateOutput {
  success: boolean;
  /** Step caption / page caption after the navigation completes. */
  caption: string;
  /** Fields visible on the new step. */
  fields: Array<{ name: string; value?: string; editable: boolean }>;
  /** Wizard navigation actions still available (next step may not have all four). */
  availableNav: WizardNav[];
  /** True when the wizard closed (Finish or Cancel) — page should be considered done. */
  closed: boolean;
  changedSections: string[];
  dialogsOpened: Array<{ formId: string; message?: string; fields?: ControlField[] }>;
  /** Captured file downloads produced by this navigation step; empty when none. */
  downloads: Download[];
  /** Links BC would open externally (not fetched by the server); empty when none. */
  externalUris: Array<{ uri: string; style: string }>;
}

export class WizardNavigateOperation {
  constructor(
    private readonly actionService: ActionService,
    private readonly repo: PageContextRepository,
    private readonly downloadService: DownloadService,
  ) {}

  async execute(input: WizardNavigateInput): Promise<Result<WizardNavigateOutput, BCError>> {
    const result = await this.actionService.executeWizardNav(input.pageContextId, input.action);
    if (!isOk(result)) return result;

    // A finish/next that raises a BC error (message or error dialog) must
    // not be reported as success.
    const bizErr = classifyBusinessError(result.value.events);
    if (bizErr !== null) return err(bizErr);

    const ar = result.value;
    const captured = await this.downloadService.capture(ar.events);

    const ctx = this.repo.get(input.pageContextId);
    const dialogsOpened = detectDialogs(ar.events);
    const changedSections = ctx ? detectChangedSections(ctx, ar.events) : [];

    let caption = ctx?.caption ?? '';
    let fieldsOut: WizardNavigateOutput['fields'] = [];
    let availableNav: WizardNav[] = [];
    let closed = false;

    if (ctx) {
      const resolved = resolveSection(ctx, 'header');
      const root = 'error' in resolved ? undefined : resolved.form.root;
      const ws = ctx.wizardState;
      caption = ctx.caption || caption;
      if (root) {
        const groupVis = treeGroupVisibility(root);
        fieldsOut = treeFields(root)
          .filter(f => f.properties.caption && isEffectivelyVisible(root, f.controlPath, groupVis, ws))
          .map(f => ({
            name: f.properties.caption!,
            value: f.properties.stringValue,
            editable: f.properties.editable ?? false,
          }));
        availableNav = treeActions(root)
          .filter(a => (a.properties.enabled ?? true) && isEffectivelyVisible(root, a.controlPath, groupVis, ws))
          .map(a => classifyWizardNav(a))
          .filter((v): v is WizardNav => !!v);
      }
      closed = (input.action === 'finish' || input.action === 'cancel') && availableNav.length === 0;
    } else {
      closed = true;
    }

    return ok({
      success: ar.success,
      caption,
      fields: fieldsOut,
      availableNav,
      closed,
      changedSections,
      dialogsOpened,
      downloads: captured.downloads,
      externalUris: captured.externalUris,
    });
  }
}
