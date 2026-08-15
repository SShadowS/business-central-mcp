/**
 * Ensure a Playwright Chromium build exists under STATE_DIR.
 * The npm `playwright` package is JS only; the browser is downloaded once
 * into STATE_DIR/ms-playwright (not a user-run `playwright install`).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');

export function playwrightBrowsersPath(stateDir: string): string {
  return join(stateDir, 'ms-playwright');
}

function hasChromiumBuild(browsersPath: string): boolean {
  if (!existsSync(browsersPath)) return false;
  try {
    return readdirSync(browsersPath).some((n) => n.startsWith('chromium-'));
  } catch {
    return false;
  }
}

function playwrightCli(): string {
  try {
    return require.resolve('playwright/cli');
  } catch {
    return require.resolve('playwright-core/cli');
  }
}

export function ensurePlaywrightPackage(): void {
  try {
    require.resolve('playwright');
  } catch {
    execFileSync('npm', ['install', 'playwright', '--no-save', '--no-fund', '--no-audit'], {
      cwd: repoRoot,
      stdio: 'inherit',
    });
  }
}

export function ensureChromium(stateDir: string): string {
  ensurePlaywrightPackage();
  const browsersPath = playwrightBrowsersPath(stateDir);
  mkdirSync(browsersPath, { recursive: true });
  if (!hasChromiumBuild(browsersPath)) {
    execFileSync(process.execPath, [playwrightCli(), 'install', 'chromium'], {
      cwd: repoRoot,
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsersPath },
      stdio: 'inherit',
    });
  }
  return browsersPath;
}
