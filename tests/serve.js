// A static file server for the tests, and for `npm run serve`.
//
// The app has no build step, but it does use ES modules, which browsers refuse to
// load over file:// — so the tests need an origin.

import {createReadStream, promises as fs} from 'node:fs'
import {createServer} from 'node:http'
import {extname, join, normalize, resolve} from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')

// The same headers vercel.json sends in production. Serving them here is not
// decoration: the browser tests fail on a console error, so a Content-Security
// Policy that the app cannot live with breaks the suite rather than the
// deployment. tests/unit/headers.test.js keeps this and vercel.json in step.
//
// `'wasm-unsafe-eval'` in script-src is the on-device model: compiling a
// WebAssembly.Module counts as script execution, and this token grants that
// one act and nothing weaker - plain `'unsafe-eval'` and `'unsafe-inline'`
// stay banned, which the header tests assert by taking the grant back out.
//
// `https://raw.githubusercontent.com` in connect-src is the custom-font
// shelf's one way out of the page: a link to a font file in a public
// repository, refused before the fetch unless it has exactly that host
// (lib/fonts.js keeps that promise, and its own tests grade it). One
// origin, named; no wildcard and no second host, which the header test
// pins by comparing the whole directive.
//
// `microphone=(self)` in permissions-policy is speech to text: Record asks
// for the microphone, on this origin and no frame inside it. `camera=(self)` is
// Send to a device scanning the other device's code. Everything else
// in that header stays empty.
export const HEADERS = {
  'content-security-policy':
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://raw.githubusercontent.com; worker-src 'self' blob:; manifest-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy':
    'camera=(self), microphone=(self), geolocation=(), payment=(), usb=(), browsing-topics=()',
  'cross-origin-opener-policy': 'same-origin',
  'strict-transport-security': 'max-age=63072000; includeSubDomains',
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.pfb': 'application/octet-stream',
  '.bcmap': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
}

export function createStaticServer() {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost')
      let pathname = decodeURIComponent(url.pathname)
      if (pathname.endsWith('/')) pathname += 'index.html'

      // Refuse to serve anything outside the project directory, and the git
      // directory in particular: a test server has no business handing out
      // remotes or hooks even on loopback.
      const path = join(ROOT, normalize(pathname).replace(/^(\.\.[/\\])+/, ''))
      if (path.split('/').includes('.git')) {
        response.writeHead(404, {'content-type': 'text/plain'}).end('Not found')
        return
      }
      if (path !== ROOT && !path.startsWith(ROOT + '/')) {
        response.writeHead(403).end('Forbidden')
        return
      }

      const stat = await fs.stat(path).catch(() => null)
      if (!stat?.isFile()) {
        response.writeHead(404, {'content-type': 'text/plain'}).end('Not found')
        return
      }

      response.writeHead(200, {
        'content-type': TYPES[extname(path)] ?? 'application/octet-stream',
        'content-length': stat.size,
        'cache-control': 'no-store',
        ...HEADERS,
      })
      createReadStream(path).pipe(response)
    } catch (error) {
      response.writeHead(500, {'content-type': 'text/plain'}).end(String(error))
    }
  })
}

/** Start on a free port and resolve the base URL. */
export function listen(port = 0) {
  const server = createStaticServer()
  return new Promise((resolvePromise) => {
    server.listen(port, '127.0.0.1', () => {
      const {port: actual} = server.address()
      resolvePromise({
        server,
        origin: `http://127.0.0.1:${actual}`,
        close: () => new Promise((done) => server.close(done)),
      })
    })
  })
}

if (process.argv[1] === import.meta.filename) {
  const {origin} = await listen(Number(process.env.PORT ?? 8080))
  console.log(`Serving ${ROOT} at ${origin}`)
}
