// Decorative, non-blocking effects. The falling sakura are pure CSS animations
// on eight fixed elements; no animation loop, no canvas, no layout thrash.

export function prefersReducedMotion(win) {
  try {
    return typeof win.matchMedia === 'function' && win.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export function initPetals(doc, win) {
  const container = doc.getElementById('petals');
  if (!container) return;
  container.replaceChildren();
  if (prefersReducedMotion(win)) return;

  for (let index = 0; index < 8; index += 1) {
    const petal = doc.createElement('span');
    petal.className = 'petal';
    petal.setAttribute('aria-hidden', 'true');
    container.appendChild(petal);
  }
}

/** Best-effort Telegram chrome; never required for the gift to work. */
export function initTelegramChrome(win) {
  const webApp = win?.Telegram?.WebApp;
  if (!webApp) return false;
  try {
    if (typeof webApp.ready === 'function') webApp.ready();
    if (typeof webApp.expand === 'function') webApp.expand();
    if (typeof webApp.setHeaderColor === 'function') webApp.setHeaderColor('#fff6fb');
    if (typeof webApp.setBackgroundColor === 'function') webApp.setBackgroundColor('#fff9fc');
    if (webApp.BackButton && typeof webApp.BackButton.hide === 'function') {
      webApp.BackButton.hide();
    }
    return true;
  } catch {
    return false;
  }
}

export function scrollToTop(win) {
  try {
    const reduced = prefersReducedMotion(win);
    win.scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' });
  } catch {
    // Older clients simply stay where they are; the letter remains scrollable.
  }
}
