/* Demo sign-in buttons on the welcome page. They exist only when the server runs in demo mode
 * (python demo.py): /api/dev/roles answers 404 everywhere else, and then this script does nothing.
 */
(async () => {
  'use strict';
  const mount = document.getElementById('demo-login');
  if (!mount) return;
  // The demo exists only on a developer's own machine; on the real site do not even ask (it would be a 404).
  if (!['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) return;
  let roles;
  try {
    const response = await fetch('/api/dev/roles', {cache: 'no-store'});
    if (!response.ok) return;
    roles = (await response.json()).roles;
  } catch {
    return;
  }
  const title = document.createElement('p');
  title.className = 'demo-login-title';
  title.textContent = 'Local demo: sign in as';
  const list = document.createElement('div');
  list.className = 'demo-login-list';
  for (const {role, label} of roles) {
    const link = document.createElement('a');
    link.className = 'welcome-button demo-login-button';
    link.href = '/api/dev/login?role=' + encodeURIComponent(role);
    link.textContent = label;
    list.append(link);
  }
  mount.append(title, list);
  mount.hidden = false;
  const style = document.createElement('style');
  style.textContent = '#demo-login{position:fixed;right:16px;bottom:16px;z-index:20;display:grid;gap:8px;width:min(380px,calc(100vw - 32px));max-height:calc(100dvh - 32px);overflow:auto;padding:16px;border-radius:20px;background:#fff6dd;border:1px dashed #b9831a;box-shadow:0 12px 32px #6b4f2933}'
    + '#demo-login[hidden]{display:none}'
    + '.demo-login-title{margin:0;font-weight:800;font-size:13px;letter-spacing:.04em;text-transform:uppercase}'
    + '.demo-login-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}'
    + '.demo-login-button{min-height:48px;display:grid;place-items:center;text-align:center;text-decoration:none}';
  document.head.append(style);
})();
