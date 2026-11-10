// The shell is precached so the app opens with no network. The vendored
// libraries are not: pdf.js and its worker are 1.7 MB together, and most visits
// never open a PDF. They are cached the first time they are actually fetched, so
// the second PDF opens offline. The QR encoder and jsQR are the exception and
// are precached into the vendor cache: Send to a device is meant to work with
// no network, and a tab outlives the local server it came from, so a QR code
// fetched on first use would be missing exactly when it is needed.
//
// Bump VERSION whenever anything in SHELL changes. The fetch handler answers
// from the cache before it asks the network, so a returning tab keeps the
// index.html it installed until the name of the cache changes underneath it.

const VERSION = 'v40'
const SHELL_CACHE = `textarea-shell-${VERSION}`
const VENDOR_CACHE = `textarea-vendor-${VERSION}`
// Deliberately not derived from VERSION: the model is 241 MB, and a cache
// name that changed on every release would delete it on every release. The
// chunks carry their own versioning - their names are pinned in
// models/manifest.json, and a new model ships under new names - so a
// cache-first answer here is never stale, and never worth re-paying for.
const MODELS_CACHE = 'textarea-models'

// The folder this worker serves: '/' locally, '/textarea/' on GitHub Pages.
// Every path below is written from the root and moved under it here.
const BASE = new URL('./', location.href).pathname
const at = (path) => BASE + path.slice(1)

const SHELL = [
  '/',
  '/index.html',
  '/app.js',
  '/manifest.json',
  '/lib/appearance.js',
  '/lib/attachments.js',
  '/lib/backlinks-panel.js',
  '/lib/backlinks.js',
  '/lib/backup.js',
  '/lib/board-panel.js',
  '/lib/clipboard.js',
  '/lib/dialog.js',
  '/lib/editor.js',
  '/lib/encryption-panel.js',
  '/lib/export-panel.js',
  '/lib/export.js',
  '/lib/features.js',
  '/lib/file-links.js',
  '/lib/file-notice.js',
  '/lib/filename.js',
  '/lib/files.js',
  '/lib/filter.js',
  '/lib/find-panel.js',
  '/lib/find.js',
  '/lib/folder-sync.js',
  '/lib/fonts.js',
  '/lib/formats.js',
  '/lib/front-matter.js',
  '/lib/gemma.js',
  '/lib/glass.js',
  '/lib/database-panel.js',
  '/lib/database.js',
  '/lib/graph-panel.js',
  '/lib/graph.js',
  '/lib/library-panel.js',
  '/lib/library.js',
  '/lib/markdown.js',
  '/lib/menu.js',
  '/lib/nearby-panel.js',
  '/lib/nearby.js',
  '/lib/note.js',
  '/lib/notify.js',
  '/lib/organise.js',
  '/lib/open.js',
  '/lib/pdf-layout.js',
  '/lib/pdf.js',
  '/lib/prefs.js',
  '/lib/properties.js',
  '/lib/qr-panel.js',
  '/lib/qr-scan.js',
  '/lib/qr.js',
  '/lib/read-note.js',
  '/lib/save.js',
  '/lib/settings-panel.js',
  '/lib/settings-rows.js',
  '/lib/share.js',
  '/lib/shell.js',
  '/lib/shortcuts.js',
  '/lib/signals.js',
  '/lib/slash.js',
  '/lib/speech-panel.js',
  '/lib/stats-panel.js',
  '/lib/stats.js',
  '/lib/sticky.js',
  '/lib/style.js',
  '/lib/switcher.js',
  '/lib/sync.js',
  '/lib/tasks-panel.js',
  '/lib/tasks-view.js',
  '/lib/tasks.js',
  '/lib/theme.js',
  '/lib/views.js',
  '/lib/write-back.js',
  '/lib/whisper-worker.js',
  '/lib/whisper.js',
  '/lib/writing-tools.js',
  '/lib/zip.js',
].map(at)

// Precached into VENDOR_CACHE, which the fetch handler reads first for /vendor/.
const VENDOR = ['/vendor/qr/qrcode.mjs', '/vendor/qr/qrcode_UTF8.mjs', '/vendor/jsqr/jsQR.js'].map(at)

const isVendored = (url) => url.pathname.startsWith(at('/vendor/'))

self.addEventListener('install', (event) => {
  event.waitUntil(
    Promise.all([
      // One missing file must not fail the whole install.
      caches.open(SHELL_CACHE).then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url)))),
      caches.open(VENDOR_CACHE).then((cache) => Promise.allSettled(VENDOR.map((url) => cache.add(url)))),
    ]).then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  const current = [SHELL_CACHE, VENDOR_CACHE, MODELS_CACHE]
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((name) => !current.includes(name)).map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== location.origin) return

  if (isVendored(url)) {
    // Cache first: these files carry a version in their path only by convention,
    // so re-downloading them on every open would waste megabytes.
    event.respondWith(
      caches.open(VENDOR_CACHE).then(async (cache) => {
        const cached = await cache.match(request)
        if (cached) return cached
        const response = await fetch(request)
        // Range requests must not be cached; the responses are not complete.
        if (response.ok && response.status === 200 && request.headers.get('range') === null) {
          cache.put(request, response.clone())
        }
        return response
      }),
    )
    return
  }

  if (url.pathname.startsWith(at('/models/'))) {
    // Cache first, into a cache that survives releases: the first Load
    // model pays the 241 MB once, and every run after it - including the
    // offline ones - reads the committed bytes back from here. Nothing in
    // the install event touches this cache; see MODELS_CACHE above for
    // why that cache has no version in its name.
    event.respondWith(
      caches.open(MODELS_CACHE).then(async (cache) => {
        const cached = await cache.match(request)
        if (cached) return cached
        const response = await fetch(request)
        if (response.ok && response.status === 200) {
          cache.put(request, response.clone())
        }
        return response
      }),
    )
    return
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached
      return fetch(request)
        .then((response) => {
          if (response.ok && response.status === 200) {
            const copy = response.clone()
            caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy))
          }
          return response
        })
        .catch(() => {
          // Offline and not cached: the navigation fallback is the shell.
          if (request.mode === 'navigate') return caches.match(at('/index.html'))
          return Response.error()
        })
    }),
  )
})
