import type { DeploymentReady, FixedEndPointAuth } from './ests-types.js';

export function parseBalancedObject(src: string, from: number): Record<string, unknown> | undefined {
  const start = src.indexOf('{', from);
  if (start < 0) return undefined;
  let depth = 0;
  for (let j = start; j < src.length; j++) {
    const ch = src[j];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(src.slice(start, j + 1)) as Record<string, unknown>;
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

export function parseConfig(html: string): Record<string, unknown> | undefined {
  const i = html.indexOf('$Config=');
  if (i < 0) return undefined;
  return parseBalancedObject(html, i);
}

export function parseFixedEndPoint(html: string): Record<string, unknown> | undefined {
  const i = html.indexOf('FixedEndPoint.start(');
  if (i < 0) return undefined;
  return parseBalancedObject(html, i);
}

export function decodeHtml(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

export function extractInputs(html: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const tags = html.match(/<input\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    const name = tag.match(/\bname\s*=\s*["']([^"']*)["']/i)?.[1];
    const value = tag.match(/\bvalue\s*=\s*["']([^"']*)["']/i)?.[1] ?? '';
    if (name) fields[decodeHtml(name)] = decodeHtml(value);
  }
  return fields;
}

export function extractForm(html: string): { action: string; fields: Record<string, string> } | undefined {
  const actionRaw = html.match(/<form\b[^>]*\baction\s*=\s*["']([^"']+)["']/i)?.[1];
  if (!actionRaw) return undefined;
  return { action: decodeHtml(actionRaw), fields: extractInputs(html) };
}

export function isRemoteSignIn(form: { action: string; fields: Record<string, string> }): boolean {
  return form.action.includes('remote-sign-in') || 'code' in form.fields;
}

export function extractFceToken(html: string): string {
  return html.match(/id=["']RequestVerificationToken["'][^>]*value=["']([^"']+)/i)?.[1]
    ?? html.match(/value=["']([^"']+)["'][^>]*id=["']RequestVerificationToken["']/i)?.[1]
    ?? '';
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

export function pageInfo(html: string): { pgid: string; hpgid: string; err: string; proofs: string[] } {
  const cfg = parseConfig(html);
  if (!cfg) return { pgid: '', hpgid: '', err: '', proofs: [] };
  const proofs: string[] = [];
  const arr = cfg['arrUserProofs'];
  if (Array.isArray(arr)) {
    for (const p of arr) {
      if (p && typeof p === 'object' && 'authMethodId' in p) {
        proofs.push(String((p as { authMethodId: unknown }).authMethodId));
      }
    }
  }
  return {
    pgid: asString(cfg['pgid']),
    hpgid: asString(cfg['hpgid']),
    err: asString(cfg['sErrTxt']),
    proofs,
  };
}

export function extractFixedEndPointAuth(fp: Record<string, unknown>): FixedEndPointAuth {
  const auth = (fp['authentication'] && typeof fp['authentication'] === 'object')
    ? fp['authentication'] as Record<string, unknown>
    : {};
  return {
    accessToken: asString(auth['accessToken']),
    authorizationCode: asString(auth['authorizationCode']),
    homeAccountId: asString(auth['homeAccountId']),
    sharedAuthCookieName: asString(auth['sharedAuthCookieName']),
  };
}

export function parseDeploymentJson(text: string): DeploymentReady | undefined {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const status = asString(json['status']);
  if (status.toLowerCase() !== 'ready') return undefined;

  let clusterAddress = '';
  const data = json['data'];
  if (typeof data === 'string') clusterAddress = data;
  else if (data && typeof data === 'object' && 'clusterAddress' in data) {
    clusterAddress = asString((data as { clusterAddress: unknown }).clusterAddress);
  }
  if (!clusterAddress && typeof json['clusterAddress'] === 'string') {
    clusterAddress = json['clusterAddress'];
  }
  if (!clusterAddress) return undefined;

  let runtimeId = asString(json['runtimeId']);
  let tid = '';
  try {
    const url = new URL(clusterAddress);
    if (!runtimeId) runtimeId = url.searchParams.get('tenant') ?? '';
    tid = url.searchParams.get('tid') ?? '';
  } catch {
    return undefined;
  }
  if (!runtimeId) return undefined;
  return { status, clusterAddress, runtimeId, tid };
}
