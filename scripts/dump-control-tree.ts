/**
 * Diagnostic script: Connects to BC, opens pages 21 and 22,
 * extracts the FormCreated controlTree, and dumps to JSON files.
 *
 * Usage: cd U:/git/bc-mcp && npx tsx scripts/dump-control-tree.ts
 */
import { config as dotenvConfig } from 'dotenv';
import { writeFileSync, mkdirSync } from 'node:fs';
import { loadConfig } from '../src/core/config.js';
import { createNullLogger } from '../src/core/logger.js';
import { NTLMAuthProvider } from '../src/connection/auth/ntlm-provider.js';
import { ConnectionFactory } from '../src/connection/connection-factory.js';
import { EventDecoder } from '../src/protocol/event-decoder.js';
import { InteractionEncoder } from '../src/protocol/interaction-encoder.js';
import { SessionFactory } from '../src/session/session-factory.js';
import { isOk, isErr, unwrap } from '../src/core/result.js';
import { SystemAction } from '../src/protocol/types.js';
import type { BCSession } from '../src/session/bc-session.js';
import type { BCEvent, OpenFormInteraction, InvokeActionInteraction, CloseFormInteraction, LoadFormInteraction } from '../src/protocol/types.js';

dotenvConfig();

const RECORDINGS_DIR = 'U:/git/bc-mcp/tests/recordings';
const logger = createNullLogger();

async function createSession(): Promise<BCSession> {
  const appConfig = loadConfig();
  const auth = new NTLMAuthProvider({
    baseUrl: appConfig.bc.baseUrl,
    username: appConfig.bc.username,
    password: appConfig.bc.password,
    tenantId: appConfig.bc.tenantId,
  }, logger);
  const connFactory = new ConnectionFactory(auth, appConfig.bc, logger);
  const decoder = new EventDecoder();
  const encoder = new InteractionEncoder(appConfig.bc.clientVersionString);
  const sessionFactory = new SessionFactory(connFactory, decoder, encoder, logger, appConfig.bc.tenantId);

  const result = await sessionFactory.create();
  if (isErr(result)) {
    throw new Error(`Session creation failed: ${result.error.message}`);
  }
  return unwrap(result);
}

async function dismissDialogs(session: BCSession, events: BCEvent[]): Promise<void> {
  const dialogs = events.filter(e => e.type === 'DialogOpened');
  for (const dialog of dialogs) {
    if (dialog.type === 'DialogOpened' && dialog.formId) {
      console.error(`  Dismissing dialog: ${dialog.formId}`);
      await session.invoke(
        {
          type: 'InvokeAction',
          formId: dialog.formId,
          controlPath: 'server:c[0]',
          systemAction: SystemAction.Ok,
        } satisfies InvokeActionInteraction,
        (event) => event.type === 'InvokeCompleted',
      );
    }
  }
}

async function openPageAndDumpControlTree(
  session: BCSession,
  pageId: number,
  outputFile: string,
): Promise<void> {
  console.error(`\nOpening page ${pageId}...`);

  // Step 1: OpenForm
  const openResult = await session.invoke(
    {
      type: 'OpenForm',
      query: `page=${pageId}&tenant=default`,
      controlPath: 'server:c[0]',
    } satisfies OpenFormInteraction,
    (event) => event.type === 'InvokeCompleted',
  );

  if (isErr(openResult)) {
    throw new Error(`OpenForm for page ${pageId} failed: ${openResult.error.message}`);
  }

  const events = openResult.value;
  console.error(`  Got ${events.length} events from OpenForm`);
  console.error(`  Event types: ${events.map(e => e.type).join(', ')}`);

  // Dismiss any dialogs (e.g., license expiration)
  await dismissDialogs(session, events);

  // Find FormCreated events
  const formCreatedEvents = events.filter(e => e.type === 'FormCreated');
  console.error(`  Found ${formCreatedEvents.length} FormCreated event(s)`);

  if (formCreatedEvents.length === 0) {
    console.error(`  WARNING: No FormCreated events for page ${pageId}!`);
    // Dump all events for debugging
    writeFileSync(outputFile, JSON.stringify(events, null, 2), 'utf-8');
    console.error(`  Dumped all events to ${outputFile}`);
    return;
  }

  // The first FormCreated is typically the main page
  const mainForm = formCreatedEvents[0]!;
  const formId = mainForm.type === 'FormCreated' ? mainForm.formId : '';
  console.error(`  Main form ID: ${formId}`);

  // Step 2: LoadForm to get the full data
  const loadResult = await session.invoke(
    {
      type: 'LoadForm',
      formId,
      loadData: true,
    } satisfies LoadFormInteraction,
    (event) => event.type === 'InvokeCompleted',
  );

  let loadEvents: BCEvent[] = [];
  if (isOk(loadResult)) {
    loadEvents = loadResult.value;
    console.error(`  Got ${loadEvents.length} events from LoadForm`);
    console.error(`  LoadForm event types: ${loadEvents.map(e => e.type).join(', ')}`);
  } else {
    console.error(`  LoadForm failed: ${loadResult.error.message}`);
  }

  // Build comprehensive dump
  const dump = {
    pageId,
    formId,
    capturedAt: new Date().toISOString(),
    formCreatedEvents: formCreatedEvents.map(e => {
      if (e.type === 'FormCreated') {
        return {
          formId: e.formId,
          parentFormId: e.parentFormId,
          isReload: e.isReload,
          controlTree: e.controlTree,
        };
      }
      return e;
    }),
    loadFormEvents: loadEvents,
    allOpenFormEvents: events,
  };

  writeFileSync(outputFile, JSON.stringify(dump, null, 2), 'utf-8');
  console.error(`  Written to ${outputFile}`);

  // Close the form
  try {
    await session.invoke(
      {
        type: 'CloseForm',
        formId,
      } satisfies CloseFormInteraction,
      (event) => event.type === 'InvokeCompleted',
    );
    console.error(`  Closed form ${formId}`);
  } catch (e) {
    console.error(`  Warning: CloseForm failed: ${e}`);
  }
}

async function main() {
  mkdirSync(RECORDINGS_DIR, { recursive: true });

  console.error('Creating BC session...');
  const session = await createSession();
  console.error('Session created.');

  try {
    // Page 21: Customer Card
    await openPageAndDumpControlTree(
      session,
      21,
      `${RECORDINGS_DIR}/page21-control-tree.json`,
    );

    // Page 22: Customer List
    await openPageAndDumpControlTree(
      session,
      22,
      `${RECORDINGS_DIR}/page22-control-tree.json`,
    );

    console.error('\nDone! Control trees dumped to:');
    console.error(`  ${RECORDINGS_DIR}/page21-control-tree.json`);
    console.error(`  ${RECORDINGS_DIR}/page22-control-tree.json`);
  } finally {
    session.close();
  }
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
