import { spawn, type ChildProcess } from 'node:child_process';

export interface BrowserOpener {
  open(url: string): boolean;
}

export type SpawnFn = (
  command: string,
  args: string[],
  options: { detached: boolean; stdio: 'ignore' },
) => Pick<ChildProcess, 'unref'>;

/**
 * Open a URL in the platform browser. The URL is a dedicated argv element
 * (never interpolated into a shell string) so `?k=` is not swallowed.
 */
export class PlatformBrowserOpener implements BrowserOpener {
  constructor(
    private readonly spawnFn: SpawnFn = spawn,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  open(url: string): boolean {
    if (this.platform !== 'win32' && this.platform !== 'darwin') {
      if (!this.env.DISPLAY && !this.env.WAYLAND_DISPLAY) return false;
    }
    const { cmd, args } = commandFor(this.platform, url);
    try {
      const child = this.spawnFn(cmd, args, { detached: true, stdio: 'ignore' });
      child.unref();
      return true;
    } catch {
      return false;
    }
  }
}

export function commandFor(platform: NodeJS.Platform, url: string): { cmd: string; args: string[] } {
  if (platform === 'darwin') return { cmd: 'open', args: [url] };
  if (platform === 'win32') return { cmd: 'cmd', args: ['/c', 'start', '', url] };
  return { cmd: 'xdg-open', args: [url] };
}
