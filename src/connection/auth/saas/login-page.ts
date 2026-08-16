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
    #busy, #mfa, #done, #err, #totpBox { display: none; text-align: center; }
    .spinner {
      width: 28px; height: 28px; margin: 18px auto 10px;
      border: 3px solid #c7e0f4; border-top-color: #0078d4;
      border-radius: 50%; animation: spin .9s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
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
    <div id="busy">
      <h1>Signing in…</h1>
      <div class="spinner"></div>
      <p class="hint" id="busyMsg">Contacting Microsoft sign-in…</p>
    </div>
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
    const busy = document.getElementById('busy');
    const busyMsg = document.getElementById('busyMsg');
    const mfa = document.getElementById('mfa');
    const done = document.getElementById('done');
    const err = document.getElementById('err');
    const entropy = document.getElementById('entropy');
    const entropyHint = document.getElementById('entropyHint');
    const totpBox = document.getElementById('totpBox');
    const mfaMsg = document.getElementById('mfaMsg');
    const go = document.getElementById('go');

    let lastPhase = '';
    let polling = false;
    let pollTimer;

    function show(el) {
      for (const p of [form, busy, mfa, done]) {
        p.style.display = p === el ? 'block' : 'none';
      }
    }

    function showFormError(message) {
      show(form);
      go.disabled = false;
      err.style.display = 'block';
      err.textContent = message;
    }

    // The server shuts down shortly after it has served phase 'done' (and on
    // sign-in timeout). A dead server after 'finishing'/'done' therefore IS
    // success; anything earlier means the sign-in window expired.
    function serverGone() {
      polling = false;
      if (lastPhase === 'finishing' || lastPhase === 'done') show(done);
      else showFormError('The sign-in window expired. Go back to the agent and try again.');
    }

    async function poll() {
      clearTimeout(pollTimer);
      if (!polling) return;
      let s;
      try {
        const r = await fetch('/status' + q, { cache: 'no-store' });
        s = await r.json();
      } catch {
        serverGone();
        return;
      }
      lastPhase = s.phase;
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
        polling = false;
        show(done);
        return;
      } else if (s.phase === 'error') {
        polling = false;
        showFormError(s.message || 'Sign-in failed');
        return;
      } else {
        // 'signing-in' / 'finishing': keep the form hidden and narrate
        // progress so an emptied password field never looks like a no-op.
        show(busy);
        if (s.message) busyMsg.textContent = s.message;
      }
      pollTimer = setTimeout(poll, 400);
    }

    // Background tabs get their timers throttled (the user is on their phone
    // approving the push) — poll immediately when the tab becomes visible.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && polling) poll();
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.style.display = 'none';
      go.disabled = true;
      const body = {
        username: document.getElementById('user').value.trim(),
        password: document.getElementById('pass').value,
      };
      document.getElementById('pass').value = '';
      busyMsg.textContent = 'Contacting Microsoft sign-in…';
      show(busy);
      let r;
      try {
        r = await fetch('/login' + q, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch {
        showFormError('Could not reach the sign-in window. Go back to the agent and try again.');
        return;
      }
      if (!r.ok) {
        const s = await r.json().catch(() => ({}));
        showFormError(s.message || 'Could not start sign-in');
        return;
      }
      lastPhase = '';
      polling = true;
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
