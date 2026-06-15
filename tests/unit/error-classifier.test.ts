import { describe, it, expect } from 'vitest';
import { classifyBusinessError } from '../../src/protocol/error-classifier.js';
import type { BCEvent } from '../../src/protocol/types.js';
import type { BusinessValidationError, BusinessError } from '../../src/core/errors.js';

// Helper: build a PropertyChanged event carrying ValidationResults
function makeValidationEvent(items: Array<{
  Id: number;
  Description: string;
  Severity: 'Error' | 'Warning' | 'Info';
  DescriptionShort?: string;
  OriginatingControl?: { controlPath: string; formId: string };
}>): BCEvent {
  return {
    type: 'PropertyChanged',
    formId: 'f1',
    controlPath: 'server:c[0]',
    changes: { ValidationResults: items },
  };
}

describe('classifyBusinessError', () => {
  describe('ValidationResults', () => {
    it('returns BusinessValidationError when Severity Error item present', () => {
      const events: BCEvent[] = [
        makeValidationEvent([
          {
            Id: 1,
            Description: 'The value must be positive.',
            Severity: 'Error',
            DescriptionShort: 'Enter a positive number.',
            OriginatingControl: { controlPath: 'server:c[2]/c[0]', formId: 'f1' },
          },
        ]),
      ];
      const result = classifyBusinessError(events);
      expect(result).not.toBeNull();
      expect(result!.code).toBe('VALIDATION_ERROR');
      expect(result!.constructor.name).toBe('BusinessValidationError');
      // Cast to access fieldErrors
      const vErr = result as BusinessValidationError;
      expect(vErr.fieldErrors).toHaveLength(1);
      expect(vErr.fieldErrors[0]!.description).toBe('The value must be positive.');
      expect(vErr.fieldErrors[0]!.field).toBe('server:c[2]/c[0]');
      expect(vErr.fieldErrors[0]!.descriptionShort).toBe('Enter a positive number.');
    });

    it('returns null when only Warning/Info ValidationResults present', () => {
      const events: BCEvent[] = [
        makeValidationEvent([
          { Id: 2, Description: 'This is a warning.', Severity: 'Warning' },
          { Id: 3, Description: 'This is info.', Severity: 'Info' },
        ]),
      ];
      expect(classifyBusinessError(events)).toBeNull();
    });

    it('handles item without OriginatingControl (field is undefined)', () => {
      const events: BCEvent[] = [
        makeValidationEvent([
          { Id: 10, Description: 'Generic error.', Severity: 'Error' },
        ]),
      ];
      const result = classifyBusinessError(events);
      expect(result).not.toBeNull();
      const vErr = result as BusinessValidationError;
      expect(vErr.fieldErrors[0]!.field).toBeUndefined();
    });

    it('deduplicates validation items by Id across multiple PropertyChanged events', () => {
      const item = { Id: 99, Description: 'Dup error.', Severity: 'Error' as const };
      const events: BCEvent[] = [
        makeValidationEvent([item]),
        makeValidationEvent([item]),
      ];
      const result = classifyBusinessError(events);
      const vErr = result as BusinessValidationError;
      expect(vErr.fieldErrors).toHaveLength(1);
    });
  });

  describe('MessageToShow', () => {
    it('returns BusinessError for messageType Error', () => {
      const events: BCEvent[] = [
        {
          type: 'MessageToShow',
          formId: '',
          text: 'You cannot delete this record.',
          messageType: 'Error',
          actions: ['Ok'],
          defaultAction: 'Ok',
        },
      ];
      const result = classifyBusinessError(events);
      expect(result).not.toBeNull();
      expect(result!.code).toBe('BUSINESS_ERROR');
      expect(result!.constructor.name).toBe('BusinessError');
      const bErr = result as BusinessError;
      expect(bErr.bcText).toBe('You cannot delete this record.');
      expect(bErr.source).toBe('message');
    });

    it('returns BusinessError for messageType Fatal', () => {
      const events: BCEvent[] = [
        {
          type: 'MessageToShow',
          formId: '',
          text: 'Fatal error occurred.',
          messageType: 'Fatal',
          actions: ['Ok'],
          defaultAction: 'Ok',
        },
      ];
      const result = classifyBusinessError(events);
      expect(result).not.toBeNull();
      expect(result!.code).toBe('BUSINESS_ERROR');
      const bErr = result as BusinessError;
      expect(bErr.bcText).toBe('Fatal error occurred.');
      expect(bErr.source).toBe('message');
    });

    it('returns null for messageType Warning only', () => {
      const events: BCEvent[] = [
        {
          type: 'MessageToShow',
          formId: '',
          text: 'Just a warning.',
          messageType: 'Warning',
          actions: ['Ok'],
          defaultAction: 'Ok',
        },
      ];
      expect(classifyBusinessError(events)).toBeNull();
    });

    it('returns null for messageType Info only', () => {
      const events: BCEvent[] = [
        {
          type: 'MessageToShow',
          formId: '',
          text: 'Just info.',
          messageType: 'Info',
          actions: ['Ok'],
          defaultAction: 'Ok',
        },
      ];
      expect(classifyBusinessError(events)).toBeNull();
    });
  });

  describe('error DialogOpened', () => {
    it('returns BusinessError with source dialog from MappingHint ErrorDialog (Message field)', () => {
      const events: BCEvent[] = [
        {
          type: 'DialogOpened',
          formId: 'dlg1',
          controlTree: {
            MappingHint: 'ErrorDialog',
            Caption: 'Error',
            Message: 'Something went wrong.',
          },
        },
      ];
      const result = classifyBusinessError(events);
      expect(result).not.toBeNull();
      expect(result!.code).toBe('BUSINESS_ERROR');
      const bErr = result as BusinessError;
      expect(bErr.source).toBe('dialog');
      expect(bErr.bcText).toBe('Something went wrong.');
    });

    it('falls back to Caption when Message absent', () => {
      const events: BCEvent[] = [
        {
          type: 'DialogOpened',
          formId: 'dlg2',
          controlTree: {
            MappingHint: 'ErrorDialog',
            Caption: 'The record cannot be processed.',
          },
        },
      ];
      const result = classifyBusinessError(events);
      expect(result).not.toBeNull();
      const bErr = result as BusinessError;
      expect(bErr.source).toBe('dialog');
      expect(bErr.bcText).toBe('The record cannot be processed.');
    });

    it('uses a fallback bcText when ErrorDialog has neither Message nor Caption', () => {
      const events: BCEvent[] = [
        {
          type: 'DialogOpened',
          formId: 'dlg-empty',
          controlTree: { MappingHint: 'ErrorDialog' },
        },
      ];
      const result = classifyBusinessError(events);
      expect(result).not.toBeNull();
      const bErr = result as BusinessError;
      expect(bErr.source).toBe('dialog');
      expect(bErr.bcText).toBe('(BC raised an error dialog with no message text)');
    });

    it('ignores non-error dialogs (no MappingHint or different hint)', () => {
      const events: BCEvent[] = [
        {
          type: 'DialogOpened',
          formId: 'dlg3',
          controlTree: { MappingHint: 'RequestPage', Caption: 'Report Options' },
        },
      ];
      expect(classifyBusinessError(events)).toBeNull();
    });

    it('is defensive when controlTree is null/undefined', () => {
      const events: BCEvent[] = [
        { type: 'DialogOpened', formId: 'dlg4', controlTree: null },
      ];
      expect(classifyBusinessError(events)).toBeNull();
    });

    it('is defensive when controlTree is a non-object primitive', () => {
      const events: BCEvent[] = [
        { type: 'DialogOpened', formId: 'dlg5', controlTree: 42 },
      ];
      expect(classifyBusinessError(events)).toBeNull();
    });
  });

  describe('clean events', () => {
    it('returns null for normal PropertyChanged, FormCreated, InvokeCompleted', () => {
      const events: BCEvent[] = [
        {
          type: 'FormCreated',
          formId: 'f1',
          controlTree: { t: 'lf', Caption: 'Customer List' },
        },
        {
          type: 'PropertyChanged',
          formId: 'f1',
          controlPath: 'server:c[0]',
          changes: { StringValue: 'Contoso' },
        },
        { type: 'InvokeCompleted', sequenceNumber: 1, completedInteractions: [] },
      ];
      expect(classifyBusinessError(events)).toBeNull();
    });
  });

  describe('precedence', () => {
    it('validation wins over MessageToShow Error when both present', () => {
      const events: BCEvent[] = [
        makeValidationEvent([
          { Id: 5, Description: 'Field is required.', Severity: 'Error' },
        ]),
        {
          type: 'MessageToShow',
          formId: '',
          text: 'Operation aborted.',
          messageType: 'Error',
          actions: ['Ok'],
          defaultAction: 'Ok',
        },
      ];
      const result = classifyBusinessError(events);
      expect(result).not.toBeNull();
      expect(result!.code).toBe('VALIDATION_ERROR');
      expect(result!.constructor.name).toBe('BusinessValidationError');
    });
  });
});
