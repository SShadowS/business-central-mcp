// src/session/modal-stack.ts
//
// Tracks the open modal-form chain server-side. BC's web server holds a
// LogicalDispatcher.Frames stack (decompiled
// Microsoft.Dynamics.Framework.UI.LogicalDispatcher); to clear an orphaned
// modal we must close the topmost frame. The ModalStack mirrors that
// ordering on the client side so reconciliation can walk the stack from top
// to bottom. Each entry keeps the dialog's wire `MappingHint`, which tells
// reconciliation whether closing it is safe (see `BCSession.reconcileModalStack`).

export class ModalStack {
  private readonly entries: Array<{ formId: string; mappingHint?: string }> = [];

  get size(): number {
    return this.entries.length;
  }

  push(formId: string, mappingHint?: string): void {
    if (!formId) return;
    if (this.entries.some(e => e.formId === formId)) return; // dedupe -- DialogOpened may fire twice in some envs
    this.entries.push({ formId, mappingHint });
  }

  pop(): string | undefined {
    return this.entries.pop()?.formId;
  }

  peek(): string | undefined {
    return this.entries[this.entries.length - 1]?.formId;
  }

  mappingHintOf(formId: string): string | undefined {
    return this.entries.find(e => e.formId === formId)?.mappingHint;
  }

  remove(formId: string): void {
    const ix = this.entries.findIndex(e => e.formId === formId);
    if (ix >= 0) this.entries.splice(ix, 1);
  }

  clear(): void {
    this.entries.length = 0;
  }

  snapshot(): string[] {
    return this.entries.map(e => e.formId);
  }
}
