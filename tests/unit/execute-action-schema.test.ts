// tests/unit/execute-action-schema.test.ts
//
// Tests for ExecuteActionSchema's `bookmarks[]` multi-row selection field:
//   1. bookmarks[] alongside an action is accepted.
//   2. bookmarks[] + bookmark is rejected (mutually exclusive).
//   3. bookmarks[] + cue is rejected (mutually exclusive).
//   4. The existing action-XOR-cue rule still holds (neither / both).

import { describe, it, expect } from 'vitest';
import { ExecuteActionSchema } from '../../src/mcp/schemas.js';

describe('ExecuteActionSchema bookmarks', () => {
  it('accepts bookmarks[] with an action', () => {
    expect(ExecuteActionSchema.safeParse({ pageContextId: 'p', action: 'Delete', bookmarks: ['A', 'B'] }).success).toBe(true);
  });

  it('rejects bookmarks together with bookmark', () => {
    expect(ExecuteActionSchema.safeParse({ pageContextId: 'p', action: 'Delete', bookmarks: ['A'], bookmark: 'A' }).success).toBe(false);
  });

  it('rejects bookmarks together with rowIndex', () => {
    expect(ExecuteActionSchema.safeParse({ pageContextId: 'p', action: 'Delete', bookmarks: ['A'], rowIndex: 0 }).success).toBe(false);
  });

  it('rejects bookmarks together with cue', () => {
    expect(ExecuteActionSchema.safeParse({ pageContextId: 'p', cue: 'X', section: 's', bookmarks: ['A'] }).success).toBe(false);
  });

  it('still rejects when neither action nor cue is provided', () => {
    expect(ExecuteActionSchema.safeParse({ pageContextId: 'p' }).success).toBe(false);
  });

  it('still rejects when both action and cue are provided', () => {
    expect(ExecuteActionSchema.safeParse({ pageContextId: 'p', action: 'Post', cue: 'X', section: 's' }).success).toBe(false);
  });
});
