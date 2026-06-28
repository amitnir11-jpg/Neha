(function () {
  const APP_VERSION = '20260628-exact-qr-duplicate-v1';
  const SERVICE_WORKER_VERSION = APP_VERSION;
  const PRESERVED_LOCAL_KEYS = new Set([
    'dakshToken',
    'dakshUser',
    'dakshDeviceId',
    'dakshRememberMe'
  ]);
  const PRESERVED_LOCAL_PREFIXES = ['dakshInventorySyncQueue'];

  function clean(value) {
    return String(value === undefined || value === null ? '' : value).trim();
  }

  function serverVersion() {
    const config = window.DAKSH_CONFIG || {};
    return clean(config.appVersion || config.webScannerBuild || config.mobileAppVersion || config.version || '');
  }

  async function clearBrowserCacheStorage() {
    if (!window.caches || typeof caches.keys !== 'function') return;
    const keys = await caches.keys().catch(() => []);
    await Promise.all(keys.map((key) => caches.delete(key).catch(() => false)));
  }

  async function unregisterServiceWorkers() {
    if (!navigator.serviceWorker || typeof navigator.serviceWorker.getRegistrations !== 'function') return;
    const registrations = await navigator.serviceWorker.getRegistrations().catch(() => []);
    await Promise.all(registrations.map((registration) => registration.unregister().catch(() => false)));
  }

  function clearLocalBrowserStorage() {
    try {
      if (!window.localStorage) return;
      const keys = [];
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        const preserve = key && (
          PRESERVED_LOCAL_KEYS.has(key) ||
          PRESERVED_LOCAL_PREFIXES.some((prefix) => key === prefix || key.startsWith(`${prefix}:`))
        );
        if (key && key.startsWith('daksh') && !preserve) keys.push(key);
      }
      keys.forEach((key) => localStorage.removeItem(key));
    } catch (_) {}
  }

  function clearSessionBrowserStorage() {
    try {
      if (window.sessionStorage) sessionStorage.clear();
    } catch (_) {}
  }

  async function clearClientCaches() {
    await clearBrowserCacheStorage();
    clearLocalBrowserStorage();
    clearSessionBrowserStorage();
    await unregisterServiceWorkers();
  }

  async function refreshForVersionMismatch(serverBuild = '', { quiet = false } = {}) {
    const build = clean(serverBuild);
    if (!build || build === APP_VERSION) return false;
    if (!quiet) {
      const confirmed = window.confirm('New update available. Please refresh application.');
      if (!confirmed) return true;
    }
    await clearClientCaches().catch(() => undefined);
    window.location.reload();
    return true;
  }

  async function clearCacheAndReload() {
    await clearClientCaches().catch(() => undefined);
    window.location.reload();
  }

  async function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return null;
    if (window.location.protocol !== 'https:' && !['localhost', '127.0.0.1', '::1'].includes(window.location.hostname)) return null;
    try {
      return await navigator.serviceWorker.register(`/sw.js?v=${encodeURIComponent(SERVICE_WORKER_VERSION)}`, { scope: '/' });
    } catch (error) {
      console.warn('Service worker registration failed', error);
      return null;
    }
  }

  window.DAKSH_APP_VERSION = APP_VERSION;
  window.DAKSH_RUNTIME = {
    APP_VERSION,
    SERVICE_WORKER_VERSION,
    clearClientCaches,
    clearCacheAndReload,
    refreshForVersionMismatch,
    registerServiceWorker
  };

  const initialServerVersion = serverVersion();
  if (initialServerVersion) {
    Promise.resolve().then(() => refreshForVersionMismatch(initialServerVersion).catch(() => undefined));
  }

  window.addEventListener('load', () => {
    registerServiceWorker().catch(() => undefined);
  });
})();
