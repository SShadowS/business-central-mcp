import { describe, it, expect } from 'vitest';
import { parseDeploymentJson } from '../../src/connection/auth/saas/html-extract.js';

const HOST = 'msft1eu2as5743-3mujv5i.appservices.us.businesscentral.dynamics.com';
const RUNTIME = 'msft1a6720t30818544';
const TID = 'bb258e74-0d74-4054-b2d6-41f6c19bcd6e';

describe('parseDeploymentJson', () => {
  it('parses data as a URL string with runtimeId on the object', () => {
    const parsed = parseDeploymentJson(JSON.stringify({
      status: 'Ready',
      runtimeId: RUNTIME,
      data: `https://${HOST}/?tenant=${RUNTIME}&tid=${TID}`,
    }));
    expect(parsed).toEqual({
      status: 'Ready',
      clusterAddress: `https://${HOST}/?tenant=${RUNTIME}&tid=${TID}`,
      runtimeId: RUNTIME,
      tid: TID,
    });
  });

  it('parses data.clusterAddress object shape', () => {
    const parsed = parseDeploymentJson(JSON.stringify({
      status: 'Ready',
      data: { clusterAddress: `https://${HOST}/?tenant=${RUNTIME}&tid=${TID}` },
    }));
    expect(parsed?.clusterAddress).toContain(HOST);
    expect(parsed?.runtimeId).toBe(RUNTIME);
    expect(parsed?.tid).toBe(TID);
  });

  it('takes runtimeId from ?tenant= when the field is missing', () => {
    const parsed = parseDeploymentJson(JSON.stringify({
      status: 'Ready',
      data: `https://${HOST}/?tenant=${RUNTIME}&tid=${TID}`,
    }));
    expect(parsed?.runtimeId).toBe(RUNTIME);
  });

  it('returns undefined when status is not Ready', () => {
    expect(parseDeploymentJson(JSON.stringify({
      status: 'NotReady',
      data: `https://${HOST}/?tenant=${RUNTIME}`,
    }))).toBeUndefined();
  });

  it('returns undefined for invalid JSON or missing cluster URL', () => {
    expect(parseDeploymentJson('not-json')).toBeUndefined();
    expect(parseDeploymentJson(JSON.stringify({ status: 'Ready' }))).toBeUndefined();
  });

  it('rejects a cluster address whose host is not under dynamics.com', () => {
    expect(parseDeploymentJson(JSON.stringify({
      status: 'Ready',
      runtimeId: RUNTIME,
      data: `https://evil.example.com/?tenant=${RUNTIME}&tid=${TID}`,
    }))).toBeUndefined();
  });

  it('rejects a look-alike suffix host (dynamics.com.evil.com)', () => {
    expect(parseDeploymentJson(JSON.stringify({
      status: 'Ready',
      runtimeId: RUNTIME,
      data: `https://dynamics.com.evil.com/?tenant=${RUNTIME}&tid=${TID}`,
    }))).toBeUndefined();
  });

  it('rejects a non-https cluster address', () => {
    expect(parseDeploymentJson(JSON.stringify({
      status: 'Ready',
      runtimeId: RUNTIME,
      data: `http://${HOST}/?tenant=${RUNTIME}&tid=${TID}`,
    }))).toBeUndefined();
  });

  it('rejects a userinfo-smuggled host (dynamics.com@evil.com)', () => {
    // The real host is evil.com; only the userinfo looks like dynamics.com.
    expect(parseDeploymentJson(JSON.stringify({
      status: 'Ready',
      runtimeId: RUNTIME,
      data: `https://dynamics.com@evil.com/?tenant=${RUNTIME}&tid=${TID}`,
    }))).toBeUndefined();
  });
});
