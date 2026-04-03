// src/protocol/form-state.ts
import type { ControlField, RepeaterState, ActionInfo, ControlContainerType } from './types.js';

export interface FormState {
  readonly formId: string;
  readonly parentFormId?: string;
  readonly controlTree: ControlField[];
  readonly repeaters: ReadonlyMap<string, RepeaterState>;
  readonly actions: ActionInfo[];
  readonly filterControlPath: string | null;
  readonly containerType?: ControlContainerType;
}

/** Returns the first (and usually only) repeater, or null. */
export function primaryRepeater(form: FormState): RepeaterState | null {
  const first = form.repeaters.values().next();
  return first.done ? null : first.value;
}

/** Returns the repeater matching a controlPath, or the primary. */
export function resolveRepeater(form: FormState, controlPath?: string): RepeaterState | null {
  if (controlPath) return form.repeaters.get(controlPath) ?? null;
  return primaryRepeater(form);
}
