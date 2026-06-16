import { isOk, ok, err, type Result } from '../core/result.js';
import { CardPartStubError, type ProtocolError } from '../core/errors.js';
import type { PageService } from '../services/page-service.js';
import { buildAllSections, type Section } from '../protocol/section-dto.js';
import { fields as treeFields, cues as treeCues } from '../protocol/form-views.js';

export interface OpenPageInput {
  pageId: string;
  bookmark?: string;
  tenantId?: string;
}

export interface OpenPageOutput {
  pageContextId: string;
  /** PageType enum string from BC; see PageType in protocol/types.ts. */
  pageType: string;
  caption: string;
  /** True when the page opened as a modal (wizard, request page, confirmation). */
  isModal: boolean;
  /**
   * Every visible page section in canonical order: header, lines, subpages,
   * factboxes, requestPage. See `Section` in protocol/section-dto.ts.
   */
  sections: Section[];
  /**
   * Generation token for the page's current state. Increments each time an
   * event batch mutates the page (form tree or rows changed). Pass as
   * `expectedStateVersion` to bc_write_data / bc_execute_action to detect
   * and reject stale-state writes.
   */
  stateVersion: number;
}

export class OpenPageOperation {
  constructor(private readonly pageService: PageService) {}

  async execute(input: OpenPageInput): Promise<Result<OpenPageOutput, ProtocolError>> {
    const result = await this.pageService.openPage(input.pageId, {
      bookmark: input.bookmark,
      tenantId: input.tenantId,
    });
    if (!isOk(result)) return result;

    const ctx = result.value;
    if (ctx.pageType === 'CardPart') {
      const rootForm = ctx.forms.get(ctx.rootFormId);
      const captionedFields = rootForm
        ? treeFields(rootForm.root).filter((f) => f.properties.caption)
        : [];
      const cueCount = rootForm ? treeCues(rootForm.root).length : 0;
      if (captionedFields.length === 0 && cueCount === 0) {
        return err(new CardPartStubError(
          `Page ${input.pageId} is a CardPart and BC returned a placeholder shell. CardParts are server stubs unless reached through a host page (Role Center or another page that embeds them). Open the host page instead.`,
          {
            pageId: input.pageId,
            hostHint: 'Open the Role Center or host page that embeds this CardPart, then read the corresponding subpage section from its sections[] array.',
          },
        ));
      }
    }

    return ok({
      pageContextId: ctx.pageContextId,
      pageType: ctx.pageType,
      caption: ctx.caption || ctx.rootFormId,
      isModal: ctx.isModal,
      sections: buildAllSections(ctx),
      stateVersion: ctx.generation,
    });
  }
}
