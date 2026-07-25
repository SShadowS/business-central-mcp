// tests/unit/execute-action-downloads.test.ts
//
// Verifies ExecuteActionOperation wires DownloadService into its output:
// after a successful action, the operation's event batch is handed to
// downloadService.capture(), and the resulting downloads/externalUris are
// spread into the returned ExecuteActionOutput.

import { describe, it, expect, vi } from 'vitest';
import { ExecuteActionOperation } from '../../src/operations/execute-action.js';

describe('ExecuteActionOperation downloads', () => {
  it('captures downloads from the action events and returns them', async () => {
    const events = [{ type: 'FileDownloadReady', formId: '', relativeUrl: 'DynamicFileHandler.axd?fname=x.xlsx', style: '1' }];
    const actionService = { executeAction: vi.fn(async () => ({ ok: true, value: { success: true, events } })) } as never;
    const repo = { get: vi.fn(() => ({ rootFormId: 'f', generation: 1, sections: new Map() })), getByFormId: vi.fn(() => undefined) } as never;
    const nav = {} as never;
    const captured = { downloads: [{ fileName: 'x.xlsx', contentType: 'app/xlsx', sizeBytes: 4, style: 'download', bytes: 'AAAA' }], externalUris: [] };
    const downloadService = { capture: vi.fn(async () => captured) } as never;

    const op = new ExecuteActionOperation(actionService, repo, nav, downloadService);
    const result = await op.execute({ pageContextId: 'p', action: 'SendToExcel' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.downloads).toEqual(captured.downloads);
      expect(downloadService.capture).toHaveBeenCalled();
    }
  });
});
