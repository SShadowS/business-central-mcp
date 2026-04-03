// src/protocol/page-context.ts
import type { FormState } from './form-state.js';
import type { SectionDescriptor } from './section-resolver.js';
import type { DialogInfo } from './types.js';

export interface PageContext {
  readonly pageContextId: string;
  readonly rootFormId: string;
  readonly pageType: 'Card' | 'List' | 'Document' | 'Unknown';
  readonly caption: string;
  readonly forms: ReadonlyMap<string, FormState>;
  readonly sections: ReadonlyMap<string, SectionDescriptor>;
  readonly dialogs: DialogInfo[];
  readonly ownedFormIds: string[];
}
