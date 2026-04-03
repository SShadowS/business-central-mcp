import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { config as dotenvConfig } from 'dotenv';

dotenvConfig();

const PORT = '3456'; // Use a non-default port to avoid conflicts
const BASE_URL = `http://127.0.0.1:${PORT}`;

describe('MCP Endpoint (integration)', () => {
  let serverProcess: ChildProcess;
  let serverStderr = '';

  beforeAll(async () => {
    // Start the server as a child process
    serverProcess = spawn('node', ['node_modules/tsx/dist/cli.mjs', 'src/server.ts'], {
      cwd: 'U:/git/bc-mcp',
      env: { ...process.env, PORT },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
    });

    // Capture stderr for debugging
    serverProcess.stderr?.on('data', (chunk: Buffer) => {
      serverStderr += chunk.toString();
    });
    serverProcess.stdout?.on('data', (chunk: Buffer) => {
      serverStderr += chunk.toString(); // capture stdout too for logs
    });

    // Wait for server to be ready (poll /health)
    const maxWait = 30_000;
    const start = Date.now();
    let ready = false;
    while (Date.now() - start < maxWait) {
      try {
        const resp = await fetch(`${BASE_URL}/health`);
        if (resp.ok) {
          ready = true;
          break;
        }
      } catch {
        // Not ready yet
      }
      await new Promise(r => setTimeout(r, 500));
    }

    if (!ready) {
      console.error('Server stderr:\n', serverStderr);
      throw new Error('Server did not become ready within 30s');
    }
  }, 60_000);

  afterAll(async () => {
    if (serverProcess && !serverProcess.killed) {
      serverProcess.kill('SIGTERM');
    }
  });

  async function mcpCall(method: string, params?: unknown): Promise<unknown> {
    const response = await fetch(`${BASE_URL}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
    });
    return response.json();
  }

  it('initializes MCP protocol', async () => {
    const result = await mcpCall('initialize', {
      protocolVersion: '2025-06-18',
      clientInfo: { name: 'test', version: '1.0' },
      capabilities: {},
    }) as any;

    console.error('initialize response:', JSON.stringify(result, null, 2));

    expect(result.error).toBeUndefined();
    expect(result.result).toBeDefined();
    expect(result.result.protocolVersion).toBe('2025-06-18');
    expect(result.result.serverInfo.name).toBe('bc-mcp');
    expect(result.result.capabilities.tools).toBeDefined();
  }, 60_000);

  it('lists 8 tools', async () => {
    const result = await mcpCall('tools/list') as any;
    const tools = result.result.tools;
    expect(tools).toHaveLength(8);

    const names = tools.map((t: any) => t.name);
    expect(names).toContain('bc_open_page');
    expect(names).toContain('bc_read_data');
    expect(names).toContain('bc_write_data');
    expect(names).toContain('bc_execute_action');
    expect(names).toContain('bc_close_page');
    expect(names).toContain('bc_search_pages');
    expect(names).toContain('bc_navigate');
    expect(names).toContain('bc_respond_dialog');

    console.error('Tools:', names.join(', '));
  });

  it('opens Customer List (page 22) via tools/call', async () => {
    const result = await mcpCall('tools/call', {
      name: 'bc_open_page',
      arguments: { pageId: '22' },
    }) as any;

    // Should not be an error
    expect(result.error).toBeUndefined();
    expect(result.result).toBeDefined();
    expect(result.result.isError).toBeUndefined();

    // Parse the text content
    const content = result.result.content[0].text;
    const data = JSON.parse(content);

    console.error('open_page keys:', Object.keys(data));
    console.error('pageContextId:', data.pageContextId);

    // Verify core shape
    expect(data.pageContextId).toBeTruthy();
    expect(data.pageContextId).toContain('page:22');

    // Should have fields metadata
    expect(data.fields).toBeDefined();
    expect(Array.isArray(data.fields) || typeof data.fields === 'object').toBe(true);

    // Should have rows for a list page
    expect(data.rows).toBeDefined();
    if (Array.isArray(data.rows)) {
      expect(data.rows.length).toBeGreaterThan(0);
      console.error(`Got ${data.rows.length} rows`);
    }
  }, 60_000);
});
