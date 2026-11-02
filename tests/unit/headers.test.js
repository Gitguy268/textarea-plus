// The security headers, and that the two places that send them agree.
//
// vercel.json is what production serves; tests/serve.js is what the browser
// tests run under. They are separate code paths over the same values, so the
// cheap way to keep them from drifting is to compare them here.

import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import test from 'node:test'

import {HEADERS} from '../serve.js'

test('vercel.json and the test server send the same security headers', async () => {
  const vercel = JSON.parse(await readFile(new URL('../../vercel.json', import.meta.url), 'utf8'))
  const block = vercel.headers?.find((entry) => entry.source === '/(.*)')
  assert.ok(block, 'vercel.json has a headers block for every path')

  const sent = Object.fromEntries(block.headers.map(({key, value}) => [key.toLowerCase(), value]))
  assert.deepEqual(sent, HEADERS)
})

test('the policy the app runs under does not loosen script execution', () => {
  const csp = HEADERS['content-security-policy']

  // The wasm grant is required, present exactly as the on-device model needs
  // it - and then taken back out, so the assertion below judges the policy a
  // reader of the policy could have written wrong: no plain unsafe-eval, no
  // unsafe-inline, no scope wider than script-src.
  assert.match(csp, /script-src 'self' 'wasm-unsafe-eval'/)
  assert.ok(!/default-src[^;]*wasm-unsafe/.test(csp), 'the wasm grant stays in script-src')
  const scripts = /script-src[^;]*/.exec(csp)[0].replaceAll("'wasm-unsafe-eval'", '')
  assert.ok(!scripts.includes('unsafe-eval'), 'no unsafe-eval beyond the wasm grant')
  assert.ok(!scripts.includes('unsafe-inline'), 'no inline scripts')
  assert.match(csp, /object-src 'none'/)
  assert.match(csp, /base-uri 'none'/)
  assert.match(csp, /frame-ancestors 'none'/)
  assert.equal(HEADERS['x-content-type-options'], 'nosniff')
  assert.equal(HEADERS['x-frame-options'], 'DENY')
  assert.equal(HEADERS['referrer-policy'], 'strict-origin-when-cross-origin')
})

test('the only host the policy connects to beyond itself is GitHub raw', () => {
  const csp = HEADERS['content-security-policy']
  const connect = /connect-src ([^;]+)/.exec(csp)?.[1] ?? ''

  // The custom-font shelf imports a font file from one origin and no
  // other. Every drift fails here by name: the grant dropped (a reader
  // with a link gets a refused fetch), a second host or a wildcard
  // added (the check in fonts.js would no longer be what decides), or
  // the directive rewritten so the browser suite's fetch moves without
  // anyone noticing.
  assert.equal(connect, "'self' https://raw.githubusercontent.com")
})

test('the microphone and the camera are the only devices the page may ask for, and only as itself', () => {
  // Speech to text records on a press of Record; Send to a device scans a
  // code on a press of Scan. Every drift fails here by name: a grant dropped
  // (the browser refuses before it asks), widened to a frame or a wildcard,
  // or a third device let in beside them.
  assert.equal(
    HEADERS['permissions-policy'],
    'camera=(self), microphone=(self), geolocation=(), payment=(), usb=(), browsing-topics=()',
  )
})
