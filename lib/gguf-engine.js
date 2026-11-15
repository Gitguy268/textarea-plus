// Speech to text through the reader's own GGUF model: the engine.
//
// The vendored wllama is llama.cpp for the browser, the same one the writing
// tools use for Gemma, here given a speech model and its mmproj projector.
// Audio goes in as a WAV inside a chat message; llama.cpp decodes it, the
// projector turns it into tokens, and the model writes what it heard.
//
// llama.cpp computes an audio's spectrogram on helper threads, and threads
// in WebAssembly need a cross-origin isolated page - the opener and embedder
// policies tests/serve.js, vercel.json and sw.js send. Without them the
// engine says so before loading anything, rather than failing halfway. (The
// vendored wllama.js also keeps four spare threads for exactly this; see
// vendor/README.md.)

import {SAMPLE_RATE, cleanTranscript, encodeWav, windows} from './gguf.js'

// Where the app is served from: '/' locally and on Vercel, '/textarea/' on
// GitHub Pages. Under Node (the unit tests) there is no page, so '/'.
const APP = typeof location === 'undefined' ? '/' : new URL('../', import.meta.url).pathname

/** Room for thirty seconds of audio tokens, the instruction and the answer. */
const CONTEXT = 4096

/** The longest answer one window of audio can produce. */
const MAX_TOKENS = 600

/** The engine while there is one, and the files it was loaded from. */
let current = null

/** A pair of files as one comparable value. */
const identity = (files) => files.map((file) => `${file.name}:${file.size}:${file.lastModified}`).join('|')

/** Whether this page can run WebAssembly threads at all. */
export function canRunThreads() {
  return globalThis.crossOriginIsolated === true && typeof SharedArrayBuffer === 'function'
}

/**
 * The instruction a window is sent with. Speech-only models such as
 * Qwen3-ASR ignore it; chat models with ears (Voxtral, Qwen2.5-Omni) need it.
 *
 * @param {string} language a two-letter code
 */
export function instruction(language) {
  let name = language
  try {
    name = new Intl.DisplayNames(['en'], {type: 'language'}).of(language) ?? language
  } catch {
    // An unknown code: the code itself is the best name there is.
  }
  return `Transcribe the speech in the audio exactly as spoken, in ${name}. Reply with the transcript only.`
}

/**
 * Load the model, or answer the one already loaded from the same files.
 *
 * @param {{files: File[], onProgress?: (message: string) => void, signal?: AbortSignal}} options
 *   `files` is [model, projector], from lib/gguf-store.js
 * @returns {Promise<{transcribe: (samples: Float32Array, options: {language: string,
 *   signal?: AbortSignal}) => Promise<string>}>}
 */
export async function loadGgufEngine({files, onProgress = () => {}, signal} = {}) {
  if (!canRunThreads()) {
    throw new Error('A GGUF speech model needs this page reloaded once, to turn on the threads it decodes audio with. Reload the page, then try again.')
  }
  const key = identity(files)
  if (current?.key === key) return current.engine
  if (current) {
    const old = current
    current = null
    await old.wllama.exit().catch(() => {})
  }
  signal?.throwIfAborted()

  onProgress('Loading your GGUF model…')
  const {Wllama} = await import(`${APP}vendor/wllama/wllama.js`)
  const wllama = new Wllama({default: `${APP}vendor/wllama/wllama.wasm`}, {suppressNativeLog: true})
  wllama.setCompat({worker: `${APP}vendor/wllama/wllama-compat.js`, wasm: `${APP}vendor/wllama/wllama-compat.wasm`})
  try {
    await wllama.loadModel(files, {
      n_ctx: CONTEXT,
      n_threads: Math.max(2, Math.min(8, (navigator.hardwareConcurrency ?? 4) - 1)),
      // Firefox's WebGPU runs llama.cpp slower than its CPU does.
      ...(/Firefox\//.test(navigator.userAgent) && {n_gpu_layers: 0}),
    })
  } catch (error) {
    await wllama.exit().catch(() => {})
    if (/NotReadableError/.test(error?.message ?? error?.name)) {
      throw new Error('The model files could not be read. In a private window, try a normal one; otherwise choose the files again.', {cause: error})
    }
    throw new Error(`Your GGUF model could not be loaded: ${error?.message || error}`, {cause: error})
  }
  if (!wllama.supportInputModality('audio')) {
    await wllama.exit().catch(() => {})
    throw new Error('This model and projector do not take audio. Pick a llama.cpp speech model, such as ggml-org/Qwen3-ASR-0.6B-GGUF.')
  }

  const engine = {
    async transcribe(samples, {language = 'en', signal: stop} = {}) {
      const parts = windows(samples, SAMPLE_RATE)
      const said = []
      for (const [index, part] of parts.entries()) {
        stop?.throwIfAborted()
        if (parts.length > 1) onProgress(`Transcribing… part ${index + 1} of ${parts.length}`)
        let answer
        try {
          answer = await wllama.createChatCompletion({
            messages: [
              {role: 'system', content: instruction(language)},
              {role: 'user', content: [{type: 'audio', data: encodeWav(part, SAMPLE_RATE)}]},
            ],
            max_tokens: MAX_TOKENS,
            temperature: 0,
            abortSignal: stop,
          })
        } catch (error) {
          // wllama's own abort error, said the way the panel listens for it.
          stop?.throwIfAborted()
          throw error
        }
        stop?.throwIfAborted()
        const text = cleanTranscript(answer?.choices?.[0]?.message?.content)
        if (text) said.push(text)
      }
      return said.join(' ')
    },
  }
  current = {key, engine, wllama}
  return engine
}

/** Unload the model, freeing its memory (when the reader forgets the files). */
export async function unloadGgufEngine() {
  const old = current
  current = null
  await old?.wllama.exit().catch(() => {})
}
