// src/mcp/skills.ts
//
// MCP Skills extension (SEP-2640, io.modelcontextprotocol/skills). A skill is a
// SKILL.md served over the Resources primitive: skills/list + skills/get return
// its manifest, resources/read returns its bytes. The content is embedded here
// and its digest/size are computed at load, so the manifest can never go stale.

import { createHash } from 'node:crypto';

export interface SkillResourceManifest {
  readonly uri: string;
  readonly digest: string; // "sha256:<hex>"
  readonly size: number;   // raw UTF-8 byte length
}
export interface SkillFrontmatter {
  readonly name: string;
  readonly description: string;
}
export interface SkillEntry {
  readonly uri: string;
  readonly frontmatter: SkillFrontmatter;
  readonly resources: SkillResourceManifest[];
}
export interface SkillDefinition {
  readonly entry: SkillEntry;
  readonly content: string; // full SKILL.md (frontmatter + body) — the bytes served
}

/** SEP-2640 cache fields: freshness hints only, not integrity. */
export const SKILL_TTL_MS = 300_000;
export const SKILL_CACHE_SCOPE = 'public';

/** Assemble a single-file skill, deriving uri/digest/size from the served bytes. */
function defineSkill(name: string, description: string, body: string): SkillDefinition {
  const content = `---\nname: ${name}\ndescription: ${description}\n---\n\n${body.replace(/^\n+/, '')}`;
  const bytes = Buffer.from(content, 'utf8');
  const uri = `skill://${name}/SKILL.md`;
  const digest = 'sha256:' + createHash('sha256').update(bytes).digest('hex');
  return { content, entry: { uri, frontmatter: { name, description }, resources: [{ uri, digest, size: bytes.byteLength }] } };
}

const RECOVERY_BODY = `
# Recovering from a failed Business Central UI action

This server drives the BC web client. Mutating tools — \`bc_execute_action\`,
\`bc_write_data\`, \`bc_respond_dialog\`, \`bc_wizard_navigate\`, \`bc_close_page\`,
\`bc_switch_company\`, \`bc_run_report\`, \`bc_upload_file\`, \`bc_run_tests\` — can fail mid-flow.
Follow the rules below instead of blindly retrying; a blind retry on a mutating
call can double-post.

## 1. Make every mutating call idempotent

Pass an \`operationId\` (a UUID you generate and keep) on every mutating call.
A retry with the same \`operationId\` and the same arguments replays the first
call's result without touching BC. Each result carries \`replaySafe\`: \`true\`
means BC proved a re-run cannot double-apply (the write was echoed, or the form
it acted on is now closed); \`false\` means read the record back before retrying.

## 2. Confirm and choice dialogs

\`bc_execute_action\` (e.g. a Post) often opens a dialog instead of finishing.
The result then carries \`requiresDialogResponse: true\` and the dialog's
\`dialogFormId\`, and the new form appears in \`openedPages\`. Answer it:

    bc_respond_dialog { dialogFormId: "<from the result>", response: "yes" }

\`response\` is one of \`"yes"\`, \`"no"\`, \`"ok"\`, \`"cancel"\`. A posting-choice
dialog ("Ship / Invoice / Ship and Invoice") needs the choice selected before
you confirm. After answering, re-read with \`bc_read_data\`; a \`BUSINESS_ERROR\`
means BC rejected the operation — surface the message, do not retry the post.

## 3. A dropped or dead session (SESSION_LOST)

A session-killing error returns code \`SESSION_LOST\` with
\`impactedPageContextIds\` (now dead) and \`reconnectFailed\`. The server already
reconnected with backoff; you do NOT reconnect yourself. Instead:

1. Treat every \`pageContextId\` you held as invalid — re-open the pages you need
   with \`bc_open_page\` (and re-\`bc_navigate\` / re-drill to the record).
2. If the lost call was a mutation, go to section 5 before repeating it.
3. \`reconnectFailed: true\` means the server could not get back in — stop and
   report; do not loop.

A stale modal from a crashed session is reconciled by the server automatically
(it closes leftover dialogs). You only retry the original call once the new
session is up.

## 4. Multi-row actions, card stubs, company names

- \`MULTI_ROW_ACTION_UNAVAILABLE\`: the action (usually Delete) is disabled by BC
  for a multi-row selection on this page. Do not retry the set — act one row at
  a time, or reduce the selection.
- \`CARDPART_STUB\` (code \`CARDPART_STUB\`): a CardPart opened standalone returned
  an empty shell. Reach it through its host page named in the error's
  \`hostHint\`, not directly.
- \`COMPANY_NOT_FOUND\` from \`bc_switch_company\`: company names are
  case-SENSITIVE and the session is untouched (still on the old company). Fix
  the name (list valid ones with \`bc_list_companies\`) and retry.

## 5. An in-doubt write — did it land?

A \`TIMEOUT\`, \`SESSION_LOST\`, or \`OPERATION_IN_DOUBT\` on a mutating call means
the outcome is unknown: BC may have committed. Before retrying under a NEW
\`operationId\`, read the record back:

    bc_get_operation { operationId: "<the same id>" }

It re-opens the target by page id and record bookmark, reads the key fields and
(for a document) its lines, and returns \`readBack\` plus an \`evidenceHash\`. Use
that to decide: if the change is already present, do not re-run; if it is
absent and \`replaySafe\` was false, run the call again under a fresh
\`operationId\`. Never retry an in-doubt post without this check.
`;

export const SKILLS: SkillDefinition[] = [
  defineSkill(
    'bc-ui-recovery',
    'Recover from failures of the mutating Business Central UI tools (bc_execute_action, bc_write_data, bc_respond_dialog, bc_wizard_navigate, bc_close_page): answer confirm/choice dialogs, reconnect after a dropped session, and decide whether an in-doubt write landed before retrying. Read this before driving any posting, deletion, or multi-step document flow.',
    RECOVERY_BODY,
  ),
];

/** The SKILL.md resource for a resources/read uri, or undefined. */
export function findSkillResource(skills: SkillDefinition[], uri: string): { text: string } | undefined {
  const hit = skills.find(s => s.entry.uri === uri);
  return hit ? { text: hit.content } : undefined;
}
