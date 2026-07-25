import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import type { Logger } from '../core/logger.js';
import type { BCConfig } from '../core/config.js';
import type { BCEvent } from '../protocol/types.js';
import type { BCHttpClient } from '../connection/bc-http.js';
import { collectDownloads, type ExternalUri } from '../protocol/download-collector.js';

export interface Download {
  fileName: string;
  contentType: string;
  sizeBytes: number;
  style: string;
  /** base64 file bytes; present on every successful capture (also written to disk when BC_DOWNLOAD_DIR is set); omitted only on error entries. */
  bytes?: string;
  savedPath?: string;
  error?: { code: 'TOO_LARGE' | 'FETCH_FAILED'; message: string };
}
export interface CaptureResult { downloads: Download[]; externalUris: ExternalUri[]; }

const EXT_BY_TYPE: Record<string, string> = {
  'application/pdf': '.pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
};

/**
 * Reduce a (possibly server/AL-controlled) filename to a safe basename before it
 * touches the filesystem: strip directory separators (both slash styles), collapse
 * ".." traversal sequences, and drop control characters. Returns '' if nothing
 * usable survives (empty, or only dots), so the caller can fall back to a
 * synthetic name.
 */
function sanitizeFileName(name: string): string {
  const cleaned = name
    .replace(/[\\/]+/g, '_')
    .replace(/\.\.+/g, '_')
    .replace(/[\x00-\x1f]/g, '');
  return cleaned === '' || /^\.+$/.test(cleaned) ? '' : cleaned;
}

export class DownloadService {
  constructor(
    private readonly http: BCHttpClient,
    private readonly baseUrl: string,
    private readonly limits: BCConfig['downloadLimits'],
    private readonly logger: Logger,
  ) {}

  async capture(events: readonly BCEvent[], opts?: { timeoutMs?: number }): Promise<CaptureResult> {
    const { refs, external } = collectDownloads(events, { baseUrl: this.baseUrl });
    const downloads: Download[] = [];
    let totalBytes = 0;

    for (let i = 0; i < refs.length; i++) {
      const ref = refs[i]!;
      if (i >= this.limits.maxDownloads) {
        downloads.push({ fileName: ref.suggestedFileName ?? `download-${i}`, contentType: 'application/octet-stream', sizeBytes: 0, style: ref.style,
          error: { code: 'TOO_LARGE', message: `Dropped: exceeds the maximum of ${this.limits.maxDownloads} downloads per operation.` } });
        continue;
      }
      try {
        const payload = await this.http.get(ref.relativeUrl, { maxBytes: this.limits.maxBytes, timeoutMs: opts?.timeoutMs });
        const fileName = payload.fileName ?? ref.suggestedFileName ?? `download-${i}${EXT_BY_TYPE[payload.contentType] ?? '.bin'}`;
        totalBytes += payload.bytes.byteLength;
        if (totalBytes > this.limits.maxTotalBytes) {
          downloads.push({ fileName, contentType: payload.contentType, sizeBytes: payload.bytes.byteLength, style: ref.style,
            error: { code: 'TOO_LARGE', message: `Dropped: operation exceeded the aggregate cap of ${this.limits.maxTotalBytes} bytes.` } });
          continue;
        }
        downloads.push(this.finish({ fileName, contentType: payload.contentType, sizeBytes: payload.bytes.byteLength, style: ref.style }, payload.bytes, i));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const fileName = ref.suggestedFileName ?? `download-${i}`;
        if (msg === 'TOO_LARGE') {
          downloads.push({ fileName, contentType: 'application/octet-stream', sizeBytes: 0, style: ref.style,
            error: { code: 'TOO_LARGE', message: `Download exceeded the per-file cap of ${this.limits.maxBytes} bytes. The action committed server-side; retrieve the file via the UI or raise BC_MAX_DOWNLOAD_BYTES.` } });
        } else {
          downloads.push({ fileName, contentType: 'application/octet-stream', sizeBytes: 0, style: ref.style,
            error: { code: 'FETCH_FAILED', message: `The action committed server-side but the file could not be fetched: ${msg}` } });
        }
      }
    }
    return { downloads, externalUris: external };
  }

  /** Encode inline and/or write to disk per BC_DOWNLOAD_DIR. */
  private finish(base: Omit<Download, 'bytes' | 'savedPath' | 'error'>, bytes: Buffer, index: number): Download {
    // Compute final filename with extension once; use for both disk and reported fileName.
    const finalFileName = extname(base.fileName) ? base.fileName : `${base.fileName}${EXT_BY_TYPE[base.contentType] ?? '.bin'}`;
    // The filename may originate from a Content-Disposition header or URL query param set
    // by the BC/AL server -- sanitize to a safe basename before it ever touches the
    // filesystem or the reported result (disk name and reported name must stay equal).
    const safeFileName = sanitizeFileName(finalFileName) || `download-${index}.bin`;
    const d: Download = { ...base, fileName: safeFileName };
    if (this.limits.dir) {
      try {
        if (!existsSync(this.limits.dir)) mkdirSync(this.limits.dir, { recursive: true });
        d.savedPath = join(this.limits.dir, safeFileName);
        writeFileSync(d.savedPath, bytes);
      } catch (e) {
        this.logger.warn(`download disk write failed: ${e instanceof Error ? e.message : String(e)}`);
        d.savedPath = undefined;
      }
    }
    d.bytes = bytes.toString('base64');
    return d;
  }
}
