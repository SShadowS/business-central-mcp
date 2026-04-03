import { describe, it, expect } from 'vitest';
import { EventDecoder } from '../../src/protocol/event-decoder.js';
import { HANDLER_TYPES } from '../../src/protocol/handler-types.js';

describe('EventDecoder', () => {
  const decoder = new EventDecoder();

  it('decodes DataRefreshChange from LogicalClientChangeHandler', () => {
    const handlers = [{
      handlerType: HANDLER_TYPES.LogicalClientChange,
      parameters: ['formId123', [{
        t: 'DataRefreshChange',
        ControlReference: { controlPath: 'server:c[1]' },
        HasSortingChanged: false,
        CurrentRowOnly: false,
        RowChanges: [
          { t: 'DataRowInserted', DataRowInserted: [0, { cells: { 'No.': '10000' } }] },
        ],
      }]],
    }];
    const events = decoder.decode(handlers);
    const dataLoaded = events.find(e => e.type === 'DataLoaded');
    expect(dataLoaded).toBeDefined();
    expect(dataLoaded!.formId).toBe('formId123');
    if (dataLoaded?.type === 'DataLoaded') {
      expect(dataLoaded.currentRowOnly).toBe(false);
      expect(dataLoaded.rows.length).toBe(1);
    }
  });

  it('decodes PropertyChanges', () => {
    const handlers = [{
      handlerType: HANDLER_TYPES.LogicalClientChange,
      parameters: ['formId456', [{
        t: 'PropertyChanges',
        ControlReference: { controlPath: 'server:c[2]/c[0]/c[3]' },
        Changes: { StringValue: 'Hello', Editable: true },
      }]],
    }];
    const events = decoder.decode(handlers);
    const propChanged = events.find(e => e.type === 'PropertyChanged');
    expect(propChanged).toBeDefined();
    if (propChanged?.type === 'PropertyChanged') {
      expect(propChanged.formId).toBe('formId456');
      expect(propChanged.controlPath).toBe('server:c[2]/c[0]/c[3]');
      expect(propChanged.changes['StringValue']).toBe('Hello');
    }
  });

  it('decodes CallbackResponseProperties', () => {
    const handlers = [{
      handlerType: HANDLER_TYPES.CallbackResponseProperties,
      parameters: [{
        SequenceNumber: 42,
        CompletedInteractions: [{ InvocationId: 'cb-001', Duration: 150 }],
      }],
    }];
    const events = decoder.decode(handlers);
    const completed = events.find(e => e.type === 'InvokeCompleted');
    expect(completed).toBeDefined();
    if (completed?.type === 'InvokeCompleted') {
      expect(completed.sequenceNumber).toBe(42);
      expect(completed.completedInteractions[0]!.invocationId).toBe('cb-001');
    }
  });

  it('decodes FormToShow event', () => {
    const handlers = [{
      handlerType: HANDLER_TYPES.LogicalClientEventRaising,
      parameters: ['FormToShow', { formId: 'newForm789', ParentForm: 'parentForm123', IsReload: false }, {}],
    }];
    const events = decoder.decode(handlers);
    const formCreated = events.find(e => e.type === 'FormCreated');
    expect(formCreated).toBeDefined();
    if (formCreated?.type === 'FormCreated') {
      expect(formCreated.formId).toBe('newForm789');
      expect(formCreated.parentFormId).toBe('parentForm123');
    }
  });

  it('decodes DialogToShow event', () => {
    const handlers = [{
      handlerType: HANDLER_TYPES.LogicalClientEventRaising,
      parameters: ['DialogToShow', { formId: 'dialog001', OwnerForm: 'owner123' }, {}],
    }];
    const events = decoder.decode(handlers);
    const dialogOpened = events.find(e => e.type === 'DialogOpened');
    expect(dialogOpened).toBeDefined();
    if (dialogOpened?.type === 'DialogOpened') {
      expect(dialogOpened.ownerFormId).toBe('owner123');
    }
  });

  it('decodes BookmarkChanged (DataRowBookmarkChange)', () => {
    const handlers = [{
      handlerType: HANDLER_TYPES.LogicalClientChange,
      parameters: ['formId999', [{
        t: 'DataRowBookmarkChange',
        ControlReference: { controlPath: 'server:c[1]' },
        Bookmark: 'bookmark123',
      }]],
    }];
    const events = decoder.decode(handlers);
    const bookmark = events.find(e => e.type === 'BookmarkChanged');
    expect(bookmark).toBeDefined();
    if (bookmark?.type === 'BookmarkChanged') expect(bookmark.bookmark).toBe('bookmark123');
  });

  it('handles abbreviated change types (drch)', () => {
    const handlers = [{
      handlerType: HANDLER_TYPES.LogicalClientChange,
      parameters: ['formId', [{
        t: 'drch',
        ControlReference: { controlPath: 'server:c[1]' },
        CurrentRowOnly: false,
        RowChanges: [],
      }]],
    }];
    const events = decoder.decode(handlers);
    expect(events.find(e => e.type === 'DataLoaded')).toBeDefined();
  });

  it('handles abbreviated PropertyChanges (lcpchs)', () => {
    const handlers = [{
      handlerType: HANDLER_TYPES.LogicalClientChange,
      parameters: ['formId', [{
        t: 'lcpchs',
        ControlReference: { controlPath: 'c[0]' },
        Changes: { Caption: 'Test' },
      }]],
    }];
    const events = decoder.decode(handlers);
    expect(events.find(e => e.type === 'PropertyChanged')).toBeDefined();
  });

  it('skips unknown handler types', () => {
    const handlers = [{ handlerType: 'DN.UnknownHandler', parameters: [] }];
    expect(decoder.decode(handlers)).toEqual([]);
  });

  it('handles single PropertyChange (lcpch)', () => {
    const handlers = [{
      handlerType: HANDLER_TYPES.LogicalClientChange,
      parameters: ['formId', [{
        t: 'lcpch',
        ControlReference: { controlPath: 'c[0]' },
        PropertyName: 'Visible',
        PropertyValue: false,
      }]],
    }];
    const events = decoder.decode(handlers);
    const prop = events.find(e => e.type === 'PropertyChanged');
    expect(prop).toBeDefined();
    if (prop?.type === 'PropertyChanged') expect(prop.changes['Visible']).toBe(false);
  });

  it('decodes ClosePendingForm as FormClosed event', () => {
    const handlers = [{
      handlerType: HANDLER_TYPES.LogicalClientEventRaising,
      parameters: ['ClosePendingForm', { ServerId: 'closedForm123' }, {}],
    }];
    const events = decoder.decode(handlers);
    const closed = events.find(e => e.type === 'FormClosed');
    expect(closed).toBeDefined();
    if (closed?.type === 'FormClosed') {
      expect(closed.formId).toBe('closedForm123');
    }
  });
});
