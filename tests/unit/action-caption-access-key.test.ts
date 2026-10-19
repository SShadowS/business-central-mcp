// Issue #43: captions carry access-key markers ("Run N&ext Test"); callers type
// the plain caption. Matching strips "&" on both sides.
import { describe, it, expect, vi } from 'vitest';
import { ActionService, plainCaption } from '../../src/services/action-service.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import { ok } from '../../src/core/result.js';
import type { BCEvent } from '../../src/protocol/types.js';

const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function makeService() {
  const repo = new PageContextRepository();
  repo.create('pc:1', 'F1');
  repo.applyToPage('pc:1', [{
    type: 'FormCreated', formId: 'F1', isReload: false,
    controlTree: { t: 'lf', ServerId: 'F1', PageType: 1, Children: [{ t: 'ac', Caption: 'Run N&ext Test' }] },
  } as BCEvent]);
  const invoke = vi.fn().mockResolvedValue(ok([]));
  return { service: new ActionService({ invoke, invokeSequence: invoke } as any, repo, logger), invoke };
}

describe('action caption access keys', () => {
  it('plainCaption drops markers and keeps a literal &&', () => {
    expect(plainCaption('Run N&ext Test')).toBe('Run Next Test');
    expect(plainCaption('Save && Close')).toBe('Save & Close');
  });

  it('finds "Run N&ext Test" by its plain caption', async () => {
    const { service, invoke } = makeService();
    await service.executeAction('pc:1', 'run next test');
    expect(invoke).toHaveBeenCalled();
  });

  it('still accepts the raw caption, and lists plain captions when not found', async () => {
    const { service } = makeService();
    const res = await service.executeAction('pc:1', 'Run Nxt Test');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.context?.['availableActions']).toEqual(['Run Next Test']);
    const { service: s2, invoke } = makeService();
    await s2.executeAction('pc:1', 'Run N&ext Test');
    expect(invoke).toHaveBeenCalled();
  });
});
