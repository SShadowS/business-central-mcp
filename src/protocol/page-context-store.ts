// src/protocol/page-context-store.ts
//
// Pure storage layer for page contexts: owns the `pages` Map and the
// formId → pageContextId index. Contains no event logic, no state reduction,
// and no BC protocol knowledge.
import type { PageContext } from './page-context.js';

export class PageContextStore {
  private readonly pages = new Map<string, PageContext>();
  private readonly formIdIndex = new Map<string, string>();  // formId -> pageContextId

  get(pageContextId: string): PageContext | undefined {
    return this.pages.get(pageContextId);
  }

  getByFormId(formId: string): PageContext | undefined {
    const id = this.formIdIndex.get(formId);
    return id ? this.pages.get(id) : undefined;
  }

  lookupPcId(formId: string): string | undefined {
    return this.formIdIndex.get(formId);
  }

  has(pageContextId: string): boolean {
    return this.pages.has(pageContextId);
  }

  set(pageContextId: string, page: PageContext): void {
    this.pages.set(pageContextId, page);
  }

  delete(pageContextId: string): boolean {
    return this.pages.delete(pageContextId);
  }

  /** Index a formId as belonging to the given pageContextId. */
  indexFormId(formId: string, pageContextId: string): void {
    this.formIdIndex.set(formId, pageContextId);
  }

  /** Remove a formId from the index (on page removal). */
  deindexFormId(formId: string): void {
    this.formIdIndex.delete(formId);
  }

  /** Remove all form IDs owned by the given page from the index, then delete the page. */
  removePage(pageContextId: string): void {
    const page = this.pages.get(pageContextId);
    if (page) {
      for (const fId of page.ownedFormIds) this.formIdIndex.delete(fId);
    }
    this.pages.delete(pageContextId);
  }

  clear(): void {
    this.pages.clear();
    this.formIdIndex.clear();
  }

  listPageContextIds(): string[] {
    return Array.from(this.pages.keys());
  }

  listPageContextSummaries(): Array<{ id: string; caption: string }> {
    return Array.from(this.pages.entries()).map(([id, ctx]) => ({
      id,
      caption: ctx.caption || `Page (${ctx.pageType})`,
    }));
  }

  get size(): number {
    return this.pages.size;
  }
}
