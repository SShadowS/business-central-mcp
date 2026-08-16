import { describe, it, expect, vi } from 'vitest';
import { PlatformBrowserOpener, commandFor } from '../../src/connection/auth/saas/browser-opener.js';

describe('commandFor', () => {
  it('uses open on darwin with the URL as its own argument', () => {
    expect(commandFor('darwin', 'http://127.0.0.1:1/?k=x')).toEqual({
      cmd: 'open',
      args: ['http://127.0.0.1:1/?k=x'],
    });
  });

  it('uses cmd /c start "" url on win32', () => {
    expect(commandFor('win32', 'http://127.0.0.1:1/?k=x')).toEqual({
      cmd: 'cmd',
      args: ['/c', 'start', '', 'http://127.0.0.1:1/?k=x'],
    });
  });

  it('uses xdg-open elsewhere', () => {
    expect(commandFor('linux', 'http://127.0.0.1:1/?k=x')).toEqual({
      cmd: 'xdg-open',
      args: ['http://127.0.0.1:1/?k=x'],
    });
  });
});

describe('PlatformBrowserOpener', () => {
  it('on win32 spawns cmd with /c start "" url and unrefs', () => {
    const unref = vi.fn();
    const spawnFn = vi.fn(() => ({ unref }));
    const opener = new PlatformBrowserOpener(spawnFn, {}, 'win32');
    expect(opener.open('http://127.0.0.1:9/?k=abc')).toBe(true);
    expect(spawnFn).toHaveBeenCalledWith(
      'cmd',
      ['/c', 'start', '', 'http://127.0.0.1:9/?k=abc'],
      { detached: true, stdio: 'ignore' },
    );
    expect(unref).toHaveBeenCalledOnce();
  });

  it('returns false on linux without DISPLAY or WAYLAND_DISPLAY and does not spawn', () => {
    const spawnFn = vi.fn();
    const opener = new PlatformBrowserOpener(spawnFn, {}, 'linux');
    expect(opener.open('http://127.0.0.1:1/?k=x')).toBe(false);
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('spawns xdg-open on linux when DISPLAY is set', () => {
    const spawnFn = vi.fn(() => ({ unref: vi.fn() }));
    const opener = new PlatformBrowserOpener(spawnFn, { DISPLAY: ':0' }, 'linux');
    expect(opener.open('http://127.0.0.1:1/?k=x')).toBe(true);
    expect(spawnFn).toHaveBeenCalledWith('xdg-open', ['http://127.0.0.1:1/?k=x'], {
      detached: true,
      stdio: 'ignore',
    });
  });
});
