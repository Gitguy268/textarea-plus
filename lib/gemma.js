// The on-device engine: a GGUF in ../models/ turned into completions.
//
// Everything heavy happens behind one function. `loadEngine` reads the
// manifest, pulls the transport chunks, checks every one against the hash
// this repository pinned for it, stitches them back into the single file
// they were sliced from, and only then reaches for the vendored llama.cpp
// build - which is dynamic-imported here and nowhere else, so a session
// that never opens the writing tools never downloads a byte of it. The
// answer comes back through the same OpenAI-shaped API the online
// services use, which is what lets lib/writing-tools.js not care which
// one it was handed.
//
// A failed load is not remembered: the promise is dropped, so the next Run
// tries again. A reader on a flaky connection gets to press the button
// again rather than reload the page.

/**
 * The models the writing tools can run, by the ids lib/writing-tools.js
 * offers them under. Each `dir` holds the transport chunks and a
 * manifest.json, same-origin. Gemma's manifest describes its one file; the
 * MiniCPM ones list `files`, the way models/whisper-* do, and the vision
 * model lists its language model first and its image projector second.
 *
 * Both MiniCPMs reason out loud before answering unless their chat template
 * is told not to, which would spend the answer budget on thinking the reader
 * never sees - hence `templateKwargs`.
 */
export const MODELS = {
  gemma: {dir: '/models/'},
  minicpm5: {dir: '/models/minicpm5-2b-2079a22f/', templateKwargs: {enable_thinking: false}},
  'minicpm-v': {dir: '/models/minicpm-v-4.7-1b-9684c734/', templateKwargs: {enable_thinking: false}},
}

/** Context window. The prompt is cut at NOTE_LIMIT characters; this is
 *  what that has to fit inside alongside the answer. */
const CONTEXT = 8192

/** Answer cap: long enough for a rewrite, short enough that the worst
 *  case is a minute of waiting rather than ten. */
const MAX_TOKENS = 1024

/** One temperature for every tool: low enough that "Improve wording"
 *  keeps the author's sentences, high enough that "Make more casual"
 *  does not come out identical twice. */
const TEMPERATURE = 0.5

/** The engine once it is up, with the id of the model it runs; null until
 *  the first successful load. One at a time: a second model loaded beside
 *  the first would hold both in memory. */
let engine = null
/** The in-flight load and its model id, so a second Run joins it instead of
 *  starting a second copy of the same download. */
let loading = null

/**
 * Validate the manifest and return the chunks to fetch, in order.
 *
 * Every failure here is a programming or corruption error wearing a
 * reader-facing message: a manifest that does not add up, a hash that is
 * not one, a path that tries to leave the directory. The path rule is the
 * one worth stating out loud - chunk names come from a file the service
 * worker did not write, and only plain filenames pass.
 *
 * @param {{totalSize: number, chunks: Array<{path: string, size: number,
 *   sha256: string}>}} manifest
 * @returns {Array<{path: string, size: number, sha256: string}>}
 * @throws {Error} when anything does not add up
 */
export function fetchPlan(manifest) {
  const chunks = manifest?.chunks
  if (!Array.isArray(chunks) || chunks.length === 0) {
    throw new Error('the model manifest lists no chunks')
  }

  const plan = chunks.map((chunk, index) => {
    const where = `chunk ${index + 1}`
    if (typeof chunk?.path !== 'string' || !/^[\w.-]+$/.test(chunk.path)) {
      throw new Error(`${where} in the model manifest is not a plain filename`)
    }
    if (!Number.isInteger(chunk.size) || chunk.size <= 0) {
      throw new Error(`${where} in the model manifest has no usable size`)
    }
    if (typeof chunk.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(chunk.sha256)) {
      throw new Error(`${where} in the model manifest has no usable checksum`)
    }
    return {path: chunk.path, size: chunk.size, sha256: chunk.sha256.toLowerCase()}
  })

  const total = plan.reduce((sum, chunk) => sum + chunk.size, 0)
  if (total !== manifest.totalSize) {
    throw new Error(`the model manifest adds up to ${total}, not ${manifest.totalSize}`)
  }

  return plan
}

/**
 * The files a manifest describes, each in the shape fetchPlan reads: one for
 * a manifest that is itself a file (Gemma's), or every entry of `files`, in
 * the order written.
 *
 * @param {object} manifest
 * @returns {Array<{totalSize: number, chunks: Array<object>}>}
 */
export function manifestFiles(manifest) {
  if (!manifest?.files) return [manifest]
  const files = Object.values(manifest.files)
  if (!files.length) throw new Error('the model manifest lists no files')
  return files
}

/**
 * Whether these bytes are the bytes the manifest promised.
 *
 * @param {ArrayBuffer | ArrayBufferView} bytes
 * @param {string} expectedHex the SHA-256 to compare against
 * @returns {Promise<boolean>}
 */
export async function verifyChunk(bytes, expectedHex) {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const actual = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
  return actual === String(expectedHex).toLowerCase()
}

/**
 * The status line during a fetch: whole megabytes, both ends visible,
 * because "Fetching model…" with nothing under it is where readers
 * assume a hang.
 *
 * @param {number} done bytes fetched so far
 * @param {number} total bytes the manifest says there are
 * @returns {string}
 */
export function fetchMessage(done, total) {
  const megabytes = (bytes) => Math.round(bytes / 1_000_000)
  return `Fetching model… ${megabytes(done)} MB of ${megabytes(total)} MB`
}

/**
 * Build the engine for a model, or answer the one that already runs it.
 * Asking for a different model shuts the running engine down first.
 *
 * @param {{model?: string, onProgress?: (message: string) => void,
 *   signal?: AbortSignal}} [options] `model` is a key of MODELS
 * @returns {Promise<{run: (messages: Array<{role: string, content: string |
 *   Array<object>}>) => Promise<string>}>}
 */
export function loadEngine({model = 'gemma', onProgress = () => {}, signal} = {}) {
  const spec = MODELS[model]
  if (!spec) return Promise.reject(new Error(`${model} is not a writing model this app has`))
  if (engine?.id === model) return Promise.resolve(engine)
  if (loading?.id !== model) {
    const previous = engine
    engine = null
    const promise = Promise.resolve(previous?.exit())
      .catch(() => {}) // an engine that will not shut down cleanly is still gone
      .then(() => startLoad(spec, onProgress, signal))
      .then(
        (ready) => {
          engine = {id: model, ...ready}
          loading = null
          return engine
        },
        (error) => {
          // Forget the attempt: a fetch that died halfway is worth retrying
          // with the same button that reported it.
          loading = null
          throw error
        },
      )
    loading = {id: model, promise}
  }
  return loading.promise
}

/**
 * A response's bytes, read as they arrive so the caller can say how far
 * along a 64 MB chunk is rather than only that it has started. A response
 * with no stream to read (an older browser, a test double) is read whole.
 */
async function readBytes(response, onBytes) {
  if (!response.body) return response.arrayBuffer()
  const reader = response.body.getReader()
  const pieces = []
  let got = 0
  for (;;) {
    const {done, value} = await reader.read()
    if (done) break
    pieces.push(value)
    got += value.byteLength
    onBytes(got)
  }
  return new Blob(pieces).arrayBuffer()
}

const startLoad = async (spec, onProgress, signal) => {
  onProgress('Reading the model manifest…')
  // The signal is the panel's Cancel button: aborting it rejects whichever
  // fetch or read is in flight with an AbortError, and loadEngine() forgets
  // the attempt, so the next Run starts again - from the browser's cache
  // for every chunk that had already finished.
  const response = await fetch(spec.dir + 'manifest.json', {signal})
  if (!response.ok) throw new Error(`the model manifest is missing (${response.status})`)
  const manifest = await response.json()
  const files = manifestFiles(manifest)
  // Every file is planned before any is fetched: a manifest that does not
  // add up costs nothing to refuse.
  const plans = files.map((file) => fetchPlan(file))
  const total = files.reduce((sum, file) => sum + file.totalSize, 0)

  const blobs = []
  let done = 0
  for (const plan of plans) {
    const parts = []
    for (const part of plan) {
      onProgress(fetchMessage(done, total))
      const chunk = await fetch(spec.dir + part.path, {signal})
      if (!chunk.ok) throw new Error(`${part.path} could not be fetched (${chunk.status})`)
      // One message per megabyte, not per network read: the status line is a
      // live region, and a few thousand updates a second is noise in any voice.
      let said = fetchMessage(done, total)
      const bytes = await readBytes(chunk, (got) => {
        const message = fetchMessage(done + got, total)
        if (message === said) return
        said = message
        onProgress(message)
      })
      if (bytes.byteLength !== part.size) {
        throw new Error(`${part.path} came down as ${bytes.byteLength} bytes; the manifest says ${part.size}`)
      }
      if (!(await verifyChunk(bytes, part.sha256))) {
        throw new Error(`${part.path} failed its checksum - not the file this repository ships`)
      }
      parts.push(bytes)
      done += bytes.byteLength
      onProgress(fetchMessage(done, total))
    }
    blobs.push(new Blob(parts))
  }

  onProgress('Preparing the model…')
  const {Wllama} = await import('/vendor/wllama/wllama.js')
  const wllama = new Wllama({
    // The wasm lives here, not on a CDN: loadModel must find it at this
    // origin with no network beyond this server.
    default: '/vendor/wllama/wllama.wasm',
    suppressNativeLog: true,
  })
  // Upstream's constructor points its compatibility build at jsDelivr for
  // browsers without JSPI or memory64. Both files are vendored, so the
  // fallback stays on this origin too and an old Safari or Firefox loads
  // offline like everything else. The default mode leaves Firefox on the
  // main build, which is upstream's own choice for it.
  wllama.setCompat({
    worker: '/vendor/wllama/wllama-compat.js',
    wasm: '/vendor/wllama/wllama-compat.wasm',
  })

  // No n_gpu_layers: wllama puts every layer on WebGPU when the browser has
  // it and stays on the CPU when it does not.
  try {
    await wllama.loadModel(blobs, {
      n_ctx: CONTEXT,
      n_threads: Math.max(1, (navigator.hardwareConcurrency ?? 4) - 1),
      default_template_kwargs: spec.templateKwargs,
      // Firefox's WebGPU runs llama.cpp ten times slower than its CPU does
      // (MiniCPM5 2B: 0.45 against 4.7 tokens a second, Firefox 158).
      ...(/Firefox\//.test(navigator.userAgent) && {n_gpu_layers: 0}),
    })
  } catch (error) {
    // A private window keeps every Blob in memory, and Chrome there gives up on
    // reading back a file the size of the larger models.
    if (/NotReadableError/.test(error?.message)) {
      throw new Error('this window could not hold the model - in a private window, try a normal one', {cause: error})
    }
    throw error
  }

  return {
    run: async (messages) => {
      const answer = await wllama.createChatCompletion({
        messages,
        max_tokens: MAX_TOKENS,
        temperature: TEMPERATURE,
      })
      const content = answer?.choices?.[0]?.message?.content
      if (typeof content !== 'string' || !content.trim()) {
        throw new Error('the model finished without writing anything')
      }
      return content
    },
    exit: () => wllama.exit(),
  }
}
