import { describe, it, expect, vi } from 'vitest';
import { PageService, DEFAULT_AUTO_LOAD_SECTIONS } from '../../src/services/page-service.js';

describe('PageService autoLoadSections config', () => {
  it('DEFAULT_AUTO_LOAD_SECTIONS includes header, lines, and subpage', () => {
    expect(DEFAULT_AUTO_LOAD_SECTIONS).toEqual(['header', 'lines', 'subpage', 'factbox']);
  });

  it('accepts custom autoLoadSections via options', () => {
    // We cannot easily test the full openPage flow without a real session,
    // but we can verify the constructor accepts the config and stores it.
    // Use a mock session and repo to instantiate.
    const mockSession = {} as any;
    const mockRepo = {} as any;
    const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any;

    // Default config
    const defaultService = new PageService(mockSession, mockRepo, mockLogger);
    expect((defaultService as any).autoLoadSections).toEqual(['header', 'lines', 'subpage', 'factbox']);

    // Custom config: only load header
    const headerOnly = new PageService(mockSession, mockRepo, mockLogger, {
      autoLoadSections: ['header'],
    });
    expect((headerOnly as any).autoLoadSections).toEqual(['header']);

    // Custom config: load everything including factboxes
    const withFactboxes = new PageService(mockSession, mockRepo, mockLogger, {
      autoLoadSections: ['header', 'lines', 'subpage', 'factbox'],
    });
    expect((withFactboxes as any).autoLoadSections).toEqual(['header', 'lines', 'subpage', 'factbox']);

    // Custom config: empty (skip all child form loading)
    const skipAll = new PageService(mockSession, mockRepo, mockLogger, {
      autoLoadSections: [],
    });
    expect((skipAll as any).autoLoadSections).toEqual([]);
  });
});
