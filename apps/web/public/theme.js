/* Applies the stored theme before first paint (same localStorage key as the product site: cmc-theme). */
(() => {
  try {
    const stored = window.localStorage.getItem('cmc-theme');
    if (stored === 'light' || stored === 'dark') document.documentElement.setAttribute('data-theme', stored);
  } catch {
    /* storage blocked: follow the system setting */
  }
})();
