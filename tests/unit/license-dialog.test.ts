// tests/unit/license-dialog.test.ts
import { describe, it, expect } from 'vitest';
import type { BCEvent } from '../../src/protocol/types.js';
import { findLicenseDialog } from '../../src/session/license-dialog.js';

function dialog(controlTree: Record<string, unknown>): BCEvent {
  return { type: 'DialogOpened', formId: 'f1', controlTree } as BCEvent;
}

describe('findLicenseDialog', () => {
  it('finds a dialog whose Caption contains "license"', () => {
    const events: BCEvent[] = [dialog({ Caption: 'Your License is about to expire' })];
    expect(findLicenseDialog(events)).toBe(events[0]);
  });

  it('finds a dialog whose Caption contains "evaluation"', () => {
    const events: BCEvent[] = [dialog({ Caption: 'This is an Evaluation version' })];
    expect(findLicenseDialog(events)).toBe(events[0]);
  });

  it('finds a dialog whose Caption contains "trial"', () => {
    const events: BCEvent[] = [dialog({ Caption: 'Your Trial period has ended' })];
    expect(findLicenseDialog(events)).toBe(events[0]);
  });

  it('finds a dialog whose Message contains "license"', () => {
    const events: BCEvent[] = [dialog({ Message: 'Please renew your license' })];
    expect(findLicenseDialog(events)).toBe(events[0]);
  });

  it('finds a dialog whose Message contains "evaluation"', () => {
    const events: BCEvent[] = [dialog({ Message: 'Running in evaluation mode' })];
    expect(findLicenseDialog(events)).toBe(events[0]);
  });

  it('finds a dialog whose Message contains "trial"', () => {
    const events: BCEvent[] = [dialog({ Message: 'Start your free trial today' })];
    expect(findLicenseDialog(events)).toBe(events[0]);
  });

  it('matches the lowercase "caption" key variant', () => {
    const events: BCEvent[] = [dialog({ caption: 'License expiry warning' })];
    expect(findLicenseDialog(events)).toBe(events[0]);
  });

  it('matches the lowercase "message" key variant', () => {
    const events: BCEvent[] = [dialog({ message: 'Your trial is over' })];
    expect(findLicenseDialog(events)).toBe(events[0]);
  });

  it('returns undefined when no DialogOpened event matches', () => {
    const events: BCEvent[] = [dialog({ Caption: 'Edit Customer Card', Message: 'Save changes?' })];
    expect(findLicenseDialog(events)).toBeUndefined();
  });

  it('returns undefined when matching words appear in a non-DialogOpened event', () => {
    const events: BCEvent[] = [
      {
        type: 'MessageToShow',
        formId: '',
        text: 'Your license has expired',
        messageType: 'Warning',
        actions: ['Ok'],
      } as BCEvent,
    ];
    expect(findLicenseDialog(events)).toBeUndefined();
  });

  it('returns undefined for an empty event list', () => {
    expect(findLicenseDialog([])).toBeUndefined();
  });
});
