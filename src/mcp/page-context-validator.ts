import { InputValidationError } from '../core/errors.js';
import type { PageContextRepository } from '../protocol/page-context-repo.js';
import type { PageContext } from '../protocol/page-context.js';

export function validatePageContextId(
  repo: PageContextRepository,
  pageContextId: string,
): PageContext {
  const ctx = repo.get(pageContextId);
  if (ctx) return ctx;

  const open = repo.listPageContextSummaries();
  const openList = open.length > 0
    ? open.map(p => `"${p.id}" (${p.caption})`).join(', ')
    : 'No pages are currently open';

  throw new InputValidationError([{
    path: 'pageContextId',
    message: `Page context "${pageContextId}" does not exist. Open page contexts: ${openList}. Use bc_open_page to open a page first.`,
  }]);
}
