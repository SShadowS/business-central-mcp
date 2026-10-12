import { describe, it, expect } from 'vitest';
import { buildUploadUrl } from '../../src/services/upload-service.js';

describe('buildUploadUrl', () => {
  it('builds the DynamicFileUploadHandler path with form + url-encoded sessionid', () => {
    // handlerSessionId is the ServerSessionId, which contains spaces and slashes
    // (e.g. company name "CRONUS Danmark A/S") that MUST be encoded.
    const url = buildUploadUrl('f42', 'DEFAULTCRONUS Danmark A/SSR123FIN');
    expect(url.startsWith('DynamicFileUploadHandler.axd?')).toBe(true);
    const qs = new URLSearchParams(url.split('?')[1]);
    expect(qs.get('form')).toBe('f42');
    expect(qs.get('sessionid')).toBe('DEFAULTCRONUS Danmark A/SSR123FIN');
    // raw string must not contain a literal space or slash in the session id
    expect(url).not.toContain('A/S');
    expect(url).not.toContain('Danmark A');
  });
});
