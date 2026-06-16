(function () {
  var CACHE_RESET_VERSION = '20260616-report-dealer-fix';
  var CACHE_RESET_KEY = 'dakshCacheResetVersion';

  function readStoredVersion() {
    try {
      return window.localStorage ? localStorage.getItem(CACHE_RESET_KEY) || '' : '';
    } catch (error) {
      return '';
    }
  }

  function writeStoredVersion() {
    try {
      if (window.localStorage) localStorage.setItem(CACHE_RESET_KEY, CACHE_RESET_VERSION);
    } catch (error) {}
  }

  function clearServiceWorkers() {
    if (!navigator.serviceWorker || !navigator.serviceWorker.getRegistrations) return Promise.resolve();
    return navigator.serviceWorker.getRegistrations().then(function (registrations) {
      return Promise.all(registrations.map(function (registration) {
        return registration.unregister().catch(function () {
          return false;
        });
      }));
    }).catch(function () {
      return [];
    });
  }

  function clearCaches() {
    if (!window.caches || !caches.keys) return Promise.resolve();
    return caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (key) {
        return caches.delete(key).catch(function () {
          return false;
        });
      }));
    }).catch(function () {
      return [];
    });
  }

  if (readStoredVersion() === CACHE_RESET_VERSION) return;

  if (typeof Promise === 'undefined') {
    writeStoredVersion();
    return;
  }

  Promise.resolve()
    .then(function () {
      return clearServiceWorkers();
    })
    .then(function () {
      return clearCaches();
    })
    .then(writeStoredVersion)
    .catch(writeStoredVersion);
})();
