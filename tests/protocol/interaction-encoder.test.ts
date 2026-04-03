import { describe, it, expect } from 'vitest';
import { InteractionEncoder, type SessionContext } from '../../src/protocol/interaction-encoder.js';
import type { OpenFormInteraction, SaveValueInteraction } from '../../src/protocol/types.js';

describe('InteractionEncoder', () => {
  const encoder = new InteractionEncoder('27.0.0.0');

  const testSession: SessionContext = {
    sessionId: 'test-session-id',
    sessionKey: 'test-session-key',
    company: 'CRONUS',
    tenantId: 'default',
    spaInstanceId: 'testspa123',
  };

  it('encodes OpenForm interaction', () => {
    const interaction: OpenFormInteraction = {
      type: 'OpenForm',
      query: 'page=22&tenant=default',
      controlPath: 'server:c[0]',
    };
    const result = encoder.encode(interaction, {
      callbackId: 'cb-1',
      sequenceNo: 'spa1#1',
      lastClientAckSequenceNumber: 0,
      openFormIds: new Set(['form1']),
      session: testSession,
    });
    expect(result.method).toBe('Invoke');
    const params = result.params[0] as Record<string, unknown>;
    expect(params.sequenceNo).toBe('spa1#1');
    expect(params.sessionId).toBe('test-session-id');
    expect(params.sessionKey).toBe('test-session-key');
    expect(params.company).toBe('CRONUS');
    expect(params.tenantId).toBe('default');
    expect(params.features).toBeInstanceOf(Array);
    expect(typeof params.supportedExtensions).toBe('string');
    const navCtx = params.navigationContext as Record<string, unknown>;
    expect(navCtx.applicationId).toBe('FIN');
    expect(navCtx.spaInstanceId).toBe('testspa123');
    const interactions = params.interactionsToInvoke as unknown[];
    expect(interactions.length).toBe(1);
    const inv = interactions[0] as Record<string, unknown>;
    expect(inv.interactionName).toBe('OpenForm');
    expect(inv.callbackId).toBe('cb-1');
    expect(typeof inv.namedParameters).toBe('string'); // JSON string on wire
  });

  it('encodes SaveValue interaction', () => {
    const interaction: SaveValueInteraction = {
      type: 'SaveValue',
      formId: 'form123',
      controlPath: 'server:c[2]/c[0]/c[3]',
      newValue: 'test value',
    };
    const result = encoder.encode(interaction, {
      callbackId: 'cb-2',
      sequenceNo: 'spa1#2',
      lastClientAckSequenceNumber: 1,
      openFormIds: new Set(['form123']),
      session: testSession,
    });
    const params = result.params[0] as Record<string, unknown>;
    expect(params.sessionId).toBe('test-session-id');
    const inv = (params.interactionsToInvoke as Record<string, unknown>[])[0]!;
    expect(inv.interactionName).toBe('SaveValue');
    expect(inv.formId).toBe('form123');
    const namedParams = JSON.parse(inv.namedParameters as string);
    expect(namedParams.newValue).toBe('test value');
  });

  it('includes openFormIds in request', () => {
    const interaction: SaveValueInteraction = {
      type: 'SaveValue',
      formId: 'form1',
      controlPath: 'c[0]',
      newValue: 'x',
    };
    const result = encoder.encode(interaction, {
      callbackId: 'cb-3',
      sequenceNo: 'spa1#3',
      lastClientAckSequenceNumber: 2,
      openFormIds: new Set(['form1', 'form2', 'dialogForm3']),
      session: testSession,
    });
    const params = result.params[0] as Record<string, unknown>;
    const openFormIds = params.openFormIds as string[];
    expect(openFormIds).toContain('form1');
    expect(openFormIds).toContain('form2');
    expect(openFormIds).toContain('dialogForm3');
  });

  it('encodes InvokeAction with systemAction', () => {
    const interaction = {
      type: 'InvokeAction' as const,
      formId: 'form1',
      controlPath: 'server:c[2]/c[0]',
      systemAction: 40,
    };
    const result = encoder.encode(interaction, {
      callbackId: 'cb-4',
      sequenceNo: 'spa1#4',
      lastClientAckSequenceNumber: 3,
      openFormIds: new Set(['form1']),
      session: testSession,
    });
    const params = result.params[0] as Record<string, unknown>;
    const inv = (params.interactionsToInvoke as Record<string, unknown>[])[0]!;
    expect(inv.interactionName).toBe('InvokeAction');
    const namedParams = JSON.parse(inv.namedParameters as string);
    expect(namedParams.systemAction).toBe(40);
  });

  it('encodes Filter with AddLine operation', () => {
    const interaction = {
      type: 'Filter' as const,
      formId: 'form1',
      controlPath: 'server:c[1]',
      filterOperation: 1,
      filterColumnId: '36_Sales Header.3',
      filterValue: '101002',
    };
    const result = encoder.encode(interaction, {
      callbackId: 'cb-5',
      sequenceNo: 'spa1#5',
      lastClientAckSequenceNumber: 4,
      openFormIds: new Set(['form1']),
      session: testSession,
    });
    const params = result.params[0] as Record<string, unknown>;
    const inv = (params.interactionsToInvoke as Record<string, unknown>[])[0]!;
    expect(inv.interactionName).toBe('Filter');
    const namedParams = JSON.parse(inv.namedParameters as string);
    expect(namedParams.filterOperation).toBe(1);
    expect(namedParams.filterColumnId).toBe('36_Sales Header.3');
  });

  it('encodes SetCurrentRow', () => {
    const interaction = {
      type: 'SetCurrentRow' as const,
      formId: 'form1',
      controlPath: 'server:c[1]',
      key: 'bookmark-abc',
    };
    const result = encoder.encode(interaction, {
      callbackId: 'cb-6',
      sequenceNo: 'spa1#6',
      lastClientAckSequenceNumber: 5,
      openFormIds: new Set(['form1']),
      session: testSession,
    });
    const params = result.params[0] as Record<string, unknown>;
    const inv = (params.interactionsToInvoke as Record<string, unknown>[])[0]!;
    expect(inv.interactionName).toBe('SetCurrentRowAndRowsSelection');
    const namedParams = JSON.parse(inv.namedParameters as string);
    expect(namedParams.key).toBe('bookmark-abc');
  });

  it('encodes OpenSession handshake', () => {
    const result = encoder.encodeOpenSession('default', 'spa-abc');
    expect(result.method).toBe('OpenSession');
    const params = result.params[0] as Record<string, unknown>;
    expect(params.sessionId).toBe('');
    expect(params.tenantId).toBe('default');
    expect(params.company).toBeNull();
    expect(params.lastClientAckSequenceNumber).toBe(-1);
    expect(params.features).toBeInstanceOf(Array);
    expect(typeof params.supportedExtensions).toBe('string');
    const navCtx = params.navigationContext as Record<string, unknown>;
    expect(navCtx.applicationId).toBe('FIN');
    expect(navCtx.spaInstanceId).toBe('spa-abc');
    const interactions = params.interactionsToInvoke as Record<string, unknown>[];
    expect(interactions.length).toBe(1);
    expect(interactions[0]!.interactionName).toBe('OpenForm');
    const tz = params.timeZoneInformation as Record<string, unknown>;
    expect(typeof tz.timeZoneBaseOffset).toBe('number');
    expect(typeof tz.dstPeriodStart).toBe('string');
  });
});
