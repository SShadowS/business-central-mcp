import type { BCInteraction } from './types.js';

export interface SessionContext {
  sessionId: string;
  sessionKey: string;
  company: string;
  tenantId: string;
  spaInstanceId: string;
}

export interface EncodeContext {
  callbackId: string;
  sequenceNo: string;
  lastClientAckSequenceNumber: number;
  openFormIds: ReadonlySet<string>;
  session: SessionContext;
}

export interface EncodedRpcCall {
  method: string;
  params: unknown[];
}

const BC_FEATURES = [
  'QueueInteractions', 'MetadataCache', 'CacheSession', 'DynamicsQuickEntry',
  'Multitasking', 'MultilineEdit', 'SaveValueToDatabasePromptly', 'CalcOnlyVisibleFlowFields',
];

const BC_SUPPORTED_EXTENSIONS = JSON.stringify([
  { Name: 'Microsoft.Dynamics.Nav.Client.PageNotifier' },
  { Name: 'Microsoft.Dynamics.Nav.Client.Capabilities.Tour' },
  { Name: 'Microsoft.Dynamics.Nav.Client.Capabilities.UserTours' },
  { Name: 'Microsoft.Dynamics.Nav.Client.Capabilities.AppSource' },
  { Name: 'Microsoft.Dynamics.Nav.Client.Capabilities.Designer' },
]);

export class InteractionEncoder {
  /**
   * @param clientVersion  BC client version string (e.g. "27.0.0.0").
   * @param applicationId  navigationContext.applicationId sent in OpenSession/Invoke.
   *   Must match what the NST expects for the target BC build. The web client on
   *   the SaaS/cronus images sends "FIN" (the default). On some on-prem BC 27
   *   (ltsc2025) containers the server expects "NAV" and throws
   *   NavCancelCredentialPromptException on OpenSession with "FIN" even though the
   *   WS handshake succeeds. Override via BC_APPLICATION_ID for those builds.
   */
  constructor(
    readonly clientVersion: string,
    private readonly applicationId: string = 'FIN',
  ) {}

  encode(interaction: BCInteraction, context: EncodeContext): EncodedRpcCall {
    const invocation = this.buildInvocation(interaction, context.callbackId);
    return {
      method: 'Invoke',
      params: [{
        sessionId: context.session.sessionId,
        sessionKey: context.session.sessionKey,
        company: context.session.company,
        tenantId: context.session.tenantId,
        openFormIds: Array.from(context.openFormIds),
        interactionsToInvoke: [invocation],
        sequenceNo: context.sequenceNo,
        lastClientAckSequenceNumber: context.lastClientAckSequenceNumber,
        navigationContext: {
          applicationId: this.applicationId,
          deviceCategory: 0,
          spaInstanceId: context.session.spaInstanceId,
        },
        features: BC_FEATURES,
        supportedExtensions: BC_SUPPORTED_EXTENSIONS,
        telemetryClientActivityId: null,
        telemetryClientSessionId: null,
      }],
    };
  }

  /**
   * OpenSession login parameters (verified against decompiled BC):
   * - tenantId: tenant to connect to
   * - profile: BC profile id (e.g. "BUSINESS MANAGER"). Server uppercases and trims.
   *   Unknown ids silently fall back to the user's default profile, with a
   *   `ConnectionWarning.MissingProfile` returned in UserSettings. Empty string
   *   = use server default.
   *
   * Reference: `Microsoft.Dynamics.Framework.UI.Web/CallbackRequestData.cs`
   * Profile field; `Microsoft.Dynamics.Nav.Service/NSService.cs:OpenConnection`
   * resolution logic.
   */
  encodeOpenSession(tenantId: string, spaInstanceId: string, profile?: string): EncodedRpcCall {
    return {
      method: 'OpenSession',
      params: [{
        openFormIds: [],
        sessionId: '',
        sequenceNo: null,
        lastClientAckSequenceNumber: -1,
        telemetryClientActivityId: null,
        telemetryTraceStartInfo: 'traceStartInfo=%5BWeb%20Client%20-%20Web%20browser%5D%20OpenForm',
        navigationContext: {
          applicationId: this.applicationId,
          deviceCategory: 0,
          spaInstanceId,
        },
        supportedExtensions: BC_SUPPORTED_EXTENSIONS,
        interactionsToInvoke: [{
          interactionName: 'OpenForm',
          skipExtendingSessionLifetime: false,
          namedParameters: JSON.stringify({
            query: `tenant=${tenantId}&runinframe=1`,
          }),
          callbackId: '0',
        }],
        tenantId,
        company: null,
        telemetryClientSessionId: null,
        features: BC_FEATURES,
        profile: profile ?? '',
        rememberCompany: false,
        timeZoneInformation: this.getTimezoneInfo(),
        profileDescription: { Id: null, Caption: null, Description: null },
        disableResponseSequencing: true,
      }],
    };
  }

  private getTimezoneInfo() {
    const now = new Date();
    const offset = -now.getTimezoneOffset();
    const year = now.getFullYear();
    const dstStart = this.lastSunday(year, 2); // March (0-indexed)
    const dstEnd = this.lastSunday(year, 9);   // October (0-indexed)
    return {
      timeZoneBaseOffset: offset,
      dstOffset: 60,
      dstPeriodStart: dstStart.toISOString(),
      dstPeriodEnd: dstEnd.toISOString(),
    };
  }

  private lastSunday(year: number, month: number): Date {
    const d = new Date(year, month + 1, 0); // Last day of month
    d.setDate(d.getDate() - d.getDay());    // Back to Sunday
    d.setHours(2, 0, 0, 0);
    return d;
  }

  private buildInvocation(interaction: BCInteraction, callbackId: string): Record<string, unknown> {
    switch (interaction.type) {
      case 'OpenForm':
        return { interactionName: 'OpenForm', namedParameters: JSON.stringify({ query: interaction.query }), controlPath: interaction.controlPath ?? 'server:c[0]', callbackId };
      case 'LoadForm':
        return { interactionName: 'LoadForm', formId: interaction.formId, namedParameters: JSON.stringify({ loadData: interaction.loadData, delayed: interaction.delayed ?? false, ...(interaction.openForm ? { openForm: true } : {}) }), callbackId };
      case 'CloseForm':
        return { interactionName: 'CloseForm', formId: interaction.formId, namedParameters: JSON.stringify({}), callbackId };
      case 'InvokeAction':
        return { interactionName: 'InvokeAction', formId: interaction.formId, controlPath: interaction.controlPath, namedParameters: JSON.stringify({ systemAction: interaction.systemAction ?? 0, key: null, repeaterControlTarget: null, ...interaction.namedParameters }), callbackId };
      case 'SaveValue':
        return { interactionName: 'SaveValue', formId: interaction.formId, controlPath: interaction.controlPath, namedParameters: JSON.stringify({ newValue: interaction.newValue }), callbackId };
      case 'Filter': {
        const filterParams: Record<string, unknown> = { filterOperation: interaction.filterOperation, filterColumnId: interaction.filterColumnId };
        if (interaction.filterValue !== undefined) filterParams['FilterValue'] = interaction.filterValue;
        return { interactionName: 'Filter', formId: interaction.formId, controlPath: interaction.controlPath, namedParameters: JSON.stringify(filterParams), callbackId };
      }
      case 'SetCurrentRow':
        return { interactionName: 'SetCurrentRowAndRowsSelection', formId: interaction.formId, controlPath: interaction.controlPath, namedParameters: JSON.stringify({ key: interaction.key, selectAll: false, rowsToSelect: [interaction.key], unselectAll: true, rowsToUnselect: [] }), callbackId };
      case 'ScrollRepeater':
        return { interactionName: 'ScrollRepeater', formId: interaction.formId, controlPath: interaction.controlPath, namedParameters: JSON.stringify({ delta: interaction.delta }), callbackId };
      case 'SessionAction':
        return { interactionName: interaction.actionName, namedParameters: JSON.stringify(interaction.namedParameters ?? {}), controlPath: interaction.controlPath ?? 'server:c[0]', callbackId };
    }
  }
}
