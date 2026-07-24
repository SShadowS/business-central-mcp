import type { BCEvent } from './types.js';
import { fileNameFromResponse } from '../connection/http-filename.js';

export interface DownloadRef { relativeUrl: string; style: string; suggestedFileName?: string; }
export interface ExternalUri { uri: string; style: string; }

// Index = UriToShowStyle ordinal (decompiled UriToShowStyle.cs).
export const STYLE_NAMES = ['view', 'download', 'print', 'preview', 'previewWithoutDownload', 'mailto'] as const;

// Paths under the BC origin that legitimately serve files.
const ALLOWED_PATH_RE = /(^|\/)(DynamicFileHandler\.axd|client\/uploadDownload\/download)(\/|$|\?)/i;

function styleName(raw: string): string {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n < STYLE_NAMES.length ? STYLE_NAMES[n]! : `unknown:${raw}`;
}

/** Same scheme+host+port as baseUrl AND an allowlisted file path. */
function isFetchable(relativeUrl: string, baseUrl: string): boolean {
  let resolved: URL;
  try {
    resolved = new URL(relativeUrl, baseUrl.endsWith('/') ? baseUrl : baseUrl + '/');
  } catch {
    return false; // e.g. mailto: with no host, or a malformed URI
  }
  const base = new URL(baseUrl);
  if (resolved.origin !== base.origin) return false;
  return ALLOWED_PATH_RE.test(resolved.pathname);
}

export function collectDownloads(
  events: readonly BCEvent[],
  origin: { baseUrl: string },
): { refs: DownloadRef[]; external: ExternalUri[] } {
  const refs: DownloadRef[] = [];
  const external: ExternalUri[] = [];
  for (const e of events) {
    if (e.type !== 'FileDownloadReady') continue;
    const style = styleName(e.style);
    if (isFetchable(e.relativeUrl, origin.baseUrl)) {
      refs.push({ relativeUrl: e.relativeUrl, style, suggestedFileName: fileNameFromResponse('', e.relativeUrl) });
    } else {
      external.push({ uri: e.relativeUrl, style });
    }
  }
  return { refs, external };
}
