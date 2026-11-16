(() => {
  'use strict';
  const root = document.documentElement;
  const storageKey = 'rfid-console-theme';
  let initialTheme = 'dark';
  try {
    if (localStorage.getItem(storageKey) === 'light') initialTheme = 'light';
  } catch { /* Theme switching remains available when storage is blocked. */ }
  root.dataset.theme = initialTheme;

  document.addEventListener('DOMContentLoaded', () => {
    const button = document.getElementById('theme-toggle');
    if (!button) return;
    const applyTheme = theme => {
      root.dataset.theme = theme;
      const label = `Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`;
      button.setAttribute('aria-label', label);
      button.setAttribute('title', label);
      button.setAttribute('aria-pressed', String(theme === 'light'));
      document.querySelector('meta[name="theme-color"]').content = theme === 'light' ? '#f5f6f2' : '#0b0c0b';
      try { localStorage.setItem(storageKey, theme); } catch { /* Optional persistence. */ }
    };
    applyTheme(initialTheme);
    button.addEventListener('click', async () => {
      const theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
      if (!document.startViewTransition || matchMedia('(prefers-reduced-motion: reduce)').matches) {
        applyTheme(theme);
        return;
      }
      const bounds = button.getBoundingClientRect();
      const x = bounds.left + bounds.width / 2;
      const y = bounds.top + bounds.height / 2;
      const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
      button.disabled = true;
      root.classList.add('theme-changing');
      try {
        const transition = document.startViewTransition(() => applyTheme(theme));
        await transition.ready;
        await root.animate({
          clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`]
        }, {
          duration: 650,
          easing: 'cubic-bezier(.22, 1, .36, 1)',
          pseudoElement: '::view-transition-new(root)'
        }).finished;
        await transition.finished;
      } catch {
        applyTheme(theme);
      } finally {
        root.classList.remove('theme-changing');
        button.disabled = false;
      }
    });
  });
})();
