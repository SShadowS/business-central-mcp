import { describe, it, expect } from 'vitest';
import { buildToolRegistry, type Operations } from '../../src/mcp/tool-registry.js';

const mockOps = {
  openPage: { execute: async () => ({}) },
  readData: { execute: async () => ({}) },
  writeData: { execute: async () => ({}) },
  executeAction: { execute: async () => ({}) },
  closePage: { execute: async () => ({}) },
  searchPages: { execute: async () => ({}) },
  navigate: { execute: async () => ({}) },
  respondDialog: { execute: async () => ({}) },
  switchCompany: { execute: async () => ({}) },
  listCompanies: { execute: async () => ({}) },
  runReport: { execute: async () => ({}) },
  wizardNavigate: { execute: async () => ({}) },
  lookup: { execute: async () => ({}) },
  query: { execute: async () => ({}) },
  uploadFile: { execute: async () => ({}) },
  getOperation: { execute: async () => ({}) },
} as unknown as Operations;

describe('tool descriptions', () => {
  const tools = buildToolRegistry(mockOps);

  it('every tool has at least 3 sentences in description', () => {
    for (const tool of tools) {
      const sentences = tool.description.split(/[.!?]+/).filter(s => s.trim().length > 0);
      expect(sentences.length, `${tool.name} has only ${sentences.length} sentences`).toBeGreaterThanOrEqual(3);
    }
  });

  it('every tool description mentions related tools', () => {
    for (const tool of tools) {
      const otherTools = tools.filter(t => t.name !== tool.name);
      const mentionsOther = otherTools.some(t => tool.description.includes(t.name));
      expect(mentionsOther, `${tool.name} does not mention any other bc_ tool`).toBe(true);
    }
  });

  it('marks bc_query and the bc_data_* / bc_api_* tools as the only session-independent tools', () => {
    const independent = tools.filter(t => t.sessionIndependent).map(t => t.name).sort();
    expect(independent).toEqual([
      'bc_api_describe', 'bc_api_invoke', 'bc_api_list', 'bc_api_search',
      'bc_data_find_tables', 'bc_data_get_table_relations', 'bc_data_get_table_schema', 'bc_data_query', 'bc_query',
    ]);
  });

  it('every tool declares explicit read-only/destructive/idempotent annotations', () => {
    for (const tool of tools) {
      const a = tool.annotations;
      expect(typeof a.readOnlyHint, `${tool.name} readOnlyHint`).toBe('boolean');
      expect(a.openWorldHint, `${tool.name} openWorldHint`).toBe(false);
      if (!a.readOnlyHint) {
        expect(typeof a.destructiveHint, `${tool.name} destructiveHint`).toBe('boolean');
        expect(typeof a.idempotentHint, `${tool.name} idempotentHint`).toBe('boolean');
      }
    }
  });

  it('classifies read-only tools exactly', () => {
    const readOnly = tools.filter(t => t.annotations.readOnlyHint).map(t => t.name).sort();
    expect(readOnly).toEqual([
      'bc_api_describe', 'bc_api_list', 'bc_api_search',
      'bc_data_find_tables', 'bc_data_get_table_relations', 'bc_data_get_table_schema', 'bc_data_query',
      'bc_get_operation', 'bc_list_companies', 'bc_lookup', 'bc_navigate', 'bc_open_page',
      'bc_query', 'bc_read_data', 'bc_search_pages',
    ]);
  });

  it('bc_execute_action describes create/delete workflow', () => {
    const tool = tools.find(t => t.name === 'bc_execute_action')!;
    expect(tool.description).toContain('New');
    expect(tool.description).toContain('Delete');
  });

  it('bc_respond_dialog describes dialog chaining', () => {
    const tool = tools.find(t => t.name === 'bc_respond_dialog')!;
    expect(tool.description).toContain('chain');
  });
});
