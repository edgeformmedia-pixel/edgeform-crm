(() => {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced) return;
  const originalShowPage = window.showPage;
  window.showPage = function(name) {
    originalShowPage(name);
    const active = document.getElementById('page-' + name);
    if (!active) return;
    active.querySelectorAll(':scope > *').forEach((el) => {
      el.style.animation = 'none';
      requestAnimationFrame(() => { el.style.animation = ''; });
    });
  };
  document.querySelectorAll('.kpi').forEach(card => card.addEventListener('pointermove', event => {
    const rect = card.getBoundingClientRect();
    card.style.background = `radial-gradient(circle at ${event.clientX - rect.left}px ${event.clientY - rect.top}px, #fff, var(--surface) 60%)`;
  }));
})();
