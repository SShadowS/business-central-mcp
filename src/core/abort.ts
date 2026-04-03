/// <reference types="node" />
import { TimeoutError, AbortedError } from './errors.js';

export function composeWithTimeout(timeoutMs: number, externalSignal?: AbortSignal): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new TimeoutError(`Timed out after ${timeoutMs}ms`)), timeoutMs);
  const onExternalAbort = () => { controller.abort(new AbortedError('Externally aborted')); };
  if (externalSignal) {
    if (externalSignal.aborted) { clearTimeout(timer); controller.abort(new AbortedError('Externally aborted')); }
    else { externalSignal.addEventListener('abort', onExternalAbort, { once: true }); }
  }
  const cleanup = () => { clearTimeout(timer); externalSignal?.removeEventListener('abort', onExternalAbort); };
  return { signal: controller.signal, cleanup };
}

export function abortPromise(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) { reject(signal.reason instanceof Error ? signal.reason : new AbortedError('Aborted')); return; }
    signal.addEventListener('abort', () => { reject(signal.reason instanceof Error ? signal.reason : new AbortedError('Aborted')); }, { once: true });
  });
}
