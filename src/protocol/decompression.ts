import { gunzipSync } from 'node:zlib';
import { ok, err, type Result } from '../core/result.js';
import { ProtocolError } from '../core/errors.js';

export function decompressPayload(base64Data: string): Result<unknown, ProtocolError> {
  try {
    const buffer = Buffer.from(base64Data, 'base64');
    const decompressed = gunzipSync(buffer);
    const text = decompressed.toString('utf8');
    return ok(JSON.parse(text));
  } catch (e) {
    return err(new ProtocolError(
      `Failed to decompress BC payload: ${e instanceof Error ? e.message : String(e)}`,
      { base64Length: base64Data.length }
    ));
  }
}

export function decompressIfNeeded(message: unknown): Result<unknown, ProtocolError> {
  if (!message || typeof message !== 'object') return ok(message);
  const msg = message as Record<string, unknown>;

  if (msg.result && typeof msg.result === 'object') {
    const result = msg.result as Record<string, unknown>;
    if (typeof result.compressedResult === 'string') return decompressPayload(result.compressedResult);
    if (typeof result.compressedData === 'string') return decompressPayload(result.compressedData);
  }

  if (typeof msg.compressedResult === 'string') return decompressPayload(msg.compressedResult);
  if (typeof msg.compressedData === 'string') return decompressPayload(msg.compressedData);

  return ok(message);
}
