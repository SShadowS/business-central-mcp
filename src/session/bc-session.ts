import { v4 as uuid } from 'uuid';
import { ok, err, isOk, isErr, type Result } from '../core/result.js';
import { ProtocolError, TimeoutError, ModalReconcileError } from '../core/errors.js';
import type { BCWebSocket } from '../connection/bc-websocket.js';
import type { BCEvent, BCInteraction, EventPredicate } from '../protocol/types.js';
import { EventDecoder } from '../protocol/event-decoder.js';
import { InteractionEncoder, type EncodeContext } from '../protocol/interaction-encoder.js';
import { decompressPayload } from '../protocol/decompression.js';
import type { Logger } from '../core/logger.js';
import { ModalStack } from './modal-stack.js';
import { isFatalRpcError } from './rpc-error-classifier.js';
import { findLicenseDialog } from './license-dialog.js';
import type { ReportDownloader } from './report-downloader.js';
import { resolveFormatLabel } from './report-format-resolver.js';
import { buildFormTree } from '../protocol/form-tree-builder.js';
import { walkTree } from '../protocol/form-tree-walk.js';

const DEFAULT_TIMEOUT_MS = 30000;
const QUIESCENCE_MS = 150; // Trailing window for async Message bursts

export class BCSession {
  private queue: Promise<void> = Promise.resolve();
  private readonly _openFormIds = new Set<string>();
  private readonly modalStack = new ModalStack();
  private dead = false;
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
    private readonly reportDownloader?: ReportDownloader,
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

  get isAlive(): boolean {
    return !this.dead && this.ws.isConnected;
  }

  async initialize(tenantId: string): Promise<Result<BCEvent[], ProtocolError>> {
    const openSessionCall = this.encoder.encodeOpenSession(tenantId, this.ws.spaInstanceId, this.profile);

    this.logger.debug('protocol', 'Sending OpenSession');
    const rpcResult = await this.ws.sendRpc(openSessionCall.method, openSessionCall.params, this.timeoutMs);
    if (isErr(rpcResult)) return rpcResult;

    const responseData = rpcResult.value;
    let events: BCEvent[] = [];
    if (Array.isArray(responseData)) {
      events = this.decoder.decode(responseData);
    }

    // Wait for async messages
    await new Promise(resolve => setTimeout(resolve, QUIESCENCE_MS));

    // Extract session credentials from response (recursively searches for fields)
    this.extractSessionCredentials(responseData);

    // Update form tracking
    this.updateFormTracking(events);

    this._initialized = true;

    // Auto-dismiss license notification dialogs (present on fresh/evaluation databases)
    const licenseDialog = findLicenseDialog(events);
    if (licenseDialog) {
      this.logger.info('Auto-dismissing license notification dialog');
      try {
        await this.invoke(
          { type: 'InvokeAction', formId: licenseDialog.formId, controlPath: 'server:', systemAction: 300 }, // Ok=300
          (e) => e.type === 'InvokeCompleted',
        );
        this._openFormIds.delete(licenseDialog.formId);
      } catch {
        this.logger.warn('Failed to auto-dismiss license dialog, continuing anyway');
      }
    }

    this.logger.info(`Session initialized: ${this.sessionId}, company: ${this.company}`);

    return ok(events);
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
    const effectiveTimeout = timeoutMs ?? this.timeoutMs;
    try {
      return await this.withTimeout(
        this.enqueue(() => this.invokeUnqueued(interaction, expect, effectiveTimeout)),
        effectiveTimeout + 5000, // Session-level timeout is 5s longer than RPC timeout
        `Invoke(${interaction.type})`,
      );
    } catch (e) {
      if (e instanceof TimeoutError) {
        return err(new ProtocolError(e.message));
      }
      throw e;
    }
  }

  private withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.logger.error(`${label} timed out after ${ms}ms, killing session`);
        this.markDead();
        this.closeWs();
        reject(new TimeoutError(`BC did not respond within ${ms / 1000}s. Session has been killed and will reconnect on next request.`));
      }, ms);
      promise.then(
        (val) => { clearTimeout(timer); resolve(val); },
        (rejection) => { clearTimeout(timer); reject(rejection); },
      );
    });
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
        }
      }
    });

    try {
      // Encode the interaction
      const context: EncodeContext = {
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
      const encoded = this.encoder.encode(interaction, context);

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
          // _openFormIds / modalStack via updateFormTracking. The retry's
          // events are merged into allEvents below so the caller's `expect`
          // predicate observes them alongside any FormClosed events emitted
          // by the reconcile sub-invokes.
          this.logger.warn(`LogicalModalityViolation detected, reconciling modal stack (size=${this.modalStack.size})`);
          const reconcile = await this.reconcileModalStack();
          if (isErr(reconcile)) {
            this.markDead();
            return err(new ModalReconcileError(`Modal reconciliation failed: ${reconcile.error.message}`, { originalError: msg }));
          }
          // Re-encode -- sequence numbers / openFormIds may have advanced.
          const retryContext: EncodeContext = {
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
          const retryEncoded = this.encoder.encode(interaction, retryContext);
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

      // Collect async events
      allEvents.push(...asyncEvents);

      // Update form tracking
      this.updateFormTracking(allEvents);

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

  private updateFormTracking(events: BCEvent[]): void {
    for (const event of events) {
      if (event.type === 'FormCreated' && event.formId) {
        this._openFormIds.add(event.formId);
        // Non-modal -- do not push onto modalStack
      }
      if (event.type === 'DialogOpened' && event.formId) {
        this._openFormIds.add(event.formId);
        this.modalStack.push(event.formId);
      }
      if (event.type === 'FormClosed' && event.formId) {
        this._openFormIds.delete(event.formId);
        this.modalStack.remove(event.formId);
      }
    }
  }

  addOpenForm(formId: string): void {
    this._openFormIds.add(formId);
  }

  removeOpenForm(formId: string): void {
    this._openFormIds.delete(formId);
    this.modalStack.remove(formId);
  }

  /** Test seam: snapshot of the current modal stack (top-most last). */
  modalStackSnapshot(): string[] {
    return this.modalStack.snapshot();
  }

  markDead(): void {
    this.dead = true;
  }

  /**
   * Walk the modal stack from top to bottom, sending Abort (SystemAction=320)
   * to each modal until the stack is empty or an Abort fails. After each
   * successful Abort, BC's FormClosed event normally pops the stack via
   * updateFormTracking. If FormClosed does not arrive, the loop force-pops
   * to make progress.
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
   * Reference: decompiled `LogicalModalityVerifier.IsUnderModalForm`, which
   * inspects `LogicalDispatcher.Frames`. SystemAction.Abort=320 closes the
   * topmost frame's ModalForm.
   */
  async reconcileModalStack(): Promise<Result<void, ProtocolError>> {
    const MAX_ATTEMPTS = 10;
    for (let i = 0; i < MAX_ATTEMPTS && this.modalStack.size > 0; i++) {
      const top = this.modalStack.peek()!;
      const result = await this.invokeUnqueued(
        { type: 'InvokeAction', formId: top, controlPath: 'server:', systemAction: 320 },
        (event) => event.type === 'InvokeCompleted',
        this.timeoutMs,
      );
      if (isErr(result)) {
        return err(new ProtocolError(`reconcileModalStack: Abort on formId=${top} failed: ${result.error.message}`));
      }
      // If BC didn't emit FormClosed for this formId, force-pop to make progress.
      // Live observation (BC28): confirm dialogs do NOT emit FormClosed on
      // Abort=320 against controlPath:'server:'. The local stack is force-popped
      // here for client-state consistency, but BC may still consider the
      // dialog open server-side -- in that case the next invoke triggers
      // another LogicalModalityViolation and falls back to session reset.
      if (this.modalStack.peek() === top) {
        this.logger.warn(`reconcileModalStack: BC did not emit FormClosed for formId=${top} after Abort -- force-popping local stack (server-side dialog may still be open)`);
        this.modalStack.pop();
        this._openFormIds.delete(top);
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
  private invokeRaw(
    interaction: BCInteraction,
    expect: EventPredicate,
    timeoutMs?: number,
  ): Promise<Result<BCEvent[], ProtocolError>> {
    const effectiveTimeout = timeoutMs ?? this.timeoutMs;
    try {
      return this.withTimeout(
        this.enqueue(() => this.invokeUnqueued(interaction, expect, effectiveTimeout, /* bypassDeadCheck */ true)),
        effectiveTimeout + 5000,
        `InvokeRaw(${interaction.type})`,
      );
    } catch (e) {
      if (e instanceof TimeoutError) {
        return Promise.resolve(err(new ProtocolError(e.message)));
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
   * Execute report `reportId` through the "Send to..." flow and capture the
   * rendered output bytes. The flow mirrors what the BC web browser client does:
   *
   *   1. OpenForm(report=<id>) → request page (DialogOpened)
   *   2. InvokeAction(410=SendTo) on request page → format dialog (DialogOpened, MappingHint "PrintDialog")
   *   3. [If format is not pdf] SaveValue the format text label into the SelectionControl
   *   4. InvokeAction(300=OK) on format dialog → FileDownloadReady event inline
   *   5. Fetch `DynamicFileHandler.axd?...` with NTLM headers → bytes
   *
   * Steps 1–5 are driven internally. The caller may have already opened the
   * request page (via `runReport`) and optionally filled parameters; in that
   * case pass `options.requestPageFormId` to skip step 1.
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
  ): Promise<Result<{ events: BCEvent[]; bytes: Buffer; contentType: string; fileName?: string }, ProtocolError>> {
    if (this.dead) return err(new ProtocolError('Session is dead'));
    if (!this.reportDownloader) return err(new ProtocolError('No report downloader configured'));

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

    // Step 5: Fetch the file
    this.logger.info(`Report download URL: ${dlReady.relativeUrl}`);
    try {
      const { bytes, contentType, fileName } = await this.reportDownloader.downloadFromUrl(dlReady.relativeUrl);
      this.logger.info(`Report captured: ${bytes.length} bytes, contentType=${contentType}${fileName ? `, fileName=${fileName}` : ''}`);
      return ok({ events: allEvents, bytes, contentType, fileName });
    } catch (e) {
      return err(new ProtocolError(`Download from DynamicFileHandler failed: ${e instanceof Error ? e.message : String(e)}`));
    }
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

    // For PDF: check if it is already the current selection (skip SaveValue).
    if (format === 'pdf') {
      const currentValue = availableOptions.find(o => o.text === label)?.value;
      const currentIndex = availableOptions.findIndex(o => o.text === label);
      // BC typically pre-selects PDF (index 0). If it is index 0 or current, skip.
      // We check by optionIndex on the node (if present) or default to index 0.
      // Since we cannot reliably know the pre-selection from the raw dialog tree
      // without full PropertyChanged hydration, and PDF is always BC's default,
      // we skip SaveValue for pdf unconditionally.
      void currentValue; void currentIndex;
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
