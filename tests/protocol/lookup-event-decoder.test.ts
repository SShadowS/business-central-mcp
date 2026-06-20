import { describe, it, expect } from 'vitest';
import { EventDecoder } from '../../src/protocol/event-decoder.js';
import { HANDLER_TYPES } from '../../src/protocol/handler-types.js';

describe('EventDecoder LookupFormReady', () => {
  const decoder = new EventDecoder();

  it('decodes LookupFormReady as FormCreated with the lookup form id', () => {
    const fakeLfTree = {
      t: 'lf',
      ServerId: 'lookup-form-99',
      PageType: 1,
      Children: [],
    };
    const handlers = [{
      handlerType: HANDLER_TYPES.LogicalClientEventRaising,
      parameters: [
        'LookupFormReady',
        fakeLfTree,
        { OriginatingControl: 'server:c[0]/c[1]', OriginatingBookmark: 'bm001' },
      ],
    }];
    const events = decoder.decode(handlers);
    const formCreated = events.find(e => e.type === 'FormCreated');
    expect(formCreated).toBeDefined();
    if (formCreated?.type === 'FormCreated') {
      expect(formCreated.formId).toBe('lookup-form-99');
      expect(formCreated.controlTree).toBe(fakeLfTree);
      expect(formCreated.parentFormId).toBeUndefined();
      expect(formCreated.isReload).toBe(false);
    }
  });

  it('handles missing ServerId gracefully (emits empty-formId FormCreated)', () => {
    const handlers = [{
      handlerType: HANDLER_TYPES.LogicalClientEventRaising,
      parameters: ['LookupFormReady', { t: 'lf', PageType: 1 }, {}],
    }];
    const events = decoder.decode(handlers);
    const formCreated = events.find(e => e.type === 'FormCreated');
    expect(formCreated).toBeDefined();
    if (formCreated?.type === 'FormCreated') {
      expect(formCreated.formId).toBe('');
    }
  });
});
