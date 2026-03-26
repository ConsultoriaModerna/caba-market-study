// nav.js — Shared navigation bar for all dashboard pages
(function() {
  const pages = [
    { href: '/', label: 'Dashboard', icon: '📊' },
    { href: '/mapa', label: 'Mapa', icon: '🗺️' },
    { href: '/wave', label: 'Wave', icon: '🌊' },
    { href: '/analytics', label: 'Analytics', icon: '📈' }
  ];

  const path = window.location.pathname.replace(/\.html$/, '').replace(/\/$/, '') || '/';

  const nav = document.createElement('nav');
  nav.id = 'global-nav';
  nav.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:center;gap:0.3rem;padding:0.5rem 1rem;background:#0d1117;border-bottom:1px solid #1e293b;position:sticky;top:0;z-index:9999;font-family:'Inter',system-ui,sans-serif;">
      <span style="font-size:1rem;margin-right:0.5rem;">🏠</span>
      <style>.gnav-link{display:inline-flex;align-items:center;gap:0.3rem;padding:0.35rem 0.8rem;border-radius:6px;font-size:0.8rem;text-decoration:none;transition:all 0.2s;color:#64748b;}.gnav-link:hover{color:#94a3b8;}.gnav-link.active{background:rgba(0,212,255,0.12);color:#00d4ff;font-weight:600;}</style>
      ${pages.map(p => {
        const isActive = (p.href === '/' && (path === '/' || path === '')) ||
                         (p.href !== '/' && path.startsWith(p.href));
        return `<a href="${p.href}" class="gnav-link${isActive ? ' active' : ''}">${p.icon} ${p.label}</a>`;
      }).join('')}
    </div>
  `;

  // Insert at the very top of body
  if (document.body) {
    document.body.prepend(nav);
  } else {
    document.addEventListener('DOMContentLoaded', () => document.body.prepend(nav));
  }
})();
