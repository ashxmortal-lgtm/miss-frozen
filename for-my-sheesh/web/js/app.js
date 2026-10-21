import { createApp } from './app-core.js';

// The real entry point: Telegram WebApp + TGCloud endpoint bridge.
if (typeof window !== 'undefined' && !window.__FMS_DISABLE_AUTOBOOT__) {
  const boot = () => {
    void createApp().start();
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
}
