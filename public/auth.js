// auth.js — Simple password gate for CABA Market Study dashboard
// Include this script at the top of any page that needs protection
(function() {
  const PASS_HASH = '81fde06999b0bcf4adc2864a9d3b2eb54d96b6c2d433ae298b0a2d8648121fad';
  const SESSION_KEY = 'caba_auth';
  const SESSION_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days

  async function sha256(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  function isAuthenticated() {
    try {
      const session = JSON.parse(localStorage.getItem(SESSION_KEY));
      return session && session.hash === PASS_HASH && Date.now() - session.ts < SESSION_TTL;
    } catch { return false; }
  }

  function showGate() {
    document.body.style.visibility = 'hidden';
    const overlay = document.createElement('div');
    overlay.id = 'auth-gate';
    overlay.innerHTML = `
      <div style="position:fixed;inset:0;background:#0a0e1a;display:flex;align-items:center;justify-content:center;z-index:99999;font-family:'Inter',sans-serif;">
        <div style="text-align:center;">
          <div style="font-size:2rem;margin-bottom:1rem;">🏠</div>
          <div style="color:#94a3b8;font-size:0.85rem;margin-bottom:1.5rem;">CABA Market Study</div>
          <input id="auth-input" type="password" placeholder="Password"
            style="background:#111827;border:1px solid #334155;color:#f0f4f8;padding:0.7rem 1.2rem;border-radius:8px;font-size:1rem;text-align:center;outline:none;width:220px;font-family:'Inter',sans-serif;"
          >
          <div id="auth-error" style="color:#ef4444;font-size:0.8rem;margin-top:0.8rem;opacity:0;">&nbsp;</div>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const input = document.getElementById('auth-input');
    input.focus();
    input.addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter') return;
      const hash = await sha256(input.value);
      if (hash === PASS_HASH) {
        localStorage.setItem(SESSION_KEY, JSON.stringify({ hash: PASS_HASH, ts: Date.now() }));
        overlay.remove();
        document.body.style.visibility = 'visible';
      } else {
        document.getElementById('auth-error').style.opacity = 1;
        document.getElementById('auth-error').textContent = 'Incorrect';
        input.value = '';
        input.style.borderColor = '#ef4444';
        setTimeout(() => { input.style.borderColor = '#334155'; }, 1000);
      }
    });
  }

  if (!isAuthenticated()) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', showGate);
    } else {
      showGate();
    }
  }
})();
