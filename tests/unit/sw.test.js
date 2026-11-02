// The service worker's policy, as far as a Node process can check it.
//
// The browser suite owns what the worker looks like from the outside: that it
// registers, that the shell lands in a cache, that pdf.js arrives on demand.
// What a Node process can check is the decision-making behind that - which
// caches survive an activation (the update flow's second half), what the
// vendored strategy answers with, and where a navigation goes when nothing is
// cached. Each of those is the difference between a release that costs
// nothing and one that re-downloads megabytes or opens a blank page offline.
//
// sw.js only ever registers listeners at import time, so the worker scope is
// stubbed first and the module is imported once; every test then drives the
// handler it owns through a captured event.

import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {test} from 'node:test'

/** The listeners sw.js registered, in order of registration. */
const listeners = new Map()

globalThis.self = {
  addEventListener: (type, handler) => listeners.set(type, handler),
  skipWaiting: async () => {},
  clients: {claim: async () => {}},
}
// The worker's origin: the fetch handler compares every request against it.
globalThis.location = new URL('https://textarea.local/')
// No test may reach the real network without saying so; a handler that asks
// when it should not have is a failed test, not a slow one.
globalThis.fetch = async () => {
  throw new Error('the network was asked without a test saying to ask it')
}

await import('../../sw.js')

const source = await readFile(new URL('../../sw.js', import.meta.url), 'utf8')
const version = /const VERSION = '([^']+)'/.exec(source)?.[1]
assert.ok(version, 'sw.js declares a VERSION')

/** Run one handler to completion, resolving with whatever waitUntil was given. */
function fire(type, request = {}) {
  return new Promise((resolve, reject) => {
    listeners.get(type)({
      waitUntil: (work) => Promise.resolve(work).then(resolve, reject),
      respondWith: (response) => {
        // The fetch handler answers through respondWith rather than waitUntil.
        resolve(Promise.resolve(response))
      },
      request: {method: 'GET', headers: {get: () => null}, mode: 'no-cors', ...request},
    })
  })
}

test('an install survives the shell files that are missing', async () => {
  const added = []
  let skipped = false
  globalThis.self.skipWaiting = async () => {
    skipped = true
  }
  globalThis.caches = {
    open: async () => ({
      add: async (path) => {
        added.push(path)
        if (path === '/lib/theme.js') throw new Error('404')
      },
    }),
  }

  // allSettled, not all: one missing file must not take the install down
  // with it, or the worker never reaches a state it can serve from.
  await fire('install')
  assert.ok(added.includes('/app.js'), 'the rest of the shell was still asked for')
  assert.ok(added.includes('/vendor/qr/qrcode.mjs'), 'the QR encoder is precached for offline pairing')
  assert.ok(added.includes('/vendor/jsqr/jsQR.js'), 'and so is the scanner')
  assert.equal(skipped, true, 'the install completed into a skipWaiting')
})

test('an activation deletes the caches its version replaced', async () => {
  const deleted = []
  globalThis.self.skipWaiting = async () => {}
  globalThis.caches = {
    keys: async () => [
      `textarea-shell-${version}`,
      `textarea-vendor-${version}`,
      'textarea-shell-v0-replaced',
      'textarea-vendor-v0-replaced',
      'unrelated-cache',
    ],
    delete: async (name) => {
      deleted.push(name)
      return true
    },
  }

  await fire('activate')
  assert.deepEqual(
    [...deleted].sort(),
    ['textarea-shell-v0-replaced', 'textarea-vendor-v0-replaced', 'unrelated-cache'],
    'the current pair survives and everything else is pruned',
  )
})

test('the vendored strategy answers from the cache and keeps what it fetches', async () => {
  const cached = new Map()
  const puts = []
  let network = 0
  globalThis.caches = {
    open: async () => ({
      match: async (request) => (cached.has(request.url) ? new Response(cached.get(request.url)) : undefined),
      put: (request, response) => {
        puts.push(request.url)
        return response.text().then((text) => cached.set(request.url, text))
      },
    }),
    match: async () => null,
  }
  globalThis.fetch = async () => {
    network++
    return new Response('from the network')
  }

  const file = 'https://textarea.local/vendor/pdfjs/pdf.min.mjs'
  cached.set(file, 'from the cache')

  const hit = await fire('fetch', {url: file})
  assert.equal(await hit.text(), 'from the cache', 'a cached vendor file is the answer')
  assert.equal(network, 0, 'and the network is not asked for it')

  const miss = 'https://textarea.local/vendor/qr/qrcode.mjs'
  const first = await fire('fetch', {url: miss})
  assert.equal(await first.text(), 'from the network', 'an uncached vendor file goes to the network')
  assert.deepEqual(puts, [miss], 'and is kept for the next time')

  const range = await fire('fetch', {
    url: miss,
    headers: {get: (name) => (name === 'range' ? 'bytes=0-9' : null)},
  })
  assert.equal(await range.text(), 'from the network', 'a range request is never answered from a whole file')
  assert.deepEqual(puts, [miss], 'nor cached: the response would not be complete')
})

test('offline, a navigation falls back to the cached shell', async () => {
  globalThis.caches = {
    match: async (request) =>
      request === '/index.html' ? new Response('<html>the cached shell</html>') : null,
  }
  globalThis.fetch = async () => {
    throw new TypeError('offline')
  }

  const navigation = await fire('fetch', {url: 'https://textarea.local/', mode: 'navigate'})
  assert.equal(await navigation.text(), '<html>the cached shell</html>')

  const missing = await fire('fetch', {url: 'https://textarea.local/lib/not-there.js'})
  assert.equal(missing.type, 'error', 'an uncached asset offline fails as a response, not an exception')
})

test('the shell lists every module in lib/, and nothing that is not there', async () => {
  // A module the split adds and the shell forgets works online and fails on
  // the first offline reload - the one place nobody is looking.
  const {readdir} = await import('node:fs/promises')
  const onDisk = (await readdir(new URL('../../lib/', import.meta.url)))
    .filter((name) => name.endsWith('.js'))
    .map((name) => `/lib/${name}`)
    .sort()
  const listed = [...source.matchAll(/'(\/lib\/[^']+)'/g)].map((match) => match[1]).sort()
  assert.deepEqual(listed, onDisk)
})
