/** Extract a download filename from a Content-Disposition header, else the URL's fname param. */
export function fileNameFromResponse(disposition: string, relativeUrl: string): string | undefined {
  return extractFromDisposition(disposition) ?? extractFromUrl(relativeUrl);
}

function extractFromDisposition(disposition: string): string | undefined {
  // RFC 5987 form (filename*=UTF-8''...) is percent-encoded and takes precedence.
  const extMatch = disposition.match(/filename\*=UTF-8''([^";\r\n]+)/i);
  if (extMatch) {
    const raw = extMatch[1]!.trim();
    try { return decodeURIComponent(raw); } catch { return raw; }
  }
  // Plain filename="..." is used verbatim — decoding a literal % would throw.
  const plainMatch = disposition.match(/filename=["']?([^"';\r\n]+)/i);
  return plainMatch ? plainMatch[1]!.trim() : undefined;
}

function extractFromUrl(relativeUrl: string): string | undefined {
  try {
    // URLSearchParams.get already percent-decodes; do NOT decode again.
    const params = new URLSearchParams(relativeUrl.includes('?') ? relativeUrl.split('?')[1] : '');
    return params.get('fname') ?? undefined;
  } catch {
    return undefined;
  }
}
