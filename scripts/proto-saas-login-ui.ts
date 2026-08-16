/**
 * Prototype — local sign-in window (no URL for the user to copy).
 *
 * Binds 127.0.0.1, opens the system browser itself, collects username /
 * password / MFA on that page, runs ESTS, writes cookies to STATE_DIR.
 *
 *   npx tsx scripts/proto-saas-login-ui.ts
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { parseSaasUrl } from '../src/connection/saas-url.js';
import { estsPasswordLogin, type EstsUiStatus } from './proto-saas-ests-login.js';
import { requireBaseUrl } from './proto-env.js';


function log(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

type Status = EstsUiStatus & { busy?: boolean };

const status: Status = { phase: 'signing-in', message: 'Waiting for sign-in…', busy: false };

function json(res: ServerResponse, code: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

function htmlPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Business Central sign-in</title>
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body {
      margin: 0; min-height: 100vh;
      font: 15px/1.45 "Segoe UI", system-ui, sans-serif;
      background: #f3f2f1; color: #242424;
      display: flex; align-items: center; justify-content: center;
    }
    main {
      width: 420px; max-width: calc(100vw - 32px);
      background: #fff; padding: 32px 28px 28px;
      border-radius: 4px;
      box-shadow: 0 3.2px 7.2px rgba(0,0,0,.13), 0 0.6px 1.8px rgba(0,0,0,.1);
    }
    h1 { font-size: 20px; font-weight: 600; margin: 0 0 6px; }
    .sub { color: #605e5c; margin: 0 0 22px; }
    label { display: block; font-size: 13px; margin: 0 0 6px; }
    input[type=text], input[type=password], input[type=email] {
      width: 100%; padding: 8px 10px; margin-bottom: 14px;
      border: 1px solid #8a8886; border-radius: 2px; font: inherit;
    }
    input:focus { outline: 2px solid #0078d4; border-color: #0078d4; }
    button {
      width: 100%; padding: 10px 14px; border: 0; border-radius: 2px;
      background: #0078d4; color: #fff; font: 600 15px inherit; cursor: pointer;
    }
    button:disabled { opacity: .55; cursor: default; }
    #mfa, #done, #err { display: none; text-align: center; }
    #entropy {
      font-size: 56px; font-weight: 600; letter-spacing: 4px;
      margin: 16px 0 8px; color: #0078d4;
    }
    .hint { color: #605e5c; }
    #err { color: #a4262c; }
  </style>
</head>
<body>
  <main>
    <form id="form">
      <h1>Sign in to Business Central</h1>
      <p class="sub">This window was opened by the MCP. Password stays on this machine.</p>
      <label for="user">Email</label>
      <input id="user" name="username" type="email" autocomplete="username" required>
      <label for="pass">Password</label>
      <input id="pass" name="password" type="password" autocomplete="current-password" required>
      <button type="submit" id="go">Sign in</button>
    </form>
    <div id="mfa">
      <h1>Approve in Authenticator</h1>
      <p class="hint">Pick this number in Microsoft Authenticator</p>
      <div id="entropy">—</div>
      <p class="hint" id="mfaMsg">Waiting…</p>
    </div>
    <div id="done">
      <h1>Signed in</h1>
      <p class="hint">You can close this window and go back to the agent.</p>
    </div>
    <p id="err"></p>
  </main>
  <script>
    const form = document.getElementById('form');
    const mfa = document.getElementById('mfa');
    const done = document.getElementById('done');
    const err = document.getElementById('err');
    const entropy = document.getElementById('entropy');
    const mfaMsg = document.getElementById('mfaMsg');
    const go = document.getElementById('go');

    function show(el) {
      form.style.display = el === form ? 'block' : 'none';
      mfa.style.display = el === mfa ? 'block' : 'none';
      done.style.display = el === done ? 'block' : 'none';
    }

    async function poll() {
      const r = await fetch('/status', { cache: 'no-store' });
      const s = await r.json();
      if (s.phase === 'mfa') {
        show(mfa);
        if (s.entropy) entropy.textContent = s.entropy;
        if (s.message) mfaMsg.textContent = s.message;
      } else if (s.phase === 'done') {
        show(done);
        return;
      } else if (s.phase === 'error') {
        show(form);
        go.disabled = false;
        err.style.display = 'block';
        err.textContent = s.message || 'Sign-in failed';
        return;
      }
      setTimeout(poll, 400);
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.style.display = 'none';
      go.disabled = true;
      const body = {
        username: document.getElementById('user').value.trim(),
        password: document.getElementById('pass').value,
      };
      const r = await fetch('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const s = await r.json().catch(() => ({}));
        go.disabled = false;
        err.style.display = 'block';
        err.textContent = s.message || 'Could not start sign-in';
        return;
      }
      poll();
    });
  </script>
</body>
</html>`;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function openWindow(url: string): boolean {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const raw = requireBaseUrl();
  const saas = parseSaasUrl(raw);
  if (!saas) throw new Error('not a SaaS URL');

  log('Prototype: auto-open local sign-in window (no URL to copy)');

  const server = createServer(async (req, res) => {
    const url = req.url ?? '/';
    if (req.method === 'GET' && (url === '/' || url.startsWith('/?'))) {
      const page = htmlPage();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(page);
      return;
    }
    if (req.method === 'GET' && url.startsWith('/status')) {
      json(res, 200, status);
      return;
    }
    if (req.method === 'POST' && url === '/login') {
      if (status.busy) {
        json(res, 409, { message: 'Sign-in already in progress' });
        return;
      }
      let creds: { username?: string; password?: string };
      try {
        creds = JSON.parse(await readBody(req)) as { username?: string; password?: string };
      } catch {
        json(res, 400, { message: 'Bad JSON' });
        return;
      }
      const username = (creds.username ?? '').trim();
      const password = creds.password ?? '';
      if (!username || !password) {
        json(res, 400, { message: 'Email and password required' });
        return;
      }
      status.busy = true;
      status.phase = 'signing-in';
      status.message = 'Signing in…';
      json(res, 202, { ok: true });
      void estsPasswordLogin(username, password, saas.portalUrl, (s) => {
        status.phase = s.phase;
        status.entropy = s.entropy;
        status.message = s.message;
      }).then(() => {
        status.busy = false;
        status.phase = 'done';
        status.message = 'Signed in. You can close this window.';
        log('PASS: local window completed ESTS sign-in (cookies saved)');
        setTimeout(() => {
          server.close();
          process.exit(0);
        }, 1500);
      }).catch((e) => {
        status.busy = false;
        status.phase = 'error';
        status.message = e instanceof Error ? e.message : String(e);
        log(`FAIL: ${status.message}`);
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve());
    server.on('error', reject);
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no listen address');
  const href = `http://127.0.0.1:${addr.port}/`;
  log('Opening sign-in window…');
  if (!openWindow(href)) {
    log('FAIL: could not open a window (no display / xdg-open failed)');
    server.close();
    process.exit(1);
  }

  const deadline = Date.now() + 5 * 60_000;
  const timer = setInterval(() => {
    if (Date.now() > deadline && status.phase !== 'done') {
      log('FAIL: sign-in window timed out (5 min)');
      server.close();
      process.exit(1);
    }
  }, 5000);
  timer.unref();
}

main().catch((e) => {
  process.stderr.write(`FAIL: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
