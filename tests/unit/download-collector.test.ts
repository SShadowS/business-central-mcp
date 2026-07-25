import { describe, it, expect } from 'vitest';
import { collectDownloads } from '../../src/protocol/download-collector.js';
import type { BCEvent } from '../../src/protocol/types.js';

const BASE = 'http://cronus28/BC';
const dl = (relativeUrl: string, style = '1'): BCEvent => ({ type: 'FileDownloadReady', formId: '', relativeUrl, style } as BCEvent);

describe('collectDownloads', () => {
  it('returns empty for events with no FileDownloadReady', () => {
    const r = collectDownloads([{ type: 'InvokeCompleted' } as BCEvent], { baseUrl: BASE });
    expect(r.refs).toEqual([]);
    expect(r.external).toEqual([]);
  });

  it('classifies a relative DynamicFileHandler.axd URL as a fetchable ref', () => {
    const r = collectDownloads([dl('DynamicFileHandler.axd?form=41D&fname=a.pdf')], { baseUrl: BASE });
    expect(r.refs).toHaveLength(1);
    expect(r.refs[0]).toMatchObject({ relativeUrl: 'DynamicFileHandler.axd?form=41D&fname=a.pdf', style: 'download', suggestedFileName: 'a.pdf' });
    expect(r.external).toEqual([]);
  });

  it('maps style ordinals 0..5 to names, and out-of-range to unknown:<n>', () => {
    const styles = ['0', '1', '2', '3', '4', '5', '9'].map(s => collectDownloads([dl('DynamicFileHandler.axd', s)], { baseUrl: BASE }));
    // ordinals 0..4 are same-origin file styles -> refs; 5 (mailto) has a file path here so still a ref by origin, name still 'mailto'
    expect(styles[0].refs[0].style).toBe('view');
    expect(styles[1].refs[0].style).toBe('download');
    expect(styles[2].refs[0].style).toBe('print');
    expect(styles[3].refs[0].style).toBe('preview');
    expect(styles[4].refs[0].style).toBe('previewWithoutDownload');
    expect(styles[5].refs[0].style).toBe('mailto');
    expect(styles[6].refs[0].style).toBe('unknown:9');
  });

  it('routes an off-origin absolute URL to external, never a ref', () => {
    const r = collectDownloads([dl('http://evil.example.com/x.pdf')], { baseUrl: BASE });
    expect(r.refs).toEqual([]);
    expect(r.external).toEqual([{ uri: 'http://evil.example.com/x.pdf', style: 'download' }]);
  });

  it('routes a mailto: URI to external', () => {
    const r = collectDownloads([dl('mailto:a@b.com', '5')], { baseUrl: BASE });
    expect(r.refs).toEqual([]);
    expect(r.external[0]).toMatchObject({ uri: 'mailto:a@b.com' });
  });

  it('routes a same-origin URL on a NON-allowlisted path to external', () => {
    const r = collectDownloads([dl('http://cronus28/BC/SignIn?x=1')], { baseUrl: BASE });
    expect(r.refs).toEqual([]);
    expect(r.external).toHaveLength(1);
  });

  it('preserves order across multiple FileDownloadReady events', () => {
    const r = collectDownloads([dl('DynamicFileHandler.axd?fname=1.pdf'), dl('DynamicFileHandler.axd?fname=2.pdf')], { baseUrl: BASE });
    expect(r.refs.map(x => x.suggestedFileName)).toEqual(['1.pdf', '2.pdf']);
  });
});
