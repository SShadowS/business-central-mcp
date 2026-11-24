// Issue #43: captions carry access-key markers ("Run N&ext Test"); callers type
// the plain caption. Matching strips "&" on both sides.
import { describe, it, expect, vi } from 'vitest';
import type { ActionNotFoundError } from '../../src/core/errors.js';
import { ActionService, plainCaption } from '../../src/services/action-service.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import { ok } from '../../src/core/result.js';
import type { BCEvent } from '../../src/protocol/types.js';
import { buildSection } from '../../src/protocol/section-dto.js';

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

  // Payload re-review 2026-11-24: "Prices & Discounts Overview" came back as "Prices  Discounts
  // Overview" in availableActions: an & before a space is a literal, not an access-key marker.
  it('plainCaption keeps an ampersand that marks no key', () => {
    expect(plainCaption('Prices & Discounts Overview')).toBe('Prices & Discounts Overview');
    expect(plainCaption('Terms &')).toBe('Terms &');
  });

  it('section actions show plain captions and omit systemAction 0', async () => {
    const repo = new PageContextRepository();
    repo.create('pc:x', 'X');
    repo.applyToPage('pc:x', [{
      type: 'FormCreated', formId: 'X', isReload: false,
      controlTree: { t: 'lf', ServerId: 'X', PageType: 0, Children: [
        { t: 'ac', Caption: 'C&ontact', Enabled: true, Visible: true, SystemAction: 0 },
        { t: 'ac', Caption: 'Delete', Enabled: true, Visible: true, SystemAction: 20 },
      ] },
    } as BCEvent]);
    const s = buildSection(repo.get('pc:x')!, 'header')!;
    expect(s.actions).toEqual([{ name: 'Contact' }, { name: 'Delete', systemAction: 20 }]);
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
    if (!res.ok) expect((res.error as ActionNotFoundError).availableActions).toEqual(['Run Next Test']);
    const { service: s2, invoke } = makeService();
    await s2.executeAction('pc:1', 'Run N&ext Test');
    expect(invoke).toHaveBeenCalled();
  });
});
