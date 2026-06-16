import { describe, it, expect, vi } from 'vitest';
import { BCSession } from '../../src/session/bc-session.js';
import { EventDecoder } from '../../src/protocol/event-decoder.js';
import { InteractionEncoder } from '../../src/protocol/interaction-encoder.js';
import type { ReportDownloader } from '../../src/session/report-downloader.js';
import type { BCEvent } from '../../src/protocol/types.js';

function createMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function createMockEncoder() {
  return {
    encode: vi.fn(() => ({ method: 'Invoke', params: [{}] })),
    encodeOpenSession: vi.fn(() => ({ method: 'OpenSession', params: [{}] })),
  } as unknown as InteractionEncoder;
}

function createMockDecoder() {
  return {
    decode: vi.fn(() => [] as BCEvent[]),
  } as unknown as EventDecoder;
}

function createMockDownloader(overrides?: Partial<ReportDownloader>): ReportDownloader {
  return {
    download: vi.fn().mockResolvedValue({
      bytes: Buffer.from('PDF bytes'),
      contentType: 'application/pdf',
    }),
    ...overrides,
  } as unknown as ReportDownloader;
}

/**
 * Creates a mock ws that exposes setRequestHandler so BCSession can register
 * its inbound request handler, and also captures it for test invocation.
 */
function createMockWsWithRequestHandler() {
  let capturedHandler: ((method: string, params: unknown[], id: string) => Promise<unknown>) | null = null;

  const ws = {
    isConnected: true,
    spaInstanceId: 'spa-test',
    nextSequenceNo: '1',
    lastClientAckSequenceNumber: 0,
    sendRpc: vi.fn(() => Promise.resolve({ ok: true, value: [] })),
    onMessage: vi.fn(() => () => {}),
    close: vi.fn(),
    setRequestHandler: vi.fn((handler: (method: string, params: unknown[], id: string) => Promise<unknown>) => {
      capturedHandler = handler;
    }),
  };

  return {
    ws,
    invokeHandler: async (method: string, params: unknown[] = [], id = 'req-1') => {
      if (!capturedHandler) throw new Error('No request handler was registered');
      return capturedHandler(method, params, id);
    },
  };
}

describe('BCSession FileActionDialog handler', () => {
  it('registers a request handler on construction when setRequestHandler is available', () => {
    const { ws } = createMockWsWithRequestHandler();
    new BCSession(ws as any, createMockDecoder(), createMockEncoder(), createMockLogger() as any, 'default');
    expect(ws.setRequestHandler).toHaveBeenCalledOnce();
  });

  it('does NOT throw when ws has no setRequestHandler (old mock compatibility)', () => {
    const ws = {
      isConnected: true,
      spaInstanceId: 'spa-test',
      nextSequenceNo: '1',
      lastClientAckSequenceNumber: 0,
      sendRpc: vi.fn(() => Promise.resolve({ ok: true, value: [] })),
      onMessage: vi.fn(() => () => {}),
      close: vi.fn(),
      // No setRequestHandler property
    };
    expect(() => {
      new BCSession(ws as any, createMockDecoder(), createMockEncoder(), createMockLogger() as any, 'default');
    }).not.toThrow();
  });

  it('returns {IsFileAccessed:true} and captures file when reportDownloader is present', async () => {
    const downloader = createMockDownloader();
    const { ws, invokeHandler } = createMockWsWithRequestHandler();

    const session = new BCSession(
      ws as any, createMockDecoder(), createMockEncoder(),
      createMockLogger() as any, 'default', 30000, '', downloader,
    );

    const result = await invokeHandler('FileActionDialog', [{ FileName: 'report.pdf' }]);

    expect(result).toEqual({ IsFileAccessed: true, FileName: 'report.pdf' });

    const captured = session.takeLastCapturedFile();
    expect(captured).toBeDefined();
    expect(captured!.contentType).toBe('application/pdf');
    expect(captured!.fileName).toBe('report.pdf');
    expect(captured!.bytes.toString()).toBe('PDF bytes');
  });

  it('returns {IsFileAccessed:false} when no reportDownloader is provided', async () => {
    const { ws, invokeHandler } = createMockWsWithRequestHandler();
    new BCSession(ws as any, createMockDecoder(), createMockEncoder(), createMockLogger() as any, 'default');

    const result = await invokeHandler('FileActionDialog', [{ FileName: 'report.pdf' }]);
    expect(result).toEqual({ IsFileAccessed: false });
  });

  it('returns {IsFileAccessed:false} when download throws', async () => {
    const downloader = createMockDownloader({
      download: vi.fn().mockRejectedValue(new Error('HTTP 500 Internal Server Error')),
    });
    const { ws, invokeHandler } = createMockWsWithRequestHandler();
    const logger = createMockLogger();

    new BCSession(
      ws as any, createMockDecoder(), createMockEncoder(),
      logger as any, 'default', 30000, '', downloader,
    );

    const result = await invokeHandler('FileActionDialog', []);
    expect(result).toEqual({ IsFileAccessed: false });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('HTTP 500'));
  });

  it('handles FileActionDialog with no params gracefully', async () => {
    const downloader = createMockDownloader();
    const { ws, invokeHandler } = createMockWsWithRequestHandler();

    const session = new BCSession(
      ws as any, createMockDecoder(), createMockEncoder(),
      createMockLogger() as any, 'default', 30000, '', downloader,
    );

    const result = await invokeHandler('FileActionDialog', []);
    expect(result).toEqual({ IsFileAccessed: true, FileName: '' });

    const captured = session.takeLastCapturedFile();
    expect(captured).toBeDefined();
    expect(captured!.fileName).toBeUndefined();
  });

  it('returns {} for unknown inbound methods', async () => {
    const { ws, invokeHandler } = createMockWsWithRequestHandler();
    new BCSession(ws as any, createMockDecoder(), createMockEncoder(), createMockLogger() as any, 'default');

    const result = await invokeHandler('SomeUnknownMethod', [{ data: 123 }]);
    expect(result).toEqual({});
  });

  it('takeLastCapturedFile clears the stored file so the second call returns undefined', async () => {
    const downloader = createMockDownloader();
    const { ws, invokeHandler } = createMockWsWithRequestHandler();

    const session = new BCSession(
      ws as any, createMockDecoder(), createMockEncoder(),
      createMockLogger() as any, 'default', 30000, '', downloader,
    );

    await invokeHandler('FileActionDialog', [{ FileName: 'x.pdf' }]);

    const first = session.takeLastCapturedFile();
    expect(first).toBeDefined();

    const second = session.takeLastCapturedFile();
    expect(second).toBeUndefined();
  });

  it('takeLastCapturedFile returns undefined before any FileActionDialog', () => {
    const { ws } = createMockWsWithRequestHandler();
    const session = new BCSession(ws as any, createMockDecoder(), createMockEncoder(), createMockLogger() as any, 'default');
    expect(session.takeLastCapturedFile()).toBeUndefined();
  });
});
