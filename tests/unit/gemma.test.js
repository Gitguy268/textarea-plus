// The engine's arithmetic: what it will fetch, and how it knows the bytes
// are the ones this repository pinned.
//
// The wasm half cannot run here - that would put a 241 MB model and an
// inference run inside every gate - so what is checked is everything the
// model is a stranger to: the manifest this repository actually ships
// against the rules the loader enforces, the checksum that catches a
// changed byte, and the progress line a reader watches while it happens.

import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {open, readFile} from 'node:fs/promises'
import {test} from 'node:test'

import {fetchMessage, fetchPlan, loadEngine, manifestFiles, MODELS, verifyChunk} from '../../lib/gemma.js'

const manifestUrl = new URL('../../models/manifest.json', import.meta.url)

const someManifest = (over = {}) => ({
  totalSize: 67_108_864 * 2,
  chunks: [
    {path: 'model.part1', size: 67_108_864, sha256: 'a'.repeat(64)},
    {path: 'model.part2', size: 67_108_864, sha256: 'b'.repeat(64)},
  ],
  ...over,
})

test('the chunks this repository ships are the ones the manifest pins', async () => {
  const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'))
  const plan = fetchPlan(manifest)

  assert.equal(plan.length, manifest.chunks.length)
  assert.deepEqual(
    plan.map((chunk) => chunk.path),
    manifest.chunks.map((chunk) => chunk.path),
    'the order the chunks are fetched in is the order they were written in',
  )
  for (const chunk of plan) {
    assert.match(chunk.path, /^[\w.-]+$/, `${chunk.path} is a plain filename`)
  }

  // The first chunk carries the GGUF header and every field that decides
  // whether the model can load at all, so its bytes are the ones worth
  // re-reading from disk against the pinned hash on every run. The rest
  // are checked the same way, chunk by chunk, the moment the loader
  // fetches them - in a browser, once, not in every gate.
  const first = plan[0]
  const partUrl = new URL(`../../models/${first.path}`, import.meta.url)
  const handle = await open(partUrl, 'r')
  try {
    const bytes = Buffer.alloc(first.size)
    const {bytesRead} = await handle.read(bytes, 0, first.size, 0)
    assert.equal(bytesRead, first.size)
    const actual = createHash('sha256').update(bytes).digest('hex')
    assert.equal(actual, first.sha256, 'the first chunk on disk is the one the manifest pins')
  } finally {
    await handle.close()
  }
})

test('a manifest that does not add up is refused', () => {
  assert.throws(() => fetchPlan(someManifest({totalSize: 1})), /adds up to 134217728, not 1/)

  assert.throws(
    () => fetchPlan(someManifest({chunks: []})),
    /lists no chunks/,
    'an empty list is not a plan',
  )
  assert.throws(() => fetchPlan({}), /lists no chunks/)

  assert.throws(
    () => fetchPlan(someManifest({chunks: [{path: 'x', size: -5, sha256: 'a'.repeat(64)}]})),
    /no usable size/,
    'a negative size is not a size',
  )
  assert.throws(
    () => fetchPlan(someManifest({chunks: [{path: 'x', size: 1.5, sha256: 'a'.repeat(64)}]})),
    /no usable size/,
    'a fractional size cannot be waited for',
  )
})

test('a chunk path is a filename, because it goes into a URL unescaped', () => {
  for (const path of ['../part1', 'sub/part1', '/etc/passwd', '', 'part 1', 'part1?x=1']) {
    assert.throws(
      () => fetchPlan(someManifest({chunks: [{path, size: 67_108_864, sha256: 'a'.repeat(64)}]})),
      /not a plain filename/,
      `${JSON.stringify(path)} must not pass`,
    )
  }
})

test('a checksum is 64 hex digits, compared without caring about case', () => {
  assert.throws(
    () => fetchPlan(someManifest({chunks: [{path: 'x', size: 67_108_864, sha256: 'a'.repeat(63)}]})),
    /no usable checksum/,
    'short of a SHA-256',
  )
  assert.throws(
    () => fetchPlan(someManifest({chunks: [{path: 'x', size: 67_108_864, sha256: 'z'.repeat(64)}]})),
    /no usable checksum/,
    'not hex at all',
  )

  // The manifest is authored in lowercase; an uppercase one is still the
  // same digest, and the plan normalises it so the comparison later has
  // one spelling to look at.
  const upper = fetchPlan(
    someManifest({
      totalSize: 67_108_864,
      chunks: [{path: 'x', size: 67_108_864, sha256: 'AB'.repeat(32)}],
    }),
  )
  assert.equal(upper[0].sha256, 'ab'.repeat(32))
})

test('verifyChunk answers for the bytes, not for the wish', async () => {
  // sha256("abc"), the digest every implementation agrees on.
  const abc = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
  const bytes = new TextEncoder().encode('abc').buffer

  assert.equal(await verifyChunk(bytes, abc), true)
  assert.equal(await verifyChunk(bytes, abc.toUpperCase()), true, 'case is not a difference')

  assert.equal(await verifyChunk(bytes, '0'.repeat(64)), false)
  const tampered = new TextEncoder().encode('abd').buffer
  assert.equal(await verifyChunk(tampered, abc), false, 'one different byte is a different file')
})

test('the fetch line counts whole megabytes at both ends', () => {
  assert.equal(fetchMessage(0, 253_114_976), 'Fetching model… 0 MB of 253 MB')
  assert.equal(fetchMessage(67_108_864, 253_114_976), 'Fetching model… 67 MB of 253 MB')
  assert.equal(fetchMessage(253_114_976, 253_114_976), 'Fetching model… 253 MB of 253 MB')
})

// The loader's first half - manifest, chunks, sizes, checksums, progress -
// runs here against a stubbed fetch and a synthetic file. It always ends in
// a rejection: the last step is a dynamic import of the vendored wasm, which
// no Node process can resolve, and that failure IS the proof that the
// loader only reached for the engine after every byte checked out. The
// error it stops on is how each case is told apart; the progress log is
// how far it got.

const sha256Hex = (text) => createHash('sha256').update(text).digest('hex')

const withFetch = async (routes, body) => {
  const original = globalThis.fetch
  globalThis.fetch = async (url) => {
    const route = routes[String(url)]
    if (!route) return new Response('', {status: 404})
    return new Response(route.body, {status: route.status ?? 200})
  }
  try {
    return await body()
  } finally {
    globalThis.fetch = original
  }
}

const tinyManifest = (over = {}) => ({
  totalSize: 5,
  chunks: [{path: 'tiny.part1', size: 5, sha256: sha256Hex('hello')}],
  ...over,
})

test('the loader checks every chunk before it ever reaches for the wasm', async () => {
  const manifest = tinyManifest()
  const log = []

  await withFetch(
    {
      '/models/manifest.json': {body: JSON.stringify(manifest)},
      '/models/tiny.part1': {body: 'hello'},
    },
    async () => {
      // The import fails under Node - that is the expected rejection. What
      // is asserted is the road to it.
      await assert.rejects(loadEngine({onProgress: (message) => log.push(message)}))
    },
  )

  assert.deepEqual(log, [
    'Reading the model manifest…',
    'Fetching model… 0 MB of 0 MB',
    'Fetching model… 0 MB of 0 MB',
    'Preparing the model…',
  ])
})

test('a chunk that fails its checksum stops the load where it stands', async () => {
  const manifest = {
    totalSize: 5,
    chunks: [{path: 'tiny.part1', size: 5, sha256: '0'.repeat(64)}],
  }
  const log = []

  await withFetch(
    {
      '/models/manifest.json': {body: JSON.stringify(manifest)},
      '/models/tiny.part1': {body: 'hello'},
    },
    async () => {
      await assert.rejects(loadEngine({onProgress: (message) => log.push(message)}), /failed its checksum/)
    },
  )

  assert.ok(!log.includes('Preparing the model…'), 'the wasm is never touched for bytes that are not the shipped ones')
})

test('a chunk that comes down short stops the load with both numbers', async () => {
  const manifest = tinyManifest()

  await withFetch(
    {
      '/models/manifest.json': {body: JSON.stringify(manifest)},
      '/models/tiny.part1': {body: 'hell'}, // four bytes, not five
    },
    async () => {
      await assert.rejects(loadEngine(), /came down as 4 bytes; the manifest says 5/)
    },
  )
})

test('a manifest that cannot be fetched says so, once', async () => {
  await withFetch({}, async () => {
    await assert.rejects(loadEngine(), /manifest is missing \(404\)/)
  })
  // The attempt is not remembered: the next Run starts from the manifest
  // again instead of carrying the failure.
  await withFetch({}, async () => {
    await assert.rejects(loadEngine(), /manifest is missing \(404\)/)
  })
})

test('a missing chunk names itself instead of failing as a whole', async () => {
  await withFetch({'/models/manifest.json': {body: JSON.stringify(tinyManifest())}}, async () => {
    await assert.rejects(loadEngine(), /tiny\.part1 could not be fetched \(404\)/)
  })
})

test('a download says how far along it is, a megabyte at a time', async () => {
  // Three megabytes in one chunk, handed over in quarter-megabyte reads the
  // way a network hands them over.
  const size = 3_000_000
  const body = new Uint8Array(size).fill(7)
  const manifest = {
    totalSize: size,
    chunks: [{path: 'big.part1', size, sha256: createHash('sha256').update(body).digest('hex')}],
  }
  const original = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('manifest.json')) return new Response(JSON.stringify(manifest))
    return new Response(
      new ReadableStream({
        start(controller) {
          for (let at = 0; at < size; at += 250_000) controller.enqueue(body.subarray(at, at + 250_000))
          controller.close()
        },
      }),
    )
  }
  const log = []
  try {
    await assert.rejects(loadEngine({onProgress: (message) => log.push(message)}))
  } finally {
    globalThis.fetch = original
  }
  assert.deepEqual(log, [
    'Reading the model manifest…',
    'Fetching model… 0 MB of 3 MB',
    'Fetching model… 1 MB of 3 MB',
    'Fetching model… 2 MB of 3 MB',
    'Fetching model… 3 MB of 3 MB',
    'Fetching model… 3 MB of 3 MB',
    'Preparing the model…',
  ])
})

test('a cancelled download rejects as an abort, and the next load starts over', async () => {
  const manifest = tinyManifest()
  const original = globalThis.fetch
  let asked = 0
  // A fetch that honours its signal the way the real one does.
  globalThis.fetch = async (url, {signal} = {}) => {
    asked++
    if (String(url).endsWith('manifest.json')) return new Response(JSON.stringify(manifest))
    return new Promise((resolve, reject) => {
      if (!signal) return resolve(new Response('hello'))
      signal.addEventListener('abort', () => reject(signal.reason))
    })
  }
  try {
    const abort = new AbortController()
    const first = loadEngine({signal: abort.signal})
    await new Promise((resolve) => setTimeout(resolve, 10))
    abort.abort()
    await assert.rejects(first, {name: 'AbortError'})

    // Forgotten, not remembered as a failure: a second load asks again and
    // gets as far as the first one would have.
    const before = asked
    const log = []
    await assert.rejects(loadEngine({onProgress: (message) => log.push(message)}))
    assert.ok(asked > before, 'the manifest and the chunk were asked for again')
    assert.equal(log.at(-1), 'Preparing the model…')
  } finally {
    globalThis.fetch = original
  }
})

test('every model directory ships a manifest whose files all plan, first chunk on disk checked', async () => {
  for (const [id, {dir}] of Object.entries(MODELS)) {
    const root = new URL(`../..${dir}`, import.meta.url)
    const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'))
    const files = manifestFiles(manifest)
    for (const file of files) {
      const [first] = fetchPlan(file)
      const handle = await open(new URL(first.path, root), 'r')
      try {
        const bytes = Buffer.alloc(first.size)
        await handle.read(bytes, 0, first.size, 0)
        assert.equal(createHash('sha256').update(bytes).digest('hex'), first.sha256, `${id}: ${first.path}`)
        // Every file a manifest names is a GGUF: the magic is the first four bytes.
        assert.equal(bytes.subarray(0, 4).toString('latin1'), 'GGUF', `${id}: ${first.path} starts a GGUF`)
      } finally {
        await handle.close()
      }
    }
  }
  assert.equal(manifestFiles({files: {a: 1, b: 2}}).length, 2, 'files come in the order written')
  assert.throws(() => manifestFiles({files: {}}), /lists no files/)
})

test('a model this app does not have is refused before anything is fetched', async () => {
  await withFetch({}, async () => {
    await assert.rejects(loadEngine({model: 'gpt-9'}), /gpt-9 is not a writing model this app has/)
  })
})

test('a multi-file model is fetched from its own directory, every file checked', async () => {
  const log = []
  const manifest = {
    files: {
      'a.gguf': {totalSize: 5, chunks: [{path: 'a.part1', size: 5, sha256: sha256Hex('hello')}]},
      'b.gguf': {totalSize: 5, chunks: [{path: 'b.part1', size: 5, sha256: sha256Hex('world')}]},
    },
  }
  const dir = MODELS['minicpm-v'].dir
  await withFetch(
    {
      [dir + 'manifest.json']: {body: JSON.stringify(manifest)},
      [dir + 'a.part1']: {body: 'hello'},
      [dir + 'b.part1']: {body: 'world'},
    },
    async () => {
      // As for Gemma, the rejection is the wasm import Node cannot resolve.
      await assert.rejects(loadEngine({model: 'minicpm-v', onProgress: (message) => log.push(message)}))
    },
  )
  assert.equal(log.at(-1), 'Preparing the model…', 'both files checked out before the engine was reached for')
})
