const SENSITIVE_KEYS = new Set([
  'password', 'passwd', 'accesstoken', 'authorizationcode', 'authorization',
  'cookie', 'cookies', 'flowtoken', 'canary', 'ppft', 'sft', 'code',
  'refreshtoken', 'sessionkey', 'csrftoken',
]);

const JWT = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?/g;
const COOKIE_HDR = /Cookie:\s*[^\r\n]+/gi;
const AUTH_HDR = /authorization:\s*\S+/gi;
const PASSWD_FIELD = /passwd=[^&\s]+/gi;
const SFT_FIELD = /sFT=[^&\s"']+/gi;
const PPFT_FIELD = /PPFT=[^&\s"']+/gi;
const FLOW_FIELD = /flowToken=[^&\s"']+/gi;

export function redactString(value: string): string {
  return value
    .replace(JWT, '[redacted-jwt]')
    .replace(COOKIE_HDR, 'Cookie: [redacted]')
    .replace(AUTH_HDR, 'authorization: [redacted]')
    .replace(PASSWD_FIELD, 'passwd=[redacted]')
    .replace(SFT_FIELD, 'sFT=[redacted]')
    .replace(PPFT_FIELD, 'PPFT=[redacted]')
    .replace(FLOW_FIELD, 'flowToken=[redacted]');
}

function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEYS.has(k.toLowerCase()) ? '[redacted]' : redactValue(v);
    }
    return out;
  }
  return value;
}

export function redactLog(
  msg: string,
  context?: Record<string, unknown>,
): { msg: string; context?: Record<string, unknown> } {
  const redactedMsg = redactString(msg);
  if (!context) return { msg: redactedMsg };
  return { msg: redactedMsg, context: redactValue(context) as Record<string, unknown> };
}
