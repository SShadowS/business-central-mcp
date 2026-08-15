export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Local loopback sign-in page. Password never leaves this origin. */
export function renderLoginPage(usernamePrefill: string): string {
  const prefill = escapeHtml(usernamePrefill);
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
    #mfa, #done, #err, #totpBox { display: none; text-align: center; }
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
      <input id="user" name="username" type="email" autocomplete="username" required value="${prefill}">
      <label for="pass">Password</label>
      <input id="pass" name="password" type="password" autocomplete="current-password" required>
      <button type="submit" id="go">Sign in</button>
    </form>
    <div id="mfa">
      <h1>Approve in Authenticator</h1>
      <p class="hint" id="entropyHint">Pick this number in Microsoft Authenticator</p>
      <div id="entropy">—</div>
      <form id="totpBox">
        <p class="hint">Enter the code from Microsoft Authenticator</p>
        <input id="totp" name="code" type="text" inputmode="numeric" autocomplete="one-time-code">
        <button type="submit">Submit code</button>
      </form>
      <p class="hint" id="mfaMsg">Waiting…</p>
    </div>
    <div id="done">
      <h1>Signed in</h1>
      <p class="hint">You can close this window and go back to the agent.</p>
    </div>
    <p id="err"></p>
  </main>
  <script>
    const params = new URLSearchParams(location.search);
    const k = params.get('k') || '';
    const q = k ? ('?k=' + encodeURIComponent(k)) : '';
    const form = document.getElementById('form');
    const mfa = document.getElementById('mfa');
    const done = document.getElementById('done');
    const err = document.getElementById('err');
    const entropy = document.getElementById('entropy');
    const entropyHint = document.getElementById('entropyHint');
    const totpBox = document.getElementById('totpBox');
    const mfaMsg = document.getElementById('mfaMsg');
    const go = document.getElementById('go');

    function show(el) {
      form.style.display = el === form ? 'block' : 'none';
      mfa.style.display = el === mfa ? 'block' : 'none';
      done.style.display = el === done ? 'block' : 'none';
    }

    async function poll() {
      const r = await fetch('/status' + q, { cache: 'no-store' });
      const s = await r.json();
      if (s.phase === 'mfa') {
        show(mfa);
        if (s.entropy) {
          entropy.style.display = 'block';
          entropyHint.style.display = 'block';
          totpBox.style.display = 'none';
          entropy.textContent = s.entropy;
        } else {
          entropy.style.display = 'none';
          entropyHint.style.display = 'none';
          totpBox.style.display = 'block';
        }
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
      document.getElementById('pass').value = '';
      const r = await fetch('/login' + q, {
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

    totpBox.addEventListener('submit', async (e) => {
      e.preventDefault();
      const code = document.getElementById('totp').value.trim();
      document.getElementById('totp').value = '';
      await fetch('/mfa-code' + q, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
    });
  </script>
</body>
</html>`;
}
