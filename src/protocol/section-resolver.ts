// src/protocol/section-resolver.ts
export type SectionKind = 'header' | 'lines' | 'factbox' | 'requestPage' | 'subpage';

export interface SectionDescriptor {
  readonly sectionId: string;
  readonly kind: SectionKind;
  readonly caption: string;
  readonly formId: string;
  readonly repeaterControlPath?: string;
}
