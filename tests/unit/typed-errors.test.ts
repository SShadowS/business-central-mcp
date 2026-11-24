import { describe, it, expect, vi } from 'vitest';
import {
  PageContextNotFoundError,
  ActionNotFoundError,
  ActionDisabledError,
  SectionNotFoundError,
  TabNotFoundError,
  PageNotFoundError,
  FieldNotFoundError,
  ProtocolError,
  errorHint,
} from '../../src/core/errors.js';
import { toBcErrorBody } from '../../src/mcp/error-envelope.js';
import { isAmbiguousFailure } from '../../src/mcp/idempotency-gate.js';
import { PageService } from '../../src/services/page-service.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import { err } from '../../src/core/result.js';
import { ActionService } from '../../src/services/action-service.js';
import { SortService } from '../../src/services/sort-service.js';
import type { BCEvent } from '../../src/protocol/types.js';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe('typed local errors', () => {
  it.each([
    [new PageContextNotFoundError('pc:1'), 'PAGE_CONTEXT_NOT_FOUND', 'state', {}],
    [new ActionNotFoundError('Action not found: Foo', { availableActions: ['Post', 'Release'] }), 'ACTION_NOT_FOUND', 'validation', { availableActions: ['Post', 'Release'] }],
    [new ActionNotFoundError('in lines', { foundInSection: 'lines' }), 'ACTION_NOT_FOUND', 'validation', { foundInSection: 'lines' }],
    [new ActionDisabledError('Dimensions'), 'ACTION_DISABLED', 'state', { action: 'Dimensions' }],
    [new SectionNotFoundError("Section 'x' not found.", ['header', 'lines']), 'SECTION_NOT_FOUND', 'validation', { availableSections: ['header', 'lines'] }],
    [new TabNotFoundError('Gen', ['General', 'Invoicing']), 'TAB_NOT_FOUND', 'validation', { availableTabs: ['General', 'Invoicing'] }],
    [new PageNotFoundError('999999'), 'PAGE_NOT_FOUND', 'validation', { pageId: '999999' }],
    [new FieldNotFoundError('Field not found: X', { availableFields: ['Name'] }), 'FIELD_NOT_FOUND', 'validation', { availableFields: ['Name'] }],
  ])('%s renders as its own code with structured details, never ambiguous', (e, code, category, details) => {
    const body = toBcErrorBody('bc_tool', e);
    expect(body.error).toMatchObject({ code, category, retryable: false, details });
    expect(body.nextSteps[0]).toBe(errorHint(code));
    expect(isAmbiguousFailure(e.code)).toBe(false);
  });

  it('the validation hint says the rejected value stays and blocks actions until fixed or discarded', () => {
    expect(errorHint('VALIDATION_ERROR')).toMatch(/stays on the page/);
    expect(errorHint('VALIDATION_ERROR')).toMatch(/discard/i);
  });

  it('SESSION_LOST is a state, not a network fault', () => {
    expect(toBcErrorBody('t', { code: 'SESSION_LOST', message: 'x' }).error.category).toBe('state');
  });
});

describe('call sites raise the typed errors', () => {
  function cardRepo(): PageContextRepository {
    const repo = new PageContextRepository();
    repo.create('pc:card', 'CARD');
    repo.applyToPage('pc:card', [{
      type: 'FormCreated', formId: 'CARD', isReload: false,
      controlTree: { t: 'lf', ServerId: 'CARD', PageType: 0, Children: [
        { t: 'gc', Children: [{ t: 'sc', Caption: 'Name', Editable: true, Visible: true, StringValue: '' }] },
        { t: 'ac', Caption: 'Dimensions', Enabled: false, Visible: true, SystemAction: 0 },
        { t: 'ac', Caption: 'Statistics', Enabled: true, Visible: true, SystemAction: 0 },
      ] },
    } as BCEvent]);
    return repo;
  }
  const svc = (repo: PageContextRepository) => new ActionService({ invoke: vi.fn() } as never, repo, logger as never);

  it('an unknown pageContextId is PageContextNotFoundError', async () => {
    const r = await svc(new PageContextRepository()).executeAction('pc:gone', 'Post');
    expect(!r.ok && r.error).toBeInstanceOf(PageContextNotFoundError);
  });

  it('a disabled action is ActionDisabledError, sent nowhere', async () => {
    const r = await svc(cardRepo()).executeAction('pc:card', 'Dimensions');
    expect(!r.ok && r.error).toBeInstanceOf(ActionDisabledError);
  });

  it('an unknown action is ActionNotFoundError listing the enabled actions', async () => {
    const r = await svc(cardRepo()).executeAction('pc:card', 'Does Not Exist');
    expect(!r.ok && r.error).toBeInstanceOf(ActionNotFoundError);
    if (!r.ok) expect((r.error as ActionNotFoundError).availableActions).toEqual(['Statistics']);
  });

  it('an unknown sort column is FieldNotFoundError listing the columns', async () => {
    const repo = new PageContextRepository();
    repo.create('pc:list', 'LIST');
    repo.applyToPage('pc:list', [{
      type: 'FormCreated', formId: 'LIST', isReload: false,
      controlTree: { t: 'lf', ServerId: 'LIST', PageType: 1, Children: [
        { t: 'rc', Columns: [{ t: 'rcc', Caption: 'No.', ColumnBinder: { Name: 'no' } }, { t: 'rcc', Caption: 'Name', ColumnBinder: { Name: 'name' } }] },
      ] },
    } as BCEvent]);
    const r = await new SortService({ invoke: vi.fn() } as never, repo, logger as never).applySort('pc:list', 'Nope', 'asc');
    expect(!r.ok && r.error).toBeInstanceOf(FieldNotFoundError);
    if (!r.ok) expect(toBcErrorBody('bc_read_data', r.error).error.details).toEqual({ availableColumns: ['No.', 'Name'] });
  });

  it('an unknown section is SectionNotFoundError', async () => {
    const r = await svc(cardRepo()).executeAction('pc:card', 'Statistics', 'lines');
    expect(!r.ok && r.error).toBeInstanceOf(SectionNotFoundError);
  });
});

describe('PageService.openPage on a missing page', () => {
  const missing = 'JSON-RPC error: {"code":2,"errorType":"Microsoft.Dynamics.Nav.Types.NavPageBuildErrorException","message":"Cannot build the page 999999.\\r\\n The metadata object Page 999999 was not found."}';

  it('maps NavPageBuildErrorException "was not found" to PageNotFoundError', async () => {
    const session = { invoke: vi.fn().mockResolvedValue(err(new ProtocolError(missing))) };
    const svc = new PageService(session as never, new PageContextRepository(), logger as never);
    const r = await svc.openPage('999999');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(PageNotFoundError);
  });

  it('passes any other OpenForm error through unchanged', async () => {
    const other = new ProtocolError('JSON-RPC error: {"errorType":"Something.Else"}');
    const session = { invoke: vi.fn().mockResolvedValue(err(other)) };
    const svc = new PageService(session as never, new PageContextRepository(), logger as never);
    const r = await svc.openPage('22');
    if (!r.ok) expect(r.error).toBe(other);
  });
});
