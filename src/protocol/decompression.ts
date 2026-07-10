import { unzipSync } from 'node:zlib';
import { ok, err, type Result } from '../core/result.js';
import { ProtocolError } from '../core/errors.js';

// Generous cap on decompressed payload size to guard against zip bombs.
const MAX_DECOMPRESSED_BYTES = 64 * 1024 * 1024;

export function decompressPayload(base64Data: string): Result<unknown, ProtocolError> {
  try {
    const buffer = Buffer.from(base64Data, 'base64');
    // unzipSync auto-detects gzip AND zlib/deflate wrapping (gunzipSync only
    // accepts gzip, failing on zlib-wrapped payloads).
    const decompressed = unzipSync(buffer, { maxOutputLength: MAX_DECOMPRESSED_BYTES });
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

  // Uncompressed JSON-RPC response: unwrap the result array so callers see the
  // same handler-array shape they get from compressed responses. Continia
  // DemoPortal's reverse proxy strips BC's gzip+base64 wrapping.
  if (Array.isArray(msg.result)) return ok(msg.result);

  return ok(message);
}
