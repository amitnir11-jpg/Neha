# Mobile Browser Compatibility Fix

## Root Cause

Two browser-failure vectors were present:

1. The mobile scanner URL was not serving the scanner directly. `/mobile-scanner` redirected to `/mobile-scanner.html`, and the HTML file redirected back to `/mobile-scanner`, which could loop or otherwise fail depending on browser redirect/cache behavior.
2. The mobile web entrypoints were also shipping raw front-end source files (`public/js/app.js`, `public/ui.js`, `public/scan.js`) directly to browsers. Those files contain modern ECMAScript features such as optional chaining, nullish coalescing, arrow functions, async/await, and other syntax that some mobile browsers and embedded WebViews still reject.

Microsoft Edge on newer Chromium builds could recover or render the app path more forgivingly, while older or stricter browser engines on Chrome Android, Samsung Internet, Safari iPhone, and Android WebView could fail before the UI finished booting.

## Corrective Action

- Added a browser compatibility build step with `esbuild`.
- Generated legacy browser bundles for the login, dashboard, reports, and mobile scanner pages.
- Updated the HTML entrypoints to load the compatibility bundles instead of the raw source files.
- Disabled HTML caching for the app entrypoints so stale pages are not reused after deployment.
- Added a cache-reset helper that unregisters any old service workers and clears stale caches on version change.

## Verification Notes

- The server now serves HTML entrypoints with `Cache-Control: no-store`.
- The client build is generated during install/deploy via `postinstall`.
- No service worker registration exists in the current source tree, so the cache-reset helper is a safety net for older browser state.
