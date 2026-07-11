// src/services/strategies/child-form-hydration.ts
import { isOk } from '../../core/result.js';
import type { BCSession } from '../../session/bc-session.js';
import type { PageContextRepository } from '../../protocol/page-context-repo.js';
import type { Logger } from '../../core/logger.js';
import type { BCEvent, LoadFormInteraction, InvokeActionInteraction } from '../../protocol/types.js';
import { buildFormTree } from '../../protocol/form-tree-builder.js';
import { walkTree } from '../../protocol/form-tree-walk.js';
import { isFormHostNode } from '../../protocol/form-node.js';
import { fields as treeFields, cues as treeCues } from '../../protocol/form-views.js';
import type { SectionKind } from '../../protocol/section-resolver.js';
import { RoleCenterHydrationStrategy } from './role-center-hydration.js';
import { FactboxHydrationStrategy } from './factbox-hydration.js';

/** Section kinds that are auto-loaded when a page (or a drilled/action-opened target) is hydrated. */
export const DEFAULT_AUTO_LOAD_SECTIONS: readonly SectionKind[] = ['header', 'lines', 'subpage', 'factbox'];

/**
 * Discovers the child forms embedded in a page's control tree (fhc -> lf nodes)
 * and loads their data — lines subpages, FactBoxes, and Role Center hosted
 * CardParts. Shared by the page-open, drill-down, and action-opened-page paths
 * so EVERY target page gains its lines/factbox sections, not only pages opened
 * directly via bc_open_page. Before this was shared, drill-down and
 * action-opened cards had a `header` section only (no `lines`).
 */
export class ChildFormHydrationStrategy {
  private readonly roleCenterHydration: RoleCenterHydrationStrategy;
  private readonly factboxHydration: FactboxHydrationStrategy;

  constructor(
    private readonly session: BCSession,
    private readonly repo: PageContextRepository,
    private readonly logger: Logger,
    private readonly autoLoadSections: readonly SectionKind[] = DEFAULT_AUTO_LOAD_SECTIONS,
  ) {
    this.roleCenterHydration = new RoleCenterHydrationStrategy(session, repo);
    this.factboxHydration = new FactboxHydrationStrategy(session, repo);
  }

  async hydrate(pageContextId: string, openEvents: BCEvent[]): Promise<void> {
    const ctx = this.repo.get(pageContextId);
    if (!ctx) return;

    // Collect child form IDs to load data for
    const childFormIds: string[] = [];

    // Source 1: Child forms from separate FormCreated events (rare, but possible)
    for (const e of openEvents) {
      if (e.type === 'FormCreated' && e.formId !== ctx.rootFormId) {
        childFormIds.push(e.formId);
      }
    }

    // Source 2: Child forms embedded in root form's control tree as fhc -> lf nodes
    const rootFormCreated = openEvents.find(e => e.type === 'FormCreated' && e.formId === ctx.rootFormId);
    if (rootFormCreated?.type === 'FormCreated' && rootFormCreated.controlTree) {
      try {
        const rootTree = buildFormTree(rootFormCreated.controlTree);
        for (const node of walkTree(rootTree)) {
          if (!isFormHostNode(node) || !node.hostedFormServerId) continue;
          this.repo.registerDiscoveredChildForm(pageContextId, {
            serverId: node.hostedFormServerId,
            caption: node.hostedFormCaption,
            controlTree: node.hostedFormControlTree,
            isSubForm: node.hostedFormIsSubForm,
            isPart: node.hostedFormIsPart,
          });
          childFormIds.push(node.hostedFormServerId);
          this.logger.debug('page', `Discovered child form: ${node.hostedFormServerId} (${node.hostedFormCaption}, subform=${node.hostedFormIsSubForm}, part=${node.hostedFormIsPart})`);
        }
      } catch {
        // Non-fatal: child form discovery failure shouldn't abort the page open
      }
    }

    // Load data for all child forms (only lines subpage and key parts, skip most factboxes)
    const updatedCtx = this.repo.get(pageContextId);
    if (!updatedCtx) return;

    for (const childFormId of childFormIds) {
      // Only load data for sections whose kind is in the auto-load list
      const section = Array.from(updatedCtx.sections.values()).find(s => s.formId === childFormId);
      if (!section) continue;
      if (!this.autoLoadSections.includes(section.kind)) continue;

      // Step 1: LoadForm to initialize the child form on the server.
      // For factboxes, openForm:true is needed -- without it, CanLoadData() returns false
      // because the form was already opened during control tree parsing. openForm resets
      // the form state so LoadData() can populate field values.
      // Verified from decompiled LoadFormInteraction.cs: OpenForm -> LoadData chain.
      // Role Center hosted CardParts (cuegroups) follow the same pattern: BC won't
      // populate cue StringValues without openForm:true, since the form was already
      // opened during root-tree parsing.
      // Role Center hosted CardParts arrive on the wire as IsSubForm=false /
      // IsPart=true, which page-context-repo classifies as `factbox` -- the
      // same bucket used for genuine FactBoxes on Card pages. They aren't
      // really factboxes but the wire shape doesn't distinguish, so we key
      // off `pageType === 'RoleCenter'` and treat any non-lines child as a
      // role-center child (subpage OR factbox).
      const ctxForKind = this.repo.get(pageContextId);
      const isRoleCenterChild =
        ctxForKind?.pageType === 'RoleCenter' &&
        (section.kind === 'subpage' || section.kind === 'factbox');
      const isFactbox = section.kind === 'factbox';
      const loadInteraction: LoadFormInteraction = {
        type: 'LoadForm',
        formId: childFormId,
        loadData: true,
        delayed: false,
        openForm: isFactbox || isRoleCenterChild,
      };

      const loadResult = await this.session.invoke(
        loadInteraction,
        (event) => event.type === 'InvokeCompleted' || event.type === 'DataLoaded' || event.type === 'PropertyChanged',
      );

      if (isOk(loadResult)) {
        this.repo.applyToPage(pageContextId, loadResult.value);
      }

      if (isRoleCenterChild) {
        // Cue StringValues are computed server-side in response to a Refresh
        // on the hosted CardPart. The LoadForm above populates form metadata
        // but leaves cue tiles at their "0" stub. RoleCenterHydrationStrategy
        // sends the follow-up Refresh (systemAction:30, controlPath:'server:')
        // to trigger recomputation of bound stackc StringValues.
        await this.roleCenterHydration.hydrate(pageContextId, childFormId);
      }

      // Step 2: Refresh the child form's repeater to trigger DataLoaded.
      // BC sends lines data as DataLoaded on the ROOT formId with the child's controlPath.
      // LoadForm alone doesn't trigger DataLoaded for subpage repeaters.
      if (section.repeaterControlPath) {
        const refreshInteraction: InvokeActionInteraction = {
          type: 'InvokeAction',
          formId: childFormId,
          controlPath: section.repeaterControlPath,
          systemAction: 30, // SystemAction.Refresh
        };

        const refreshResult = await this.session.invoke(
          refreshInteraction,
          (event) => event.type === 'InvokeCompleted' || event.type === 'DataLoaded',
        );

        if (isOk(refreshResult)) {
          this.repo.applyToPage(pageContextId, refreshResult.value);
        }
      }
    }

    // Step 3: Trigger factbox data population by selecting the current row.
    // BC populates factbox data server-side in response to SetCurrentRow on the
    // parent repeater. Without this, factbox forms have field metadata but empty values.
    // Verified from decompiled WebLogicalFormObserver.cs and live WebSocket capture.
    const ctxForFactbox = this.repo.get(pageContextId);
    if (ctxForFactbox) {
      const factboxSections = Array.from(ctxForFactbox.sections.entries()).filter(([, s]) => s.kind === 'factbox');
      await this.factboxHydration.hydrate(pageContextId, factboxSections);
    }

    // After factbox refresh: any factbox section whose form yielded no field
    // nodes is dead (BC returned a stub). buildFormTree already skips
    // MappingHint='PlaceholderField' nodes (form-tree-builder.ts), so a
    // genuinely populated factbox always has at least one FieldNode here.
    // Mark empty ones invalid so Section DTO builders skip them.
    //
    // Exception: Role Center hosted CardParts whose entire content is a
    // cuegroup (stackgc -> stackc tiles) yield zero FieldNodes -- stackc is
    // a separate node type, not a member of FIELD_TYPES. Those sections must
    // stay valid so their `cues[]` projection survives into the output.
    const finalCtx = this.repo.get(pageContextId);
    if (finalCtx) {
      for (const [sectionId, sec] of finalCtx.sections) {
        if (sec.kind !== 'factbox') continue;
        const f = finalCtx.forms.get(sec.formId);
        if (!f) continue;
        if (treeFields(f.root).length === 0 && treeCues(f.root).length === 0) {
          this.repo.invalidateSection(pageContextId, sectionId);
        }
      }
    }
  }
}
