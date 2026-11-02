// The speech engine's own thread: Whisper, off the page that is being typed in.
//
// A transcription is minutes of arithmetic for a long recording, and on the
// main thread every one of those minutes is an editor that does not answer.
// So the vendored transformers.js and its wasm are imported here and nowhere
// else, and lib/whisper.js talks to this file in four message types.
//
// Which Whisper, and on which runtime, arrives with the `load` message - one
// entry of MODELS in lib/whisper.js - and holds for the worker's life: ONNX
// Runtime is set up once per thread, so another model is another worker.
//
// The weights arrive the way Gemma's do: transport chunks, each checked
// against the hash this repository pinned for it, stitched back into the file
// they were sliced from. transformers.js does its own fetching, so each file
// is stitched when it asks for it, through the one door it offers -
// `env.fetch` - and every other request it makes (the JSON beside the
// weights) goes to this origin untouched. Only on request, and kept no
// longer than it takes to hand over: turbo's encoder alone is 1.27 GB, and
// holding every file until the load ends would be paying for it twice.
//
// The library is imported inside the handler, not at the top: a module that
// fails to import at the top kills the worker with no message at all, and
// "could not start" is all the reader would ever see. Imported here, the
// reason comes back as an error like any other.

/** The pipeline once it is up. */
let transcriber = null

const progress = (message) => self.postMessage({type: 'progress', message})

/**
 * @param {{dir: string, device: string, dtype: string | object, runtime: string}} model
 */
async function load(model) {
  const [{env, pipeline}, {fetchMessage, fetchPlan, verifyChunk}] = await Promise.all([
    import('/vendor/transformers/transformers.min.js'),
    import('./gemma.js'),
  ])
  const root = `/models/${model.dir}/`

  // Upstream's defaults reach for huggingface.co and jsDelivr; all of them
  // are turned around to point at this origin before anything is asked for.
  env.allowRemoteModels = false
  env.allowLocalModels = true
  env.localModelPath = '/models/'
  // The service worker already keeps /models/ and /vendor/: a second copy of
  // the weights in a cache of the library's own would be paid for and never read.
  env.useBrowserCache = false
  env.useWasmCache = false
  // Both names spelled out: given only a directory, the library picks a
  // build by itself, and reaches for jsDelivr when it is not there.
  env.backends.onnx.wasm.wasmPaths = {
    mjs: `/vendor/transformers/${model.runtime}.mjs`,
    wasm: `/vendor/transformers/${model.runtime}.wasm`,
  }

  progress('Reading the model manifest…')
  const response = await fetch(root + 'manifest.json')
  if (!response.ok) throw new Error(`the speech model manifest is missing (${response.status})`)
  const manifest = await response.json()

  /** Each weights file by the pathname the library will ask for it under. */
  const files = new Map(
    Object.entries(manifest?.files ?? {}).map(([name, entry]) => {
      // The same rule fetchPlan holds chunk names to, one level up: a name
      // from the manifest goes into a URL, so it may not climb out of it.
      if (!/^[\w.-]+(\/[\w.-]+)*$/.test(name) || name.includes('..')) {
        throw new Error(`${name} in the speech model manifest is not a plain path`)
      }
      return [root + name, {directory: root + name.slice(0, name.lastIndexOf('/') + 1), plan: fetchPlan(entry)}]
    }),
  )
  if (!files.size) throw new Error('the speech model manifest lists no files')

  const total = [...files.values()].reduce((sum, file) => sum + file.plan.reduce((size, part) => size + part.size, 0), 0)
  let done = 0

  const stitch = async ({directory, plan}) => {
    // One array the size of the file, filled chunk by chunk - not a Blob of
    // the chunks: WebKit refuses to read a Blob back when its parts are this
    // large ("Blob loading failed"), and Safari is a browser this runs in.
    const whole = new Uint8Array(plan.reduce((size, part) => size + part.size, 0))
    let offset = 0
    for (const part of plan) {
      progress(fetchMessage(done, total))
      const chunk = await fetch(directory + part.path)
      if (!chunk.ok) throw new Error(`${part.path} could not be fetched (${chunk.status})`)
      const bytes = await chunk.arrayBuffer()
      if (bytes.byteLength !== part.size) {
        throw new Error(`${part.path} came down as ${bytes.byteLength} bytes; the manifest says ${part.size}`)
      }
      if (!(await verifyChunk(bytes, part.sha256))) {
        throw new Error(`${part.path} failed its checksum - not the file this repository ships`)
      }
      whole.set(new Uint8Array(bytes), offset)
      offset += bytes.byteLength
      done += bytes.byteLength
    }
    progress(done === total ? 'Preparing the speech model…' : fetchMessage(done, total))
    return whole
  }

  env.fetch = async (input, init) => {
    const file = files.get(new URL(input?.url ?? input, self.location.href).pathname)
    if (!file) return fetch(input, init)
    const bytes = await stitch(file)
    return new Response(bytes, {headers: {'content-length': String(bytes.byteLength)}})
  }

  transcriber = await pipeline('automatic-speech-recognition', model.dir, {dtype: model.dtype, device: model.device})
}

self.addEventListener('message', async ({data}) => {
  try {
    if (data.type === 'load') {
      await load(data.model)
      self.postMessage({type: 'ready'})
    } else if (data.type === 'transcribe') {
      // whisper-web's window: thirty seconds at a time, five of overlap, so a
      // word that straddles a boundary is heard whole by one side of it. The
      // language is always named: left out, the library assumes English
      // rather than listening for it.
      const output = await transcriber(data.samples, {
        chunk_length_s: 30,
        stride_length_s: 5,
        language: data.language,
        task: 'transcribe',
      })
      self.postMessage({type: 'result', text: output.text})
    }
  } catch (error) {
    self.postMessage({type: 'error', message: error?.message || String(error)})
  }
})
