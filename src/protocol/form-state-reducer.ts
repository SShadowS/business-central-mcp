// src/protocol/form-state-reducer.ts
//
// Thin adapter around FormProjection that gives it a named role in the CQRS
// split. `FormStateReducer.apply` takes a FormState and a BCEvent and returns
// a (possibly new) FormState — pure reduction with no side effects.
//
// FormProjection is still the implementation; this file just surfaces it under
// the "reducer" name so callers can depend on the right abstraction layer.
import { FormProjection } from './form-state.js';
import type { FormState } from './form-state.js';
import type { BCEvent } from './types.js';

export { FormState };

export class FormStateReducer {
  private readonly projection = new FormProjection();

  /** Create a blank FormState for the given formId (no BC events applied yet). */
  createInitial(formId: string, parentFormId?: string): FormState {
    return this.projection.createInitial(formId, parentFormId);
  }

  /**
   * Apply a single BCEvent to a FormState. Returns the same reference if the
   * event produced no change (structural sharing), or a new object with only
   * the affected nodes replaced.
   */
  apply(form: FormState, event: BCEvent): FormState {
    return this.projection.apply(form, event);
  }
}
