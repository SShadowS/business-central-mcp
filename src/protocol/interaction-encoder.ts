import type { BCInteraction } from './types.js';

export interface EncodeContext {
  callbackId: string;
  sequenceNo: string;
  lastClientAckSequenceNumber: number;
  openFormIds: ReadonlySet<string>;
}

export interface EncodedRpcCall {
  method: string;
  params: unknown[];
}

export class InteractionEncoder {
  constructor(private readonly clientVersion: string) {}

  encode(interaction: BCInteraction, context: EncodeContext): EncodedRpcCall {
    const invocation = this.buildInvocation(interaction, context.callbackId);
    return {
      method: 'Invoke',
      params: [{
        openFormIds: Array.from(context.openFormIds),
        interactionsToInvoke: [invocation],
        sequenceNo: context.sequenceNo,
        lastClientAckSequenceNumber: context.lastClientAckSequenceNumber,
        clientVersion: this.clientVersion,
      }],
    };
  }

  private buildInvocation(interaction: BCInteraction, callbackId: string): Record<string, unknown> {
    switch (interaction.type) {
      case 'OpenForm':
        return { interactionName: 'OpenForm', namedParameters: JSON.stringify({ query: interaction.query }), controlPath: interaction.controlPath ?? 'server:c[0]', callbackId };
      case 'LoadForm':
        return { interactionName: 'LoadForm', formId: interaction.formId, namedParameters: JSON.stringify({ loadData: interaction.loadData, delayed: interaction.delayed ?? false }), callbackId };
      case 'CloseForm':
        return { interactionName: 'CloseForm', formId: interaction.formId, namedParameters: JSON.stringify({}), callbackId };
      case 'InvokeAction':
        return { interactionName: 'InvokeAction', formId: interaction.formId, controlPath: interaction.controlPath, namedParameters: JSON.stringify({ systemAction: interaction.systemAction ?? 0, ...interaction.namedParameters }), callbackId };
      case 'SaveValue':
        return { interactionName: 'SaveValue', formId: interaction.formId, controlPath: interaction.controlPath, namedParameters: JSON.stringify({ newValue: interaction.newValue }), callbackId };
      case 'Filter':
        return { interactionName: 'Filter', formId: interaction.formId, controlPath: interaction.controlPath, namedParameters: JSON.stringify({ filterOperation: interaction.filterOperation, filterColumnId: interaction.filterColumnId, filterValue: interaction.filterValue }), callbackId };
      case 'SetCurrentRow':
        return { interactionName: 'SetCurrentRowAndRowsSelection', formId: interaction.formId, controlPath: interaction.controlPath, namedParameters: JSON.stringify({ key: interaction.key }), callbackId };
      case 'SessionAction':
        return { interactionName: interaction.actionName, namedParameters: JSON.stringify(interaction.namedParameters ?? {}), controlPath: interaction.controlPath ?? 'server:c[0]', callbackId };
    }
  }
}
