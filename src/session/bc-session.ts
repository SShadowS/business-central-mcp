import { v4 as uuid } from 'uuid';
import { ok, err, isOk, isErr, type Result } from '../core/result.js';
import { ProtocolError, TimeoutError, ModalReconcileError } from '../core/errors.js';
import type { BCWebSocket } from '../connection/bc-websocket.js';
import { SystemAction, type BCEvent, type BCInteraction, type EventPredicate, type PropertyChangedEvent } from '../protocol/types.js';
import { EventDecoder } from '../protocol/event-decoder.js';
import { InteractionEncoder, type EncodeContext } from '../protocol/interaction-encoder.js';
import { decompressPayload } from '../protocol/decompression.js';
import type { Logger } from '../core/logger.js';
import { ModalStack } from './modal-stack.js';
import { isFatalRpcError } from './rpc-error-classifier.js';
import { findLicenseDialog } from './license-dialog.js';
import { resolveFormatLabel } from './report-format-resolver.js';
import { buildFormTree } from '../protocol/form-tree-builder.js';
import { walkTree } from '../protocol/form-tree-walk.js';
import { isFormClosedChange } from '../protocol/replay-safety.js';
import { isHostedPartChange } from '../protocol/form-state.js';
import { watchLiveness, parseIsExecutingAnswer, type LivenessVerdict, type ProbeAnswer } from './isexecuting-poller.js';

const DEFAULT_TIMEOUT_MS = 30000;
const QUIESCENCE_MS = 150; // Trailing window for async Message bursts
// Re-probe delay before declaring a wedge: IsExecuting flips to false BEFORE a
// large response frame is flushed (Gate A), so one false is not conclusive.
const WEDGE_CONFIRM_MS = 2000;
// sendRpc's own deadline sits past the ceiling so the RPC layer never races
// the watchdog's verdict.
const RPC_GRACE_MS = 5000;
// Dialogs reconcileModalStack may CloseForm: their close reads as a refusal.
// MessageForm dialogs (Confirm/Info/Error) preset DialogResult=Ok, which
// MessageHelper.ShowMessageForm reads as "not Yes" (decompiled MessageForm.
// CreateMessageDialogCore). NavRequestPage closes with CancelClose and turns a
// null result into Cancel (NavRequestPage.OnFormClosing).
const SAFE_RECONCILE_HINTS: ReadonlySet<string> = new Set(['ConfirmDialog', 'InfoDialog', 'ErrorDialog', 'RequestPage']);

/**
 * A form's own validation state: BC observes the form's validation holder like
 * any control's (LogicalControlObserver.OnValidationResultsChanged) and sends
 * `ValidationResults` on its `server:` path, aggregated over its fields; an
 * empty array clears it (live cronus29, report 6 request page). Returns
 * undefined when the event says nothing about the form's errors.
 */
function formHasErrors(event: PropertyChangedEvent): boolean | undefined {
  if (event.controlPath !== 'server:' || isHostedPartChange(event)) return undefined;
  const results = event.changes['ValidationResults'];
  if (results === undefined) return undefined;
  return Array.isArray(results) && results.some(r => (r as { Severity?: unknown } | null)?.Severity === 'Error');
}

export interface InvokeLiveness {
  /** Silence tolerated before probing IsExecuting (BC_ISEXECUTING_POLL_INTERVAL). */
  pollIntervalMs: number;
  /** Absolute ceiling per invoke, even while IsExecuting is true (BC_INVOKE_MAX_DURATION). */
  maxDurationMs: number;
}

export const DEFAULT_LIVENESS: InvokeLiveness = { pollIntervalMs: 10_000, maxDurationMs: 600_000 };

const VERDICT_MESSAGES: Record<LivenessVerdict, (ceilingMs: number) => string> = {
  wedged: () => 'BC reported it stopped processing (IsExecuting=false) but the operation did not return. '
    + 'Session killed. The operation may have committed server-side -- verify before retrying.',
  ceiling: (ms) => `Operation exceeded the ${ms / 1000}s cap while BC was still processing. Session killed. `
    + 'The operation may have committed server-side -- verify before retrying. '
    + 'Raise BC_INVOKE_MAX_DURATION if this operation is legitimately this slow.',
  'transport-dead': () => 'The connection stopped answering IsExecuting probes. Session killed and will reconnect on next request.',
};

export class BCSession {
  private queue: Promise<void> = Promise.resolve();
  private readonly _openFormIds = new Set<string>();
  private readonly modalStack = new ModalStack();
  /** Open forms whose own ValidationResults hold an error (`formHasErrors`). */
  private readonly formsWithErrors = new Set<string>();
  private dead = false;
  /**
   * Receives the FormClosed of each dialog a modal reconcile aborts. Set by
   * SessionManager to PageContextRepository.applyEvents: the reconcile runs
   * inside whatever invoke hit LogicalModalityViolation, and not every caller
   * applies its invoke result to the repository (run_report, search).
   */
  onReconciledClose?: (closed: BCEvent[]) => void;
  private wsClosed = false;

  private sessionId = '';
  private sessionKey = '';
  private company = '';
  private _initialized = false;

  constructor(
    private readonly ws: BCWebSocket,
    private readonly decoder: EventDecoder,
    private readonly encoder: InteractionEncoder,
    private readonly logger: Logger,
    private readonly tenantId: string,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
    private readonly profile: string = '',
    private readonly liveness: InvokeLiveness = DEFAULT_LIVENESS,
  ) {
    if (typeof this.ws.setRequestHandler === 'function') {
      // Safe default handler for any server-initiated inbound JSON-RPC request.
      // BC's web-client protocol (/csh) does NOT send the FileActionDialog
      // callback used by the StreamJsonRpc /ws/connect path: report downloads
      // arrive INLINE as a UriToShow -> FileDownloadReady event in the invoke
      // callback response (see runReportWithDownload). We still register a
      // catch-all so that if BC ever does issue an inbound request, we reply
      // promptly with an empty result instead of letting it block server-side
      // execution waiting on a response. Returning {} is intentional, not a stub.
      this.ws.setRequestHandler(async (method, _params) => {
        this.logger.debug('protocol', `Inbound request: method=${method} (acked with empty result; /csh has no inbound handlers)`);
        return {};
      });
    }
  }

  get openFormIds(): ReadonlySet<string> {
    return this._openFormIds;
  }

  get isInitialized(): boolean {
    return this._initialized;
  }

  get companyName(): string {
    return this.company;
  }

  /**
   * The ServerSessionId BC assigned at OpenSession. BC also uses this value as
   * the `sessionid=` handler-session id on download/img/upload URLs, so the file
   * upload path needs it to build the DynamicFileUploadHandler URL.
   */
  get serverSessionId(): string {
    return this.sessionId;
  }

  /** The tenant this session is bound to — used as the default for page opens. */
  get boundTenantId(): string {
    return this.tenantId;
  }

  get isAlive(): boolean {
    return !this.dead && this.ws.isConnected;
  }

  /**
   * Send an OpenSession RPC and process its response (decode events, wait for
   * the async-message quiescence window, extract session credentials). Shared
   * by `initialize` (first connect) and `changeCompany` (company re-bind).
   * Does NOT touch form tracking or `_initialized`; the caller owns that so it
   * can decide whether to reset stale form state (re-bind) or not (first open).
   */
  private async sendOpenSession(
    tenantId: string,
    company?: string,
  ): Promise<Result<BCEvent[], ProtocolError>> {
    const openSessionCall = this.encoder.encodeOpenSession(tenantId, this.ws.spaInstanceId, this.profile, company);

    this.logger.debug('protocol', company ? `Sending OpenSession (company=${company})` : 'Sending OpenSession');
    const rpcResult = await this.ws.sendRpc(openSessionCall.method, openSessionCall.params, this.timeoutMs);
    if (isErr(rpcResult)) return rpcResult;

    const responseData = rpcResult.value;
    const events: BCEvent[] = Array.isArray(responseData) ? this.decoder.decode(responseData) : [];

    // Wait for async messages
    await new Promise(resolve => setTimeout(resolve, QUIESCENCE_MS));

    // Extract session credentials from response (recursively searches for fields)
    this.extractSessionCredentials(responseData);

    return ok(events);
  }

  async initialize(tenantId: string): Promise<Result<BCEvent[], ProtocolError>> {
    const openResult = await this.sendOpenSession(tenantId);
    if (isErr(openResult)) return openResult;
    const events = this.updateFormTracking(openResult.value);

    this._initialized = true;

    // Auto-dismiss license notification dialogs (present on fresh/evaluation databases)
    await this.dismissLicenseDialog(events);

    this.logger.info(`Session initialized: ${this.sessionId}, company: ${this.company}`);

    return ok(events);
  }

  /**
   * Switch the session to a different company. BC binds a session to a company
   * only at OpenSession time -- neither the per-request envelope `company` nor
   * the ChangeCompany SystemAction (500) rebind an already-open session
   * (verified live on cronus28). We therefore re-run OpenSession with the target
   * company on the SAME connection, which BC accepts and which resets all
   * server-side form state to the new company.
   *
   * On success `this.company` reflects the echoed company name and all
   * previously open forms are dropped (they belong to the old company). On
   * failure (e.g. unknown company -> NavWebFailedOpenCompanyException) the
   * session is left untouched on the current company and the error is returned.
   *
   * The re-open runs as a single queued task so it cannot interleave with
   * in-flight invokes (BC's protocol is stateful; concurrent sends corrupt
   * sequence numbers). Company names are case-SENSITIVE -- pass the exact name
   * from the Companies list.
   */
  async changeCompany(companyName: string): Promise<Result<BCEvent[], ProtocolError>> {
    if (this.dead) return err(new ProtocolError('Session is dead'));
    const result = await this.enqueue(() => this.reopenWithCompany(companyName));
    if (isErr(result)) return result;

    // License dismissal runs as its OWN queued invoke (not inside the re-open
    // task) to avoid re-entering the queue from within an enqueued task.
    await this.dismissLicenseDialog(result.value);

    this.logger.info(`Company switched: ${this.sessionId}, company: ${this.company}`);
    return ok(result.value);
  }

  /** Queued body of changeCompany: re-open + reset stale form/modal state. */
  private async reopenWithCompany(companyName: string): Promise<Result<BCEvent[], ProtocolError>> {
    const openResult = await this.sendOpenSession(this.tenantId, companyName);
    if (isErr(openResult)) return openResult; // company/session unchanged on failure

    // Successful re-open == fresh server-side session bound to the new company.
    // Every form from the previous company is gone; drop stale tracking before
    // recording the forms the OpenSession response opened (e.g. the Role Center).
    this._openFormIds.clear();
    this.modalStack.clear();
    this.formsWithErrors.clear();
    return ok(this.updateFormTracking(openResult.value));
  }

  /** Auto-dismiss a license/evaluation notification dialog if the response has one. */
  private async dismissLicenseDialog(events: BCEvent[]): Promise<void> {
    const licenseDialog = findLicenseDialog(events);
    if (!licenseDialog) return;
    this.logger.info('Auto-dismissing license notification dialog');
    try {
      await this.invoke(
        { type: 'InvokeAction', formId: licenseDialog.formId, controlPath: 'server:', systemAction: 300 }, // Ok=300
        (e) => e.type === 'InvokeCompleted',
      );
      this.removeOpenForm(licenseDialog.formId);
    } catch {
      this.logger.warn('Failed to auto-dismiss license dialog, continuing anyway');
    }
  }

  private extractSessionCredentials(data: unknown): void {
    if (!data || typeof data !== 'object') return;
    if (Array.isArray(data)) {
      for (const item of data) this.extractSessionCredentials(item);
      return;
    }
    const obj = data as Record<string, unknown>;
    if (typeof obj.ServerSessionId === 'string' && obj.ServerSessionId) {
      this.sessionId = obj.ServerSessionId;
    }
    if (typeof obj.SessionKey === 'string' && obj.SessionKey) {
      this.sessionKey = obj.SessionKey;
    }
    if (typeof obj.CompanyName === 'string' && obj.CompanyName) {
      this.company = obj.CompanyName;
    }
    for (const value of Object.values(obj)) {
      this.extractSessionCredentials(value);
    }
  }

  async invoke(
    interaction: BCInteraction,
    expect: EventPredicate,
    timeoutMs?: number,
  ): Promise<Result<BCEvent[], ProtocolError>> {
    if (this.dead) return err(new ProtocolError('Session is dead'));
    const ceiling = this.ceilingFor(timeoutMs);
    try {
      // The watchdog must wrap execution INSIDE the queued task, not the enqueue
      // itself — otherwise time spent waiting behind earlier queued invokes
      // counts against it and a healthy backlog spuriously kills the session.
      return await this.enqueue(() => this.withLiveness(
        this.invokeUnqueued(interaction, expect, ceiling + RPC_GRACE_MS),
        ceiling,
        `Invoke(${interaction.type})`,
      ));
    } catch (e) {
      if (e instanceof TimeoutError) {
        return err(new ProtocolError(e.message));
      }
      throw e;
    }
  }

  /**
   * Send several interactions as ONE queued task, in order, merging all their
   * events. Aborts and returns the first error. Because it occupies a single
   * queue entry, no other operation's invoke can interleave between the
   * interactions — used for select-then-act atomicity (multi-row selection).
   * Intermediate interactions settle on InvokeCompleted; the final one settles
   * on the caller's `expect` predicate.
   */
  async invokeSequence(
    interactions: BCInteraction[],
    expect: EventPredicate,
    timeoutMs?: number,
  ): Promise<Result<BCEvent[], ProtocolError>> {
    if (this.dead) return err(new ProtocolError('Session is dead'));
    if (interactions.length === 0) return ok([]);
    const ceiling = this.ceilingFor(timeoutMs);
    try {
      return await this.enqueue(() => this.withLiveness((async () => {
        const all: BCEvent[] = [];
        for (let i = 0; i < interactions.length; i++) {
          const isLast = i === interactions.length - 1;
          const predicate: EventPredicate = isLast ? expect : (e) => e.type === 'InvokeCompleted';
          const r = await this.invokeUnqueued(interactions[i]!, predicate, ceiling + RPC_GRACE_MS);
          if (isErr(r)) return r;
          all.push(...r.value);
        }
        return ok(all);
      })(), ceiling, `InvokeSequence(${interactions.length})`));
    } catch (e) {
      if (e instanceof TimeoutError) return err(new ProtocolError(e.message));
      throw e;
    }
  }

  /**
   * Per-call ceiling. BC_INVOKE_MAX_DURATION is the floor; an explicit
   * per-call timeout (the report flow passes >=120s) can only extend it.
   */
  private ceilingFor(timeoutMs?: number): number {
    return Math.max(timeoutMs ?? 0, this.liveness.maxDurationMs);
  }

  /**
   * Run `promise` under the IsExecuting watchdog (see isexecuting-poller.ts).
   * While BC answers IsExecuting=true the invoke may run up to `ceilingMs`; a
   * wedged / unanswered / over-ceiling verdict kills the session so
   * SessionManager reconnects on the next request.
   */
  private withLiveness<T>(promise: Promise<T>, ceilingMs: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const stop = watchLiveness({
        probe: () => this.probeIsExecuting(),
        pollIntervalMs: this.liveness.pollIntervalMs,
        confirmDelayMs: WEDGE_CONFIRM_MS,
        ceilingMs,
        onVerdict: (verdict) => {
          this.logger.error(`${label}: liveness verdict '${verdict}', killing session`);
          this.markDead();
          this.closeWs();
          reject(new TimeoutError(VERDICT_MESSAGES[verdict](ceilingMs)));
        },
      });
      promise.then(
        (val) => { stop(); resolve(val); },
        (rejection) => { stop(); reject(rejection); },
      );
    });
  }

  /** One out-of-band IsExecuting probe; any transport failure reads as 'error'. */
  private async probeIsExecuting(): Promise<ProbeAnswer> {
    // A SignalR hub (BC26) runs one invocation per connection at a time
    // (HubOptions.MaximumParallelInvocationsPerClient defaults to 1, BC26
    // Startup leaves it), so a probe would queue behind the invoke it watches.
    // There, liveness is the socket's close plus the ceiling.
    if (this.ws.wireFraming === 'signalr') return 'true';
    const encoded = this.encoder.encode({ type: 'IsExecuting' }, this.encodeContext(uuid()));
    const r = await this.ws.sendOutOfBand(encoded.method, encoded.params, this.liveness.pollIntervalMs);
    const answer = isOk(r) ? parseIsExecutingAnswer(r.value) : 'error';
    this.logger.debug('protocol', `IsExecuting probe: ${answer}`);
    return answer;
  }

  private encodeContext(callbackId: string): EncodeContext {
    return {
      callbackId,
      sequenceNo: this.ws.nextSequenceNo,
      lastClientAckSequenceNumber: this.ws.lastClientAckSequenceNumber,
      openFormIds: this._openFormIds,
      session: {
        sessionId: this.sessionId,
        sessionKey: this.sessionKey,
        company: this.company,
        tenantId: this.tenantId,
        spaInstanceId: this.ws.spaInstanceId,
      },
    };
  }

  /**
   * Queue-bypassing invoke. Performs the actual encode -> sendRpc -> decode
   * -> QUIESCENCE wait -> async-event merge cycle without enqueuing onto
   * `this.queue`. This is intended for callers that already run inside an
   * enqueued task (e.g. `reconcileModalStack`, called from
   * `invokeUnqueued`'s own modal-violation retry path). Callers that are
   * NOT already serialized must use the public `invoke` instead -- BC's
   * protocol is stateful and concurrent sends corrupt sequence numbers.
   */
  private async invokeUnqueued(
    interaction: BCInteraction,
    expect: EventPredicate,
    timeoutMs: number,
    bypassDeadCheck = false,
  ): Promise<Result<BCEvent[], ProtocolError>> {
    // Drain-on-death: once the session is dead, every queued invoke fast-fails
    // here instead of reaching ws.sendRpc and eating a full timeout. The queue is
    // serial, so the task that detects death (markDead) is immediately followed by
    // the remaining queued tasks, each short-circuiting through this guard.
    // bypassDeadCheck is used by closeGracefully's invokeRaw path, which sets
    // dead=true before the form-close loop to block concurrent invokes but still
    // needs to send CloseForm RPCs itself.
    if (this.dead && !bypassDeadCheck) {
      return err(new ProtocolError('Session is dead'));
    }
    const callbackId = uuid();
    const allEvents: BCEvent[] = [];
    const asyncEvents: BCEvent[] = [];

    // Register message handler to capture async Message notifications during this invoke
    const unsubscribe = this.ws.onMessage((raw) => {
      if (!raw || typeof raw !== 'object') return;
      const msg = raw as Record<string, unknown>;
      // Only process async Message notifications (method: "Message", no id)
      if (msg['method'] === 'Message' && !('id' in msg) && Array.isArray(msg['params'])) {
        const messageData = (msg['params'] as unknown[])[0] as Record<string, unknown> | undefined;
        if (messageData?.['compressedData'] && typeof messageData['compressedData'] === 'string') {
          const decompResult = decompressPayload(messageData['compressedData'] as string);
          if (isOk(decompResult) && Array.isArray(decompResult.value)) {
            const events = this.decoder.decode(decompResult.value as unknown[]);
            asyncEvents.push(...events);
          }
        } else if (Array.isArray(messageData?.['data'])) {
          // Uncompressed ClientMessage (BC26 sends small ones this way).
          asyncEvents.push(...this.decoder.decode(messageData['data'] as unknown[]));
        }
      }
    });

    try {
      // Encode the interaction
      const encoded = this.encoder.encode(interaction, this.encodeContext(callbackId));

      this.logger.debug('protocol', `Invoke: ${interaction.type}`, {
        callbackId,
        formId: interaction.formId,
      });

      // Send and wait for synchronous response
      const rpcResult = await this.ws.sendRpc(encoded.method, encoded.params, timeoutMs);
      if (isErr(rpcResult)) {
        const msg = rpcResult.error.message;
        if (isFatalRpcError(msg)) {
          this.markDead();
          return rpcResult;
        }
        if (msg.includes('LogicalModalityViolationException')) {
          // Stale modal state -- reconcile, then retry the original interaction
          // once. reconcileModalStack runs inside this enqueued task via
          // invokeUnqueued (queue-bypassing) to avoid a self-deadlock: the
          // outer enqueued task cannot resolve until reconcile finishes, and
          // a queued reconcile sub-invoke cannot start until the outer task
          // resolves. Each sub-invoke decodes its own response and updates
          // _openFormIds / modalStack via updateFormTracking. The closed
          // dialogs' FormClosed go to `onReconciledClose`, never into this
          // invoke's result: the CloseForm's other events (an AL Error raised
          // while closing) are not the outcome of the caller's interaction.
          this.logger.warn(`LogicalModalityViolation detected, reconciling modal stack (size=${this.modalStack.size})`);
          const reconcile = await this.reconcileModalStack();
          if (isErr(reconcile)) {
            this.markDead();
            return err(new ModalReconcileError(`Modal reconciliation failed: ${reconcile.error.message}`, { originalError: msg }));
          }
          // Re-encode -- sequence numbers / openFormIds may have advanced.
          const retryEncoded = this.encoder.encode(interaction, this.encodeContext(callbackId));
          const retryRpc = await this.ws.sendRpc(retryEncoded.method, retryEncoded.params, timeoutMs);
          if (isErr(retryRpc)) {
            this.markDead();
            return err(new ModalReconcileError(`Retry after modal reconcile still failed: ${retryRpc.error.message}`, { originalError: msg }));
          }
          if (Array.isArray(retryRpc.value)) {
            allEvents.push(...this.decoder.decode(retryRpc.value));
          }
          // Fall through to the normal post-success path
        } else {
          return rpcResult;
        }
      } else {
        // Normal success path
        const responseData = rpcResult.value;
        if (Array.isArray(responseData)) {
          allEvents.push(...this.decoder.decode(responseData));
        }
      }

      // Quiescence window — wait for trailing async Messages
      await new Promise<void>(resolve => setTimeout(resolve, QUIESCENCE_MS));

      // Collect async events, then derive FormClosed and update form tracking
      allEvents.push(...asyncEvents);
      allEvents.splice(0, allEvents.length, ...this.updateFormTracking(allEvents));

      // Check completion gates for logging
      let invokeCompletedSeen = false;
      let expectMatched = false;
      for (const event of allEvents) {
        if (event.type === 'InvokeCompleted') {
          if (event.completedInteractions.some(ci => ci.invocationId === callbackId)) {
            invokeCompletedSeen = true;
          }
        }
        if (!expectMatched && expect(event, { callbackId, interactionFormId: interaction.formId, invokeCompletedSeen })) {
          expectMatched = true;
        }
      }

      this.logger.debug('protocol', `Invoke complete: ${interaction.type}`, {
        callbackId,
        eventCount: allEvents.length,
        types: allEvents.map(e => e.type),
        invokeCompletedSeen,
        expectMatched,
      });

      return ok(allEvents);
    } finally {
      unsubscribe();
    }
  }

  /**
   * Track open forms and the modal stack, and return `events` with a
   * `FormClosed` inserted after each real close. BC has no close event: it
   * reports `State` = 0 on the form's `server:` path (`isFormClosedChange`,
   * which excludes a hosted part's State on its host's formId). Consumers
   * (PageContextRepository.markFormClosed) see the derived `FormClosed`.
   */
  private updateFormTracking(events: readonly BCEvent[]): BCEvent[] {
    const out: BCEvent[] = [];
    for (const event of events) {
      out.push(event);
      if (event.type === 'FormCreated' && event.formId) {
        this._openFormIds.add(event.formId);
        // Non-modal -- do not push onto modalStack
      }
      if (event.type === 'DialogOpened' && event.formId) {
        this._openFormIds.add(event.formId);
        const tree = event.controlTree as Record<string, unknown> | undefined;
        const hint = tree?.['MappingHint'] ?? tree?.['mappingHint'];
        this.modalStack.push(event.formId, typeof hint === 'string' ? hint : undefined);
      }
      if (event.type === 'PropertyChanged') {
        const hasErrors = formHasErrors(event);
        if (hasErrors === true) this.formsWithErrors.add(event.formId);
        else if (hasErrors === false) this.formsWithErrors.delete(event.formId);
      }
      if (isFormClosedChange(event) && this._openFormIds.has(event.formId)) {
        this.removeOpenForm(event.formId);
        out.push({ type: 'FormClosed', formId: event.formId });
      }
    }
    return out;
  }

  addOpenForm(formId: string): void {
    this._openFormIds.add(formId);
  }

  removeOpenForm(formId: string): void {
    this._openFormIds.delete(formId);
    this.modalStack.remove(formId);
    this.formsWithErrors.delete(formId);
  }

  /** Test seam: snapshot of the current modal stack (top-most last). */
  modalStackSnapshot(): string[] {
    return this.modalStack.snapshot();
  }

  markDead(): void {
    this.dead = true;
  }

  /**
   * Walk the modal stack from top to bottom, sending CloseForm to each modal
   * until the stack is empty. BC reports a closed dialog as State=0, which
   * updateFormTracking turns into FormClosed and pops. A close that spawns a
   * nested dialog pushes it, and the loop closes that next. Each closed
   * dialog's FormClosed (and only that) goes to `onReconciledClose`, so it
   * reaches the page-context repository whichever caller's invoke triggered
   * the reconcile.
   *
   * CloseForm, not InvokeAction(Abort=320): `InvokeActionInteraction` only runs
   * an action the dialog actually has, and confirms (Yes/No), messages (OK) and
   * request pages (OK/Cancel) have no Abort button, so Abort is a silent no-op
   * that leaves the dialog open (verified live on cronus29: report 6 request
   * page, Abort answers InvokeCompleted only and the next OpenForm still hits
   * LogicalModalityViolation). `CloseFormInteraction` calls `LogicalForm.Close()`
   * without `VerifyFormModality`; a closed confirm keeps its default
   * DialogResult (Ok), which `MessageHelper.ShowMessageForm` reads as "not
   * Yes", i.e. No. If BC answers FormNotFoundException the form is already gone
   * and is dropped locally; a close that reports nothing is an error (the
   * dialog is still open, retrying the original interaction cannot succeed).
   *
   * One Yes: a request page with validation errors answers its close with a
   * discard-changes confirm, which reconcile answers Yes once (see the loop), so
   * the page closes as Cancel instead of the reconcile running out of attempts.
   *
   * Only dialogs whose close is proven to read as a refusal are closed
   * (`SAFE_RECONCILE_HINTS`). Any other modal (an AL `Page.RunModal` page, a
   * lookup, a StrMenu) fails the reconcile, so the caller resets the session
   * and BC rolls the pending work back. Closing one would resume the suspended
   * AL with an accept-style result: `NavFormCloseHandler.ExecuteCloseCore` sets
   * `DialogResult ??= FindExitActionFormResult(form)`, which is OK with no
   * action bar or a single OK exit action (LookupOK on a lookup), even for
   * `FormCloseBehavior.ForceClose`, and `ExecuteCloseForm` saves a dirty form.
   *
   * Used to clear stale modal state that produced a
   * `LogicalModalityViolationException`. Calls `invokeUnqueued` directly
   * (queue-bypassing) so it works when triggered from inside the modal-violation
   * retry path in `invokeUnqueued` itself — calling `invoke` from there would
   * self-deadlock on the promise queue. External callers may invoke it
   * outside the queue; in that case behaviour is well-defined as long as no
   * other invoke is in flight on the same session (BC's wire protocol is
   * stateful and concurrent sends corrupt sequence numbers).
   *
   * Reference: decompiled `InvokeActionInteraction.InvokeCore` /
   * `FindFormActionToExecute`, `LogicalDialog.AddActions`, `CloseFormInteraction`,
   * `MessageHelper.ShowMessageForm`, `LogicalModalityVerifier.IsUnderModalForm`.
   */
  async reconcileModalStack(): Promise<Result<void, ProtocolError>> {
    const MAX_ATTEMPTS = 10;
    const discardAnswered = new Set<string>();
    for (let i = 0; i < MAX_ATTEMPTS && this.modalStack.size > 0; i++) {
      const top = this.modalStack.peek()!;
      const hint = this.modalStack.mappingHintOf(top);
      if (!hint || !SAFE_RECONCILE_HINTS.has(hint)) {
        return err(new ProtocolError(`reconcileModalStack: formId=${top} (MappingHint=${hint ?? 'none'}) is not a dialog whose close is a refusal; closing it could accept it`));
      }
      // A request page with errors asks Message_DiscardChanges before it closes,
      // and that confirm read as No cancels the close (see below).
      const expectDiscard = hint === 'RequestPage' && this.formsWithErrors.has(top) && !discardAnswered.has(top);
      const result = await this.invokeUnqueued(
        { type: 'CloseForm', formId: top },
        (event) => event.type === 'InvokeCompleted',
        this.timeoutMs,
      );
      if (isErr(result)) {
        if (!result.error.message.includes('FormNotFoundException')) {
          return err(new ProtocolError(`reconcileModalStack: CloseForm on formId=${top} failed: ${result.error.message}`));
        }
        this.removeOpenForm(top);
        this.onReconciledClose?.([{ type: 'FormClosed', formId: top }]);
        continue;
      }
      const closed = result.value.filter(e => e.type === 'FormClosed');
      if (closed.length > 0) this.onReconciledClose?.(closed);
      if (this.modalStack.peek() === top) {
        return err(new ProtocolError(`reconcileModalStack: CloseForm on formId=${top} completed but BC did not report the dialog closed (no State=0)`));
      }
      const spawned = this.modalStack.peek();
      if (expectDiscard && spawned !== undefined && this.modalStack.snapshot().includes(top)
        && this.modalStack.mappingHintOf(spawned) === 'ConfirmDialog') {
        // The first confirm a close raises on a form with errors is
        // Message_DiscardChanges: LogicalFormClosingHandler.HandleFormClosingWhenErrors
        // runs in the FormClosing phase, before NavFormCloseHandler.ExecuteCloseCore
        // calls into AL (OnQueryClosePage). Yes = LogicalForm.Cancel() (abort the
        // edit) + RequestForceClose, and NavRequestPage.OnFormClosing then sets
        // DialogResult Cancel, so the report never runs -- the same outcome as a
        // close without errors. Answered once per form: a later confirm on the same
        // form could be AL's, and is closed as No like any other.
        discardAnswered.add(top);
        const yes = await this.invokeUnqueued(
          { type: 'InvokeAction', formId: spawned, controlPath: 'server:', systemAction: SystemAction.Yes },
          (event) => event.type === 'InvokeCompleted',
          this.timeoutMs,
        );
        if (isErr(yes)) {
          return err(new ProtocolError(`reconcileModalStack: Yes on discard confirm formId=${spawned} failed: ${yes.error.message}`));
        }
        const closedByYes = yes.value.filter(e => e.type === 'FormClosed');
        if (closedByYes.length > 0) this.onReconciledClose?.(closedByYes);
      }
    }
    if (this.modalStack.size > 0) {
      return err(new ProtocolError(`reconcileModalStack: stack still has ${this.modalStack.size} entries after ${MAX_ATTEMPTS} attempts`));
    }
    return ok(undefined);
  }

  /**
   * Idempotent WebSocket close. Guards against double-close: the underlying
   * BCWebSocket implementation may throw or behave unexpectedly when close()
   * is called on an already-closed socket. Safe to call from multiple teardown
   * paths (timeout handler, closeGracefully, close).
   *
   * Decompiled finding (Connection.cs): BC disposes the NavSession in
   * Connection_Disconnected, which fires for ANY WebSocket close reason
   * (clean or abrupt). No explicit CloseConnection RPC is required for
   * server-side session disposal -- WS close is sufficient. We therefore
   * rely on WS-close as the guaranteed reap trigger and do NOT invent a
   * CloseConnection RPC call.
   */
  private closeWs(): void {
    if (this.wsClosed) return;
    this.wsClosed = true;
    this.ws.close();
  }

  /**
   * Gracefully close the session by closing all open forms (dialogs first),
   * then closing the WebSocket. Without this, BC keeps modal dialog state
   * alive server-side, blocking new sessions for the same user.
   * Verified from decompiled LogicalModalityVerifier.cs / LogicalDispatcher.cs.
   *
   * Idempotent: safe to call more than once. The second call is a no-op.
   * Guaranteed to terminate: the form-close loop is bounded (20 iterations);
   * any invoke failure is swallowed so the final dead+WS-close always runs.
   */
  async closeGracefully(): Promise<void> {
    // Already torn down -- nothing to do.
    if (this.dead) return;

    // Mark dead immediately so concurrent invokes fast-fail and a second
    // concurrent closeGracefully call short-circuits at the guard above.
    this.dead = true;

    try {
      // Close forms iteratively. CloseForm may trigger save-changes dialogs that
      // become new modal forms in _openFormIds. Dismiss them before continuing.
      // Safety limit prevents infinite loops.
      for (let iteration = 0; iteration < 20 && this._openFormIds.size > 0; iteration++) {
        const formId = Array.from(this._openFormIds).pop()!;
        try {
          const result = await this.invokeRaw(
            { type: 'CloseForm', formId },
            (event) => event.type === 'InvokeCompleted',
          );
          // Check if CloseForm spawned a dialog (save changes?) -- dismiss it
          if (isOk(result)) {
            for (const event of result.value) {
              if (event.type === 'DialogOpened' && event.formId) {
                // Respond "no" to discard changes and close the dialog
                try {
                  await this.invokeRaw(
                    { type: 'InvokeAction', formId: event.formId, controlPath: 'server:', systemAction: 390 }, // No=390
                    (e) => e.type === 'InvokeCompleted',
                  );
                } catch { /* best effort */ }
                this._openFormIds.delete(event.formId);
              }
            }
          }
        } catch {
          // Best effort -- form may already be closed or session dead
        }
        this._openFormIds.delete(formId);
      }
    } finally {
      // Always guaranteed: WS-close is the server-side reap trigger.
      // Connection_Disconnected on the BC server fires for any close reason
      // and calls session.DisposeAsync() unconditionally (Connection.cs).
      this.closeWs();
    }
  }

  /**
   * Raw invoke that bypasses the `dead` check on `invoke()`. Used by
   * closeGracefully(), which sets `dead = true` before the form-close loop so
   * that concurrent callers fast-fail, but still needs to send CloseForm RPCs.
   */
  private async invokeRaw(
    interaction: BCInteraction,
    expect: EventPredicate,
    timeoutMs?: number,
  ): Promise<Result<BCEvent[], ProtocolError>> {
    const ceiling = this.ceilingFor(timeoutMs);
    try {
      return await this.enqueue(() => this.withLiveness(
        this.invokeUnqueued(interaction, expect, ceiling + RPC_GRACE_MS, /* bypassDeadCheck */ true),
        ceiling,
        `InvokeRaw(${interaction.type})`,
      ));
    } catch (e) {
      if (e instanceof TimeoutError) {
        return err(new ProtocolError(e.message));
      }
      throw e;
    }
  }

  async runReport(reportId: number): Promise<Result<BCEvent[], ProtocolError>> {
    if (this.dead) return err(new ProtocolError('Session is dead'));
    // RunReport is dispatched via OpenForm with query "report=<id>".
    // The BC web client uses FormPropertyBag with COMMAND=report, ID=<id>.
    // Verified from decompiled NavRunReportPropertyBagInvokedAction.cs:
    //   FormPropertyBag maps "report" key to COMMAND=report, ID=reportId
    //   InvokePropertyBagAction calls IService.RunReport(reportId)
    return this.invoke(
      {
        type: 'OpenForm',
        query: `report=${reportId}&tenant=${this.tenantId}`,
      },
      (e) => e.type === 'InvokeCompleted' || e.type === 'DialogOpened' || e.type === 'FormCreated',
    );
  }

  /**
   * Execute report `reportId` through the "Send to..." flow and return the
   * events produced along the way, including the `FileDownloadReady` event
   * carrying the download URL. The flow mirrors what the BC web browser
   * client does:
   *
   *   1. OpenForm(report=<id>) → request page (DialogOpened)
   *   2. InvokeAction(410=SendTo) on request page → format dialog (DialogOpened, MappingHint "PrintDialog")
   *   3. [If format is not pdf] SaveValue the format text label into the SelectionControl
   *   4. InvokeAction(300=OK) on format dialog → FileDownloadReady event inline
   *
   * Steps 1–4 are driven internally. The caller may have already opened the
   * request page (via `runReport`) and optionally filled parameters; in that
   * case pass `options.requestPageFormId` to skip step 1. Fetching the bytes
   * from the `FileDownloadReady.relativeUrl` is the caller's responsibility
   * (see `DownloadService`).
   *
   * Format selection:
   *   BC's PrintDialog SelectionControl carries Items with human-readable text
   *   labels. SaveValue requires the TEXT label (not a numeric index) — numeric
   *   values are rejected by BC. For 'pdf' (the default selection), SaveValue is
   *   skipped unless the dialog can be read. For 'excel' / 'word', the SelectionControl
   *   is located by walking the format-dialog form tree and matching the first node
   *   whose `options` array is non-empty; resolveFormatLabel then picks the right text.
   *   If the requested format has no matching option, ProtocolError is returned with
   *   the available option texts listed.
   *
   * Reference: decompiled `NavRunReportPropertyBagInvokedAction.cs`,
   * `ReportResultSetDownloadDecorator.cs`, `FileUrlAddressProvider.cs`, and
   * `ResponseManager.RegisterUriToShowEvents` (BC28). Verified from live BC28
   * wire capture (2026-06-15). Format SaveValue verified live (2026-06-19):
   * "Microsoft Word Document" / "Microsoft Excel Document (data only)".
   */
  async runReportWithDownload(
    reportId: number,
    format: 'pdf' | 'excel' | 'word' = 'pdf',
    options?: { requestPageFormId?: string; downloadTimeoutMs?: number },
  ): Promise<Result<{ events: BCEvent[] }, ProtocolError>> {
    if (this.dead) return err(new ProtocolError('Session is dead'));

    const effectiveDownloadTimeout = options?.downloadTimeoutMs ?? Math.max(this.timeoutMs, 120000);

    // Step 1: Open request page (skip if already open)
    let reqFormId = options?.requestPageFormId;
    const openEvents: BCEvent[] = [];

    if (!reqFormId) {
      const openResult = await this.runReport(reportId);
      if (isErr(openResult)) return openResult;
      openEvents.push(...openResult.value);
      const dlg = openResult.value.find(e => e.type === 'DialogOpened' || e.type === 'FormCreated');
      if (!dlg?.formId) {
        return err(new ProtocolError(`Report ${reportId}: no request page dialog returned`));
      }
      reqFormId = dlg.formId;
    }

    // Step 2: Invoke SendTo (410) to open the format selection dialog
    const sendToResult = await this.invoke(
      { type: 'InvokeAction', formId: reqFormId, controlPath: 'server:', systemAction: 410 },
      (e) => e.type === 'InvokeCompleted' || e.type === 'DialogOpened',
      effectiveDownloadTimeout,
    );
    if (isErr(sendToResult)) return err(new ProtocolError(`SendTo (410) failed: ${sendToResult.error.message}`));

    const fmtDlg = sendToResult.value.find(e => e.type === 'DialogOpened' || e.type === 'FormCreated');
    if (!fmtDlg?.formId) {
      return err(new ProtocolError('SendTo (410): no format dialog opened'));
    }
    const fmtFormId = fmtDlg.formId;

    // Step 3: Select format via SaveValue on the PrintDialog SelectionControl.
    // PDF is the BC default — if the user wants pdf and we cannot locate the
    // SelectionControl, we silently skip SaveValue and let BC render PDF.
    // For excel/word, we MUST locate the SelectionControl and its options.
    //
    // The format-dialog controlTree is the raw eventData from the DialogOpened
    // event. Walk the built form tree to find the first FieldNode whose options
    // list is non-empty — that is the format SelectionControl (a 'sec' node).
    const saveValueResult = await this.selectReportFormat(fmtFormId, fmtDlg.controlTree, format, reportId, effectiveDownloadTimeout);
    if (saveValueResult !== null && isErr(saveValueResult)) return saveValueResult;

    // Step 4: Confirm format dialog (OK=300). The FileDownloadReady event
    // arrives INLINE in this response — not as a separate async message.
    const okResult = await this.invoke(
      { type: 'InvokeAction', formId: fmtFormId, controlPath: 'server:', systemAction: 300 },
      (e) => e.type === 'InvokeCompleted' || e.type === 'FileDownloadReady',
      effectiveDownloadTimeout,
    );
    if (isErr(okResult)) return err(new ProtocolError(`Format OK (300) failed: ${okResult.error.message}`));

    const saveValueEvents = saveValueResult !== null && isOk(saveValueResult) ? saveValueResult.value : [];
    const allEvents = [...openEvents, ...sendToResult.value, ...saveValueEvents, ...okResult.value];

    const dlReady = okResult.value.find(e => e.type === 'FileDownloadReady');
    if (!dlReady || dlReady.type !== 'FileDownloadReady') {
      return err(new ProtocolError('Report rendered but no download URL received (FileDownloadReady event missing)'));
    }
    return ok({ events: allEvents });
  }

  /**
   * Walk the PrintDialog form tree to find the format SelectionControl, then
   * either SaveValue the chosen format label or (for pdf) skip if it is already
   * the default.
   *
   * Returns:
   *  - null if no SaveValue is needed (pdf default, or no SelectionControl found)
   *  - ok(events) if SaveValue was sent and acknowledged
   *  - err(ProtocolError) if the requested format is unavailable or SaveValue failed
   */
  private async selectReportFormat(
    fmtFormId: string,
    controlTree: unknown,
    format: 'pdf' | 'excel' | 'word',
    reportId: number,
    timeoutMs: number,
  ): Promise<Result<BCEvent[], ProtocolError> | null> {
    // Locate the SelectionControl: first FieldNode in the dialog tree whose
    // options array is non-empty. The path ~server:c[0]/c[1]/c[0] is typical
    // but not guaranteed — read from tree for robustness.
    let selectionControlPath: string | undefined;
    let availableOptions: ReadonlyArray<{ text: string; value: string }> = [];

    try {
      const tree = buildFormTree(controlTree);
      for (const node of walkTree(tree)) {
        if (node.properties.options && node.properties.options.length > 0) {
          selectionControlPath = node.controlPath;
          availableOptions = node.properties.options;
          break;
        }
      }
    } catch {
      // Malformed tree — treat as "no SelectionControl found"
    }

    if (!selectionControlPath || availableOptions.length === 0) {
      // No SelectionControl found in the dialog tree.
      if (format === 'pdf') {
        // PDF is BC's default; safe to proceed without SaveValue.
        this.logger.debug('protocol', `Report ${reportId}: no format SelectionControl found; proceeding with BC default (pdf)`);
        return null;
      }
      return err(new ProtocolError(
        `Report ${reportId}: format dialog has no SelectionControl with options; cannot select ${format}`,
      ));
    }

    // Resolve format → label text using the dialog's actual option list.
    const label = resolveFormatLabel(availableOptions, format);
    const availableTexts = availableOptions.map(o => o.text).join(', ');

    if (!label) {
      return err(new ProtocolError(
        `Report ${reportId} does not offer ${format}; available: ${availableTexts}`,
      ));
    }

    // PDF is always BC's pre-selected default, so we skip SaveValue for it
    // (the raw dialog tree does not reliably expose the current selection
    // without full PropertyChanged hydration, and OK alone renders PDF).
    if (format === 'pdf') {
      this.logger.debug('protocol', `Report ${reportId}: pdf is BC default; skipping SaveValue`);
      return null;
    }

    // Send SaveValue with the matched label text.
    this.logger.info(`Report ${reportId}: setting format to "${label}" (controlPath=${selectionControlPath})`);
    const svResult = await this.invoke(
      { type: 'SaveValue', formId: fmtFormId, controlPath: selectionControlPath, newValue: label },
      (e) => e.type === 'InvokeCompleted' || e.type === 'PropertyChanged',
      timeoutMs,
    );
    if (isErr(svResult)) {
      return err(new ProtocolError(`SaveValue format label "${label}" failed: ${svResult.error.message}`));
    }
    return svResult;
  }

  /**
   * Unconditional teardown. Idempotent: safe to call more than once.
   * Does not attempt graceful form-close -- use closeGracefully() when
   * there is time to clean up server-side modal state.
   */
  close(): void {
    this.dead = true;
    this.closeWs();
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }
}
