import { ClientError, fetchAccessStatus, fetchGift } from './api.js';
import { initPetals, initTelegramChrome, scrollToTop } from './effects.js';
import { currentView, renderLetter, setBusy, showError, showView } from './render.js';
import { parseRoute, ROUTE_GIFT } from './route.js';

export const ACCESS_DENIED = 'You are not allowed to open this app.';
const BOOT_FALLBACK = 'The gift could not be opened. Please try again in a moment. 🎀';

/**
 * Testable application shell. The default export path (app.js) wires the real
 * Telegram bridge; tests inject a fake `api`.
 */
export function createApp(options = {}) {
  const doc = options.document ?? document;
  const win = options.window ?? window;
  const api =
    options.api ??
    {
      accessStatus: () => fetchAccessStatus(),
      gift: () => fetchGift(),
    };
  const route = options.route ?? parseRoute(win.location?.pathname, win.location?.search);

  let started = false;
  let busy = false;
  let bound = false;
  let retryAction = 'boot';

  const openButton = doc.getElementById('open-gift');
  const backButton = doc.getElementById('back-to-cover');
  const retryButton = doc.getElementById('retry');
  const errorBackButton = doc.getElementById('error-back');

  function bind() {
    if (bound) return;
    bound = true;
    openButton?.addEventListener('click', () => {
      void openGift();
    });
    backButton?.addEventListener('click', backToCover);
    retryButton?.addEventListener('click', () => {
      void retry();
    });
    errorBackButton?.addEventListener('click', backToCover);
  }

  function showFailure(error, fromGift) {
    retryAction = fromGift ? 'gift' : 'boot';
    if (errorBackButton) errorBackButton.hidden = !fromGift;
    showError(doc, error?.message || BOOT_FALLBACK);
  }

  async function refreshAccess() {
    showView(doc, 'loading');
    if (errorBackButton) errorBackButton.hidden = true;
    try {
      const status = await api.accessStatus();
      if (!status || status.allowed !== true) {
        throw new ClientError(ACCESS_DENIED, 'FORBIDDEN');
      }
      showView(doc, 'cover');
      retryAction = 'boot';
      try {
        doc.body.dataset.route = route;
      } catch {
        /* non-fatal */
      }
      return true;
    } catch (error) {
      showFailure(error, false);
      return false;
    }
  }

  async function start() {
    if (started) return;
    started = true;
    bind();
    initTelegramChrome(win);
    initPetals(doc, win);
    await refreshAccess();
  }

  async function openGift() {
    if (busy) return;
    busy = true;
    setBusy(doc, openButton, true);
    try {
      const result = await api.gift();
      const gift = result?.gift ?? result;
      if (!gift || !Array.isArray(gift.paragraphs) || gift.paragraphs.length === 0) {
        throw new Error(BOOT_FALLBACK);
      }
      renderLetter(doc, gift);
      retryAction = 'boot';
      showView(doc, 'letter');
      scrollToTop(win);
      const heading = doc.getElementById('letter-heading');
      if (heading) {
        try {
          heading.setAttribute('tabindex', '-1');
          heading.focus({ preventScroll: true });
        } catch {
          /* focus is a nicety */
        }
      }
    } catch (error) {
      showFailure(error, true);
    } finally {
      busy = false;
      setBusy(doc, openButton, false);
    }
  }

  function backToCover() {
    retryAction = 'boot';
    if (errorBackButton) errorBackButton.hidden = true;
    showView(doc, 'cover');
    scrollToTop(win);
  }

  async function retry() {
    if (retryAction === 'gift') return openGift();
    return refreshAccess();
  }

  return {
    route,
    start,
    openGift,
    backToCover,
    retry,
    getView: () => currentView(doc),
    isGiftRoute: () => route === ROUTE_GIFT,
  };
}
