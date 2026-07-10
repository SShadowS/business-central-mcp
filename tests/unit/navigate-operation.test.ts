// tests/unit/navigate-operation.test.ts
//
// Unit tests for NavigateOperation.
// The operation routes to either:
//   - navigationService.drillDown (when action === 'drill_down')
//   - navigationService.selectRow (for all other actions: 'select', 'lookup', undefined)
// Tests: error propagation, output shape, and correct service routing.

import { describe, it, expect, vi } from 'vitest';
import { NavigateOperation } from '../../src/operations/navigate.js';
import { ok, err } from '../../src/core/result.js';
import { ProtocolError } from '../../src/core/errors.js';

// Minimal PageContext-like object that buildAllSections / buildSection can work with.
// NavigateOperation uses buildAllSections(ctx) for drill_down and buildSection(ctx, sectionId)
// for select. We pass a real-enough object to satisfy the type but stub the services.
function makeMinimalPageContext() {
  return {
    pageContextId: 'pc:target:1',
    rootFormId: 'F2',
    pageType: 'Card',
    caption: 'Customer Card',
    forms: new Map(),
    sections: new Map(),
    dialogs: [],
    ownedFormIds: ['F2'],
    isModal: false,
    wizardState: null,
    generation: 0,
  } as any;
}

function makeNavigationService(overrides?: Record<string, unknown>) {
  return {
    drillDown: vi.fn(async () => ok({
      sourcePageContextId: 'pc:list:1',
      targetPageContext: makeMinimalPageContext(),
    })),
    selectRow: vi.fn(async () => ok(makeMinimalPageContext())),
    ...overrides,
  } as any;
}

describe('NavigateOperation routing', () => {
  it('calls drillDown when action is "drill_down"', async () => {
    const svc = makeNavigationService();
    const op = new NavigateOperation(svc);

    await op.execute({ pageContextId: 'pc:list:1', bookmark: 'bk1', action: 'drill_down' });

    expect(svc.drillDown).toHaveBeenCalledWith('pc:list:1', 'bk1', undefined);
    expect(svc.selectRow).not.toHaveBeenCalled();
  });

  it('calls drillDown with section when provided', async () => {
    const svc = makeNavigationService();
    const op = new NavigateOperation(svc);

    await op.execute({ pageContextId: 'pc:list:1', bookmark: 'bk5', action: 'drill_down', section: 'lines' });

    expect(svc.drillDown).toHaveBeenCalledWith('pc:list:1', 'bk5', 'lines');
  });

  it('calls selectRow when action is "select"', async () => {
    const svc = makeNavigationService();
    const op = new NavigateOperation(svc);

    await op.execute({ pageContextId: 'pc:list:1', bookmark: 'bk2', action: 'select' });

    expect(svc.selectRow).toHaveBeenCalledWith('pc:list:1', 'bk2', undefined);
    expect(svc.drillDown).not.toHaveBeenCalled();
  });

  it('rejects the unsupported "lookup" action instead of silently selecting', async () => {
    const svc = makeNavigationService();
    const op = new NavigateOperation(svc);

    const result = await op.execute({ pageContextId: 'pc:list:1', bookmark: 'bk3', action: 'lookup' as never });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/lookup/i);
    expect(svc.selectRow).not.toHaveBeenCalled();
    expect(svc.drillDown).not.toHaveBeenCalled();
  });

  it('calls selectRow when action is omitted (default path)', async () => {
    const svc = makeNavigationService();
    const op = new NavigateOperation(svc);

    await op.execute({ pageContextId: 'pc:list:1', bookmark: 'bk4' });

    expect(svc.selectRow).toHaveBeenCalled();
    expect(svc.drillDown).not.toHaveBeenCalled();
  });

  it('passes section to selectRow when provided', async () => {
    const svc = makeNavigationService();
    const op = new NavigateOperation(svc);

    await op.execute({ pageContextId: 'pc:list:1', bookmark: 'bk2', action: 'select', section: 'header' });

    expect(svc.selectRow).toHaveBeenCalledWith('pc:list:1', 'bk2', 'header');
  });
});

describe('NavigateOperation output shape', () => {
  it('drill_down output includes targetPageContextId, pageType, changedSections=[], dialogsOpened=[], requiresDialogResponse=false', async () => {
    const svc = makeNavigationService();
    const op = new NavigateOperation(svc);

    const result = await op.execute({ pageContextId: 'pc:list:1', bookmark: 'bk1', action: 'drill_down' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.targetPageContextId).toBe('pc:target:1');
    expect(result.value.pageType).toBe('Card');
    expect(result.value.changedSections).toEqual([]);
    expect(result.value.dialogsOpened).toEqual([]);
    expect(result.value.requiresDialogResponse).toBe(false);
  });

  it('select output includes sections=[] (empty sections map), changedSections=[], no targetPageContextId', async () => {
    const svc = makeNavigationService();
    const op = new NavigateOperation(svc);

    const result = await op.execute({ pageContextId: 'pc:list:1', bookmark: 'bk2', action: 'select' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.targetPageContextId).toBeUndefined();
    expect(result.value.changedSections).toEqual([]);
    expect(result.value.dialogsOpened).toEqual([]);
    expect(result.value.requiresDialogResponse).toBe(false);
  });
});

describe('NavigateOperation error propagation', () => {
  it('propagates drillDown error unchanged', async () => {
    const navErr = new ProtocolError('Page not found');
    const svc = makeNavigationService({
      drillDown: vi.fn(async () => err(navErr)),
    });
    const op = new NavigateOperation(svc);

    const result = await op.execute({ pageContextId: 'pc:list:1', bookmark: 'bk1', action: 'drill_down' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe('Page not found');
    }
  });

  it('propagates selectRow error unchanged', async () => {
    const navErr = new ProtocolError('Bookmark expired');
    const svc = makeNavigationService({
      selectRow: vi.fn(async () => err(navErr)),
    });
    const op = new NavigateOperation(svc);

    const result = await op.execute({ pageContextId: 'pc:list:1', bookmark: 'bad-bk', action: 'select' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe('Bookmark expired');
    }
  });
});
