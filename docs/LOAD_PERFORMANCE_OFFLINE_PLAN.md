# Load Performance + Offline-First Improvements

This pass identifies five concrete changes to speed load and remove internet dependencies.

## 1) Remove render-blocking external font downloads ✅ implemented
- `index.html` no longer requests Google Fonts at startup.
- Result: first paint is no longer blocked by internet requests to `fonts.googleapis.com` / `fonts.gstatic.com`.

## 2) Start from cached table metadata before network ✅ implemented
- `AminoData.init()` now loads table metadata from IndexedDB first (`loadTablesFromCache()`), then refreshes in the background from API.
- If API is unavailable and cached tables exist, app continues in offline mode.
- Result: faster startup and usable UI without internet.

## 3) Parallelize decrypt work for table reads ✅ implemented
- `getTableRecords()` and room-rebuild cache hydration now decrypt with `Promise.all` rather than record-by-record serial awaits.
- Result: lower wait time when opening larger tables from encrypted local storage.

## 4) Parallelize encryption preparation on hydration/sync ✅ implemented
- Added `prepareEncryptedRecords()` to pre-encrypt a batch in parallel before IndexedDB writes.
- Used by full hydration and incremental sync paths.
- Result: less wall-clock delay caused by repeated encryption operations.

## 5) Add service worker + asset manifest for full offline shell ✅ implemented
- Added `sw.js` with shell precache and cache-first serving for local HTML/JS/CSS shell assets.
- Added `manifest.webmanifest` and service worker registration in `index.html`.
- Result: DB Viewer shell can start offline after first load, without re-downloading core local assets.


## Remaining caveat
- `Home.html` and `Events.html` still contain third-party hosted assets/scripts; they need local bundling if those routes must be fully offline too.
