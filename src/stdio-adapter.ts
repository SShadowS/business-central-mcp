import { createInterface } from 'node:readline';

const PORT = process.env.PORT ?? '3000';
const BASE_URL = `http://127.0.0.1:${PORT}`;

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on('line', async (line: string) => {
  if (!line.trim()) return;

  try {
    const response = await fetch(`${BASE_URL}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: line,
    });

    const text = await response.text();
    process.stdout.write(text + '\n');
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    let id: unknown = null;
    try { id = (JSON.parse(line) as { id?: unknown }).id ?? null; } catch { /* ignore */ }
    const errorResponse = {
      jsonrpc: '2.0',
      id,
      error: { code: -32603, message: `Server connection failed: ${error}` },
    };
    process.stdout.write(JSON.stringify(errorResponse) + '\n');
  }
});

rl.on('close', () => {
  process.exit(0);
});
