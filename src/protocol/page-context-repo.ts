import type { PageState, BCEvent } from './types.js';
import { StateProjection } from './state-projection.js';

export class PageContextRepository {
  private readonly pages = new Map<string, PageState>();
  private readonly formIdIndex = new Map<string, string>();

  constructor(private readonly projection: StateProjection) {}

  get(pageContextId: string): PageState | undefined {
    return this.pages.get(pageContextId);
  }

  getByFormId(formId: string): PageState | undefined {
    const id = this.formIdIndex.get(formId);
    return id ? this.pages.get(id) : undefined;
  }

  create(pageContextId: string, formId: string): PageState {
    const state = this.projection.createInitial(pageContextId, formId);
    this.pages.set(pageContextId, state);
    this.formIdIndex.set(formId, pageContextId);
    return state;
  }

  applyToPage(pageContextId: string, events: BCEvent[]): PageState | undefined {
    const state = this.pages.get(pageContextId);
    if (!state) return undefined;
    const updated = this.projection.apply(state, events);
    this.pages.set(pageContextId, updated);
    for (const fId of updated.openFormIds) {
      if (!this.formIdIndex.has(fId)) this.formIdIndex.set(fId, pageContextId);
    }
    return updated;
  }

  applyEvents(events: BCEvent[]): void {
    const grouped = new Map<string, BCEvent[]>();
    for (const event of events) {
      const formId = 'formId' in event ? (event as { formId: string }).formId : undefined;
      if (!formId) continue;
      const pcId = this.formIdIndex.get(formId);
      if (!pcId) continue;
      let group = grouped.get(pcId);
      if (!group) { group = []; grouped.set(pcId, group); }
      group.push(event);
    }
    for (const [pcId, group] of grouped) {
      this.applyToPage(pcId, group);
    }
  }

  remove(pageContextId: string): void {
    const state = this.pages.get(pageContextId);
    if (state) {
      for (const fId of state.openFormIds) this.formIdIndex.delete(fId);
      this.formIdIndex.delete(state.formId);
    }
    this.pages.delete(pageContextId);
  }

  listPageContextIds(): string[] { return Array.from(this.pages.keys()); }
  get size(): number { return this.pages.size; }
}
