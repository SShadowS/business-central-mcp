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
