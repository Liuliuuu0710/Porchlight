// Device previews are explicit. Actual phones always use their real viewport/insets.
(() => {
  const root = document.documentElement;
  const preview = new URLSearchParams(location.search).get('preview');
  root.dataset.platform = preview === 'mini' || (!preview && /iPhone|iPad|iPod/.test(navigator.userAgent)) ? 'ios' : 'android';
  if (preview === 'mini' || preview === 'x8') {
    root.style.setProperty('--safe-top', preview === 'mini' ? '50px' : '32px');
    root.style.setProperty('--safe-bottom', preview === 'mini' ? '34px' : '24px');
  }
  addEventListener('DOMContentLoaded', () => {
    const viewport = window.visualViewport;
    let baseline = window.innerHeight;
    function sync() {
      const height = viewport ? viewport.height : innerHeight;
      const editing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '');
      if (!editing) baseline = innerHeight;
      const keyboard = editing && Math.max(baseline, innerHeight) - height > 120 && (!viewport || viewport.scale < 1.1);
      root.classList.toggle('keyboard-open', keyboard);
      root.style.setProperty('--visible-height', height + 'px');
      const dialog = document.getElementById('dialog');
      // On iOS the layout viewport remains tall while the visual viewport shrinks.
      dialog.style.bottom = keyboard ? Math.max(0, innerHeight - height - (viewport?.offsetTop || 0)) + 'px' : '';
    }
    viewport?.addEventListener('resize', sync);
    viewport?.addEventListener('scroll', sync);
    addEventListener('resize', sync);
    document.addEventListener('focusin', sync);
    document.addEventListener('focusout', () => requestAnimationFrame(sync));
    addEventListener('orientationchange', () => { baseline = innerHeight; });
    sync();
  });
})();

