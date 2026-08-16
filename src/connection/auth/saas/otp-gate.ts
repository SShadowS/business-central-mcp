const DEFAULT_OTP_TIMEOUT_MS = 90_000;

/** One-shot gate: ESTS awaits wait(); POST /mfa-code calls provide(). */
export class OtpGate {
  private resolveWait: ((code: string) => void) | undefined;
  private rejectWait: ((err: Error) => void) | undefined;
  private pending: Promise<string> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  wait(timeoutMs = DEFAULT_OTP_TIMEOUT_MS): Promise<string> {
    if (this.pending) return this.pending;
    this.pending = new Promise<string>((resolve, reject) => {
      this.resolveWait = resolve;
      this.rejectWait = reject;
      this.timer = setTimeout(() => {
        this.rejectWait?.(new Error('OTP timed out'));
        this.reset();
      }, timeoutMs);
    });
    return this.pending;
  }

  provide(code: string): boolean {
    if (!this.resolveWait) return false;
    if (this.timer) clearTimeout(this.timer);
    const resolve = this.resolveWait;
    this.resolveWait = undefined;
    this.rejectWait = undefined;
    this.pending = undefined;
    this.timer = undefined;
    resolve(code);
    return true;
  }

  reset(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const reject = this.rejectWait;
    this.resolveWait = undefined;
    this.rejectWait = undefined;
    this.pending = undefined;
    reject?.(new Error('OTP cancelled'));
  }
}
