import { createInterface } from 'node:readline';

const PORT = process.env.PORT ?? '3000';
const BASE_URL = `http://127.0.0.1:${PORT}`;

const rl = createInterface({ input: process.stdin, terminal: false });

/**
 * Only valid JSON-RPC messages may reach stdout — a raw 401/500 error body
 * or a reply without an id would corrupt the JSON-RPC stdio stream.
 */
function isJsonRpcMessage(text: string): boolean {
  try {
    const msg = JSON.parse(text) as { jsonrpc?: unknown; id?: unknown };
    return typeof msg === 'object' && msg !== null && msg.jsonrpc === '2.0'
      && (typeof msg.id === 'number' || typeof msg.id === 'string');
  } catch {
    return false;
  }
}

rl.on('line', async (line: string) => {
  if (!line.trim()) return;

  // Extract the request id up front. A parseable request without a
  // number/string id is a notification — invalid replies to it are suppressed.
  let requestId: number | string | null = null;
  let isNotification = false;
  try {
    const request = JSON.parse(line) as { id?: unknown };
    if (typeof request.id === 'number' || typeof request.id === 'string') requestId = request.id;
    else isNotification = true;
  } catch { /* unparseable request — synthesize errors with id null */ }

  try {
    const response = await fetch(`${BASE_URL}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: line,
    });

    const text = await response.text();
    if (isJsonRpcMessage(text)) {
      process.stdout.write(text + '\n');
    } else if (!isNotification) {
      const errorResponse = {
        jsonrpc: '2.0',
        id: requestId,
        error: { code: -32603, message: `Invalid server response (HTTP ${response.status})` },
      };
      process.stdout.write(JSON.stringify(errorResponse) + '\n');
    }
    // Notification with a non-JSON-RPC reply: suppress — nothing to answer.
  } catch (e) {
    if (isNotification) return;
    const error = e instanceof Error ? e.message : String(e);
    const errorResponse = {
      jsonrpc: '2.0',
      id: requestId,
      error: { code: -32603, message: `Server connection failed: ${error}` },
    };
    process.stdout.write(JSON.stringify(errorResponse) + '\n');
  }
});

rl.on('close', () => {
  process.exit(0);
});
