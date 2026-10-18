// Issue #41: writing the first line of a document in view mode must say why it
// fails (no rows; run Edit for draft rows), not "Loaded rows: 0--1" or
// "Field not found".
import { describe, it, expect, vi } from 'vitest';
import { DataService } from '../../src/services/data-service.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import type { BCEvent } from '../../src/protocol/types.js';

const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function makeService() {
  const repo = new PageContextRepository();
  repo.create('pc:1', 'F1');
  repo.applyToPage('pc:1', [{
    type: 'FormCreated', formId: 'F1', isReload: false,
    controlTree: {
      t: 'lf', ServerId: 'F1', PageType: 1,
      Children: [
        { t: 'ac', Caption: 'Edit', SystemAction: 40 },
        { t: 'rc', Columns: [{ t: 'rcc', Caption: 'Type' }] },
      ],
    },
  } as BCEvent]);
  const invoke = vi.fn();
  return { service: new DataService({ invoke } as any, repo, logger), invoke };
}

describe('DataService line write on an empty, view-mode repeater', () => {
  it('rowIndex on no rows names the cause and the Edit fix, sends nothing', async () => {
    const { service, invoke } = makeService();
    const res = await service.writeField('pc:1', 'Type', 'Item', { rowIndex: 0 });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.message).toContain('No rows are loaded.');
      expect(res.error.message).not.toContain('0--1');
      expect(res.error.message).toContain("'Edit'");
    }
    expect(invoke).not.toHaveBeenCalled();
  });

  it('a column without a row target says to pass rowIndex/bookmark, not "Field not found"', async () => {
    const { service } = makeService();
    const res = await service.writeField('pc:1', 'Type', 'Item');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.message).not.toMatch(/Field not found/);
      expect(res.error.message).toMatch(/pass rowIndex or bookmark/);
    }
  });
});
