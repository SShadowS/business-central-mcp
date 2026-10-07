// Smoke test: pack the package, install it with ONLY runtime `dependencies`
// (--omit=dev), and boot the bin with stdin closed. A misclassified runtime
// dep (e.g. dotenv in devDependencies) crashes at ESM module resolution with
// ERR_MODULE_NOT_FOUND *before* main() runs; a clean install exits 0 because
// the readline 'close' handler shuts the server down without touching BC.
//
// This is the only check that exercises the production (npx / -g / Docker
// --omit=dev) world. CI and `npm ci` install devDeps too, so they can never
// see this class of bug. Run: node scripts/smoke-prod-install.mjs
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = process.cwd();
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const work = mkdtempSync(join(tmpdir(), 'bcmcp-smoke-'));
const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', ...opts });

try {
  console.log(`[smoke] packing into ${work}`);
  run(npm, ['pack', '--pack-destination', work], { cwd: root });
  const tarball = readdirSync(work).find((f) => f.endsWith('.tgz'));
  if (!tarball) throw new Error('npm pack produced no tarball');

  console.log('[smoke] installing tarball with --omit=dev');
  run(npm, ['init', '-y'], { cwd: work, stdio: 'ignore' });
  run(npm, ['install', '--omit=dev', '--no-audit', '--no-fund', join(work, tarball)], { cwd: work });

  console.log('[smoke] booting bin with stdin closed');
  const bin = join(work, 'node_modules', '.bin', process.platform === 'win32' ? 'business-central-mcp.cmd' : 'business-central-mcp');
  const res = spawnSync(bin, [], {
    cwd: work,
    input: '',               // closes stdin -> readline 'close' -> exit(0)
    encoding: 'utf8',
    shell: process.platform === 'win32',
    timeout: 20_000,
  });

  // A missing-env FATAL is fine: reaching config validation proves every
  // static import already resolved. Only a module-resolution failure means a
  // runtime dep is misclassified as a devDependency.
  const out = (res.stdout || '') + (res.stderr || '');
  if (/ERR_MODULE_NOT_FOUND|Cannot find (package|module)/.test(out)) {
    console.error('[smoke] FAIL: a runtime import is not in "dependencies":\n' + out);
    process.exit(1);
  }
  if (res.signal) {
    console.error(`[smoke] FAIL: bin killed by ${res.signal} (likely hung)\n` + out);
    process.exit(1);
  }
  console.log('[smoke] PASS: prod install resolves all runtime imports');
} finally {
  rmSync(work, { recursive: true, force: true });
}
