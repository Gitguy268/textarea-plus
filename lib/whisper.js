// Speech to text on this device: the Whisper in ../models/ turned into words.
//
// The twin of lib/gemma.js, one thread over. The engine itself - the vendored
// transformers.js, its wasm and 249 MB of weights - lives in
// lib/whisper-worker.js, and this file is the page's side of that
// conversation: start the worker on first use, pass its progress along, and
// hand back something with a `transcribe`. Nothing here is fetched until the
// speech panel is asked to transcribe, and nothing leaves the machine when it
// is.
//
// The recipe is xenova/whisper-web's - transformers.js in a worker, audio
// brought down to 16 kHz mono before it crosses over - without its interface
// or its downloads from Hugging Face.
//
// Cancelling is blunt on purpose: the worker is terminated and forgotten.
// There is no polite way to interrupt wasm in the middle of a matrix, and
// every chunk that had finished downloading is already in the service
// worker's cache for the next attempt.

/** What Whisper was trained on, and so what it is given. */
export const SAMPLE_RATE = 16_000

/**
 * How each model in the speech panel's list is run, by its id there.
 *
 * `dir` is under /models/ and carries the revision, because the service
 * worker's model cache is cache-first and has no version of its own.
 * `runtime` is the ONNX Runtime build: the plain CPU one for small, the
 * WebGPU-capable asyncify one for turbo. One worker holds one runtime, which
 * is why changing model means a new worker.
 */
export const MODELS = {
  small: {dir: 'whisper-small-2d67713f', device: 'wasm', dtype: 'q8', runtime: 'ort-wasm-simd-threaded'},
  turbo: {
    dir: 'whisper-large-v3-turbo-efd60f61',
    device: 'webgpu',
    dtype: {encoder_model: 'fp16', decoder_model_merged: 'q4'},
    runtime: 'ort-wasm-simd-threaded.asyncify',
  },
}

/** The worker while there is one. */
let worker = null
/** The model id that worker was started for. */
let running = null
/** The load, in flight or finished, so a second caller joins the first. */
let ready = null

const forget = () => {
  worker?.terminate()
  worker = null
  running = null
  ready = null
}

/**
 * One question to the worker and its answer.
 *
 * Progress messages are passed along and do not settle anything; the first
 * other message does. An abort ends the worker, not just the wait.
 */
const ask = (message, {onProgress = () => {}, signal, transfer = []} = {}) =>
  new Promise((resolve, reject) => {
    const cancel = () => {
      forget()
      reject(new DOMException('Cancelled', 'AbortError'))
    }
    if (signal?.aborted) {
      cancel()
      return
    }
    signal?.addEventListener('abort', cancel, {once: true})
    const settle = (finish) => {
      signal?.removeEventListener('abort', cancel)
      finish()
    }
    worker.onmessage = ({data}) => {
      if (data.type === 'progress') onProgress(data.message)
      else if (data.type === 'error') settle(() => reject(new Error(data.message)))
      else settle(() => resolve(data))
    }
    // A worker that fails to start at all - its own file missing or not a
    // module - reports here rather than through a message of its own, and
    // often with no message: the file it was is the one clue.
    worker.onerror = (event) => {
      const where = event.filename ? ` (${new URL(event.filename, location.href).pathname})` : ''
      settle(() => {
        forget()
        reject(new Error((event.message || 'the speech engine could not start') + where + ' - reload the page and try again'))
      })
    }
    worker.postMessage(message, transfer)
  })

const engine = {
  /**
   * @param {Float32Array} samples mono, at SAMPLE_RATE; handed over, not copied
   * @param {{language: string, signal?: AbortSignal}} options
   *   `language` is one of Whisper's two-letter codes
   * @returns {Promise<string>}
   */
  transcribe: async (samples, {language, signal} = {}) =>
    (await ask({type: 'transcribe', samples, language}, {signal, transfer: [samples.buffer]})).text,
}

/**
 * Build the engine, or answer the one that already exists.
 *
 * A failed load is not remembered, the same bargain lib/gemma.js makes: the
 * button that reported it is the button that tries again. Asking for a
 * different model than the one running ends the running one first.
 *
 * @param {{model?: string, onProgress?: (message: string) => void, signal?: AbortSignal}} [options]
 *   `model` is a key of MODELS
 * @returns {Promise<{transcribe: (samples: Float32Array, options: {language: string,
 *   signal?: AbortSignal}) => Promise<string>}>}
 */
export function loadEngine({model = 'small', onProgress, signal} = {}) {
  if (!MODELS[model]) return Promise.reject(new Error(`${model} is not a speech model this app has`))
  if (ready && running !== model) forget()
  if (!ready) {
    worker = new Worker('/lib/whisper-worker.js', {type: 'module'})
    running = model
    const attempt = ask({type: 'load', model: MODELS[model]}, {onProgress, signal}).then(
      () => engine,
      (error) => {
        // Only if nothing newer has replaced this attempt in the meantime.
        if (ready === attempt) forget()
        throw error
      },
    )
    ready = attempt
  }
  return ready
}

/**
 * Average the channels into one. Always a new array, even for one channel:
 * the result is transferred to the worker, and the decoder's own buffer is
 * not this module's to give away.
 *
 * @param {Float32Array[]} channels equally long
 * @returns {Float32Array}
 */
export function mixToMono(channels) {
  const mono = new Float32Array(channels[0]?.length ?? 0)
  for (const channel of channels) {
    for (let index = 0; index < mono.length; index++) mono[index] += channel[index] / channels.length
  }
  return mono
}

/**
 * A recording or an audio file as the samples Whisper wants.
 *
 * The browser does the decoding and the resampling: an AudioContext created
 * at 16 kHz hands back every format it can play at that rate. It is never
 * resumed and plays nothing.
 *
 * @param {Blob} blob
 * @returns {Promise<Float32Array>}
 * @throws {Error} when the browser cannot decode it
 */
export async function decodeAudio(blob) {
  const context = new AudioContext({sampleRate: SAMPLE_RATE})
  try {
    const audio = await context.decodeAudioData(await blob.arrayBuffer())
    return mixToMono(Array.from({length: audio.numberOfChannels}, (_, index) => audio.getChannelData(index)))
  } catch {
    throw new Error('this is not audio the browser can decode')
  } finally {
    void context.close()
  }
}
