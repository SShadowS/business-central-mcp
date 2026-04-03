// src/protocol/section-resolver.ts
import { parseControlTree } from './control-tree-parser.js';
import type { PageContext } from './page-context.js';
import type { FormState } from './form-state.js';
import { primaryRepeater, resolveRepeater } from './form-state.js';
import type { RepeaterState } from './types.js';

export type SectionKind = 'header' | 'lines' | 'factbox' | 'requestPage' | 'subpage';

export interface SectionDescriptor {
  readonly sectionId: string;
  readonly kind: SectionKind;
  readonly caption: string;
  readonly formId: string;
  readonly repeaterControlPath?: string;
}

export interface ResolvedSection {
  section: SectionDescriptor;
  form: FormState;
  repeater: RepeaterState | null;
}

export class SectionResolver {
  createHeaderSection(rootFormId: string): SectionDescriptor {
    return {
      sectionId: 'header',
      kind: 'header',
      caption: 'Header',
      formId: rootFormId,
    };
  }

  deriveSection(
    parentPageContext: PageContext,
    childFormId: string,
    childControlTree: unknown,
  ): SectionDescriptor {
    const parsed = parseControlTree(childControlTree);

    if (parsed.repeaters.size > 0) {
      const [repeaterPath] = parsed.repeaters.keys();
      const id = this.uniqueSectionId(parentPageContext, 'lines');
      return {
        sectionId: id,
        kind: 'lines',
        caption: parsed.caption || 'Lines',
        formId: childFormId,
        repeaterControlPath: repeaterPath,
      };
    }

    const caption = parsed.caption || 'Subpage';
    const id = this.uniqueSectionId(parentPageContext, `subpage:${caption}`);
    return {
      sectionId: id,
      kind: 'subpage',
      caption,
      formId: childFormId,
    };
  }

  private uniqueSectionId(ctx: PageContext, base: string): string {
    if (!ctx.sections.has(base)) return base;
    for (let i = 2; ; i++) {
      const candidate = `${base}#${i}`;
      if (!ctx.sections.has(candidate)) return candidate;
    }
  }
}

/** Resolve a sectionId to its FormState and repeater. */
export function resolveSection(
  ctx: PageContext,
  sectionId?: string,
  defaultSection?: string,
): ResolvedSection | { error: string; availableSections: string[] } {
  const id = sectionId ?? defaultSection ?? 'header';
  const section = ctx.sections.get(id);
  if (!section) {
    return {
      error: `Section '${id}' not found.`,
      availableSections: Array.from(ctx.sections.keys()),
    };
  }
  const form = ctx.forms.get(section.formId);
  if (!form) {
    return {
      error: `Form for section '${id}' not found (formId: ${section.formId}).`,
      availableSections: Array.from(ctx.sections.keys()),
    };
  }
  const repeater = section.repeaterControlPath
    ? resolveRepeater(form, section.repeaterControlPath)
    : primaryRepeater(form);
  return { section, form, repeater };
}
