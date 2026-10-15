import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { MCPHandler } from '../../src/mcp/handler.js';
import { SKILLS } from '../../src/mcp/skills.js';
import { buildToolRegistry, type Operations } from '../../src/mcp/tool-registry.js';

const log = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });
const req = (method: string, params?: unknown, id: unknown = 1) => ({ jsonrpc: '2.0', id, method, params });

describe('SKILLS registry', () => {
  it('each skill has frontmatter name/description and a self-consistent manifest', () => {
    for (const s of SKILLS) {
      expect(s.entry.frontmatter.name.length).toBeGreaterThan(0);
      expect(s.entry.frontmatter.description.length).toBeGreaterThan(20);
      expect(s.entry.uri).toBe(`skill://${s.entry.frontmatter.name}/SKILL.md`);
      expect(s.content.startsWith('---\n')).toBe(true);            // frontmatter first
      const m = s.entry.resources[0]!;
      const bytes = Buffer.from(s.content, 'utf8');
      expect(m.size).toBe(bytes.byteLength);                        // size = served bytes
      expect(m.digest).toBe('sha256:' + createHash('sha256').update(bytes).digest('hex'));
    }
  });

  it('every backticked bc_ tool name in each SKILL.md resolves in tools/list', () => {
    const names = new Set(buildToolRegistry({} as Operations).map(t => t.name));
    for (const s of SKILLS)
      for (const [, name] of s.content.matchAll(/`(bc_[a-z_]+)`/g))
        expect(names, `${name} in ${s.entry.frontmatter.name}`).toContain(name);
  });
});

describe('MCPHandler — skills extension', () => {
  const h = new MCPHandler([], log(), [], { skills: SKILLS });

  it('advertises the extension on initialize when skills are present', async () => {
    const caps = (await h.handleRequest(req('initialize'))).result as any;
    expect(caps.capabilities.extensions['io.modelcontextprotocol/skills']).toEqual({ directoryRead: false });
    expect(caps.capabilities.resources).toBeDefined();
  });

  it('omits the extension when no skills are supplied', async () => {
    const caps = (await new MCPHandler([], log()).handleRequest(req('initialize'))).result as any;
    expect(caps.capabilities.extensions).toBeUndefined();
  });

  it('skills/list returns the skill with frontmatter and a sha256 digest', async () => {
    const r = (await h.handleRequest(req('skills/list'))).result as any;
    expect(r.resultType).toBe('complete');
    expect(r.cacheScope).toBe('public');
    expect(r.skills.map((s: any) => s.frontmatter.name)).toContain('bc-ui-recovery');
    expect(r.skills[0].resources[0].digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('skills/get returns the entry by uri', async () => {
    const r = (await h.handleRequest(req('skills/get', { uri: 'skill://bc-ui-recovery/SKILL.md' }))).result as any;
    expect(r.skill.frontmatter.name).toBe('bc-ui-recovery');
  });

  it('skills/get rejects an unknown uri with -32602', async () => {
    const res = await h.handleRequest(req('skills/get', { uri: 'skill://nope/SKILL.md' }));
    expect(res.result).toBeUndefined();
    expect(res.error!.code).toBe(-32602);
  });

  it('skills/get rejects a missing uri with -32602', async () => {
    expect((await h.handleRequest(req('skills/get', {}))).error!.code).toBe(-32602);
  });

  it('resources/read returns the SKILL.md bytes', async () => {
    const r = (await h.handleRequest(req('resources/read', { uri: 'skill://bc-ui-recovery/SKILL.md' }))).result as any;
    expect(r.contents[0].mimeType).toBe('text/markdown');
    expect(r.contents[0].text).toContain('operationId');
  });

  it('resources/read still -32601 for a non-skill uri', async () => {
    expect((await h.handleRequest(req('resources/read', { uri: 'bc://x' }))).error!.code).toBe(-32601);
  });

  it('resources/list enumerates the skill file', async () => {
    const r = (await h.handleRequest(req('resources/list'))).result as any;
    expect(r.resources.map((x: any) => x.uri)).toContain('skill://bc-ui-recovery/SKILL.md');
  });
});
