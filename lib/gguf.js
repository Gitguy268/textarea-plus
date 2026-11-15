// Speech to text through a GGUF model the reader brings: the pure parts.
//
// llama.cpp runs speech models as two files - the language model and its
// multimodal projector ("mmproj"), which turns audio into tokens the model
// can read. The vendored wllama is llama.cpp compiled for the browser, so a
// reader who picks the two files gets the same engine llama-server would
// give them, on this device. ggml-org/Qwen3-ASR-0.6B-GGUF is the small one
// this was built and tested against.
//
// This file holds what can be decided without a browser: which of the two a
// file is (from its GGUF header), the WAV the engine is handed, the windows a
// long recording is cut into, and the transcript with the model's own
// markers taken off. lib/gguf-engine.js runs the model and
// lib/gguf-store.js remembers the files.

/** "GGUF" in the first four bytes, read little-endian. */
const MAGIC = 0x46554747

/** How much of a file's head is read to find its metadata. */
export const HEADER_BYTES = 4 * 1024 * 1024

/** What the engine is given: 16 kHz mono, the rate every speech encoder wants. */
export const SAMPLE_RATE = 16_000

/** Seconds of audio per request: well inside every audio projector's window. */
export const WINDOW_SECONDS = 30

/** Whether these bytes start like a GGUF file. */
export function isGguf(bytes) {
  const view = toView(bytes)
  return view.byteLength >= 8 && view.getUint32(0, true) === MAGIC
}

function toView(bytes) {
  if (bytes instanceof DataView) return bytes
  if (bytes instanceof ArrayBuffer) return new DataView(bytes)
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

/** The metadata keys worth reading; everything else is skipped over. */
const WANTED = new Set([
  'general.architecture',
  'general.type',
  'general.name',
  'general.size_label',
  'clip.has_audio_encoder',
  'clip.has_vision_encoder',
  'clip.audio.projector_type',
  'clip.projector_type',
])

/**
 * The metadata of a GGUF file, as far as its first bytes hold it.
 *
 * Only scalar and string values are kept, and only the keys above: a model's
 * vocabulary sits in the same table as an array of a hundred thousand
 * strings, and is walked past rather than read. A header cut off by the end
 * of the bytes given ends the walk with what was found.
 *
 * @param {ArrayBuffer | Uint8Array} bytes the start of the file
 * @returns {Record<string, string | number | boolean>}
 * @throws {Error} when the bytes are not a GGUF file
 */
export function readGgufMetadata(bytes) {
  const view = toView(bytes)
  if (!isGguf(view)) throw new Error("this is not a GGUF file (whisper.cpp's ggml-….bin models are a different format)")
  const version = view.getUint32(4, true)
  if (version < 2) throw new Error(`GGUF version ${version} is too old for llama.cpp`)
  const found = {}
  let at = 8 + 8 // magic and version, then the tensor count
  const decoder = new TextDecoder()

  const need = (count) => {
    if (at + count > view.byteLength) throw new RangeError('end of header')
  }
  const u32 = () => (need(4), (at += 4), view.getUint32(at - 4, true))
  const u64 = () => {
    need(8)
    const value = view.getBigUint64(at, true)
    at += 8
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('length out of range')
    return Number(value)
  }
  const string = () => {
    const length = u64()
    need(length)
    const text = decoder.decode(new Uint8Array(view.buffer, view.byteOffset + at, length))
    at += length
    return text
  }
  const SIZES = {0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8}
  const scalar = (type) => {
    const size = SIZES[type]
    if (size === undefined) throw new Error(`unknown GGUF value type ${type}`)
    need(size)
    const offset = at
    at += size
    switch (type) {
      case 0: return view.getUint8(offset)
      case 1: return view.getInt8(offset)
      case 2: return view.getUint16(offset, true)
      case 3: return view.getInt16(offset, true)
      case 4: return view.getUint32(offset, true)
      case 5: return view.getInt32(offset, true)
      case 6: return view.getFloat32(offset, true)
      case 7: return view.getUint8(offset) !== 0
      case 10: return Number(view.getBigUint64(offset, true))
      case 11: return Number(view.getBigInt64(offset, true))
      default: return view.getFloat64(offset, true)
    }
  }
  const skipArray = () => {
    const type = u32()
    const count = u64()
    if (type === 8) for (let index = 0; index < count; index++) string()
    else if (type === 9) throw new Error('nested GGUF arrays are not read')
    else {
      const size = SIZES[type]
      if (size === undefined) throw new Error(`unknown GGUF value type ${type}`)
      need(size * count)
      at += size * count
    }
  }

  try {
    const pairs = u64()
    for (let index = 0; index < pairs; index++) {
      const key = string()
      const type = u32()
      if (type === 9) skipArray()
      else if (type === 8) {
        const value = string()
        if (WANTED.has(key)) found[key] = value
      } else {
        const value = scalar(type)
        if (WANTED.has(key)) found[key] = value
      }
    }
  } catch (error) {
    if (!(error instanceof RangeError)) throw error
  }
  return found
}

/**
 * What a GGUF file is to speech to text.
 *
 * `projector` is an mmproj (llama.cpp writes them as architecture `clip`),
 * and `audio` says whether it can hear; `model` is the language model it
 * feeds. llama.cpp needs exactly one of each.
 *
 * @param {Record<string, unknown>} metadata from readGgufMetadata
 * @returns {{kind: 'model' | 'projector', audio: boolean, name: string}}
 */
export function describeGguf(metadata) {
  const projector = metadata['general.architecture'] === 'clip' || metadata['general.type'] === 'mmproj'
  const name = String(metadata['general.name'] ?? '')
  if (!projector) return {kind: 'model', audio: false, name}
  return {kind: 'projector', audio: metadata['clip.has_audio_encoder'] === true, name}
}

/**
 * Sort picked files into the pair llama.cpp needs, or say what is missing.
 *
 * @param {{name: string, kind: 'model' | 'projector', audio: boolean}[]} files
 * @returns {{model: object, projector: object} | {error: string}}
 */
export function pairGguf(files) {
  const models = files.filter((file) => file.kind === 'model')
  const projectors = files.filter((file) => file.kind === 'projector')
  if (models.length !== 1 || projectors.length !== 1) {
    if (!models.length && projectors.length) {
      return {error: 'Pick the language model too: the .gguf file beside the mmproj one.'}
    }
    if (models.length && !projectors.length) {
      return {
        error:
          'Pick the projector too: llama.cpp hears audio through the mmproj-….gguf file that comes with the model. ' +
          '(A single-file GGUF made for transcribe.cpp will not run here.)',
      }
    }
    return {error: 'Pick two files: one model and one mmproj projector.'}
  }
  if (!projectors[0].audio) {
    return {error: `${projectors[0].name || 'That projector'} reads images, not audio. Pick a speech model's mmproj.`}
  }
  return {model: models[0], projector: projectors[0]}
}

/**
 * Samples as a 16-bit PCM WAV file: the format llama.cpp's audio decoder
 * reads on every build, and the smallest lossless one it takes.
 *
 * @param {Float32Array} samples mono, -1…1
 * @param {number} [rate]
 * @returns {Uint8Array}
 */
export function encodeWav(samples, rate = SAMPLE_RATE) {
  const bytes = new Uint8Array(44 + samples.length * 2)
  const view = new DataView(bytes.buffer)
  const text = (offset, value) => {
    for (let index = 0; index < value.length; index++) bytes[offset + index] = value.charCodeAt(index)
  }
  text(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  view.setUint32(16, 16, true) // the size of this chunk
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true) // bytes a second
  view.setUint16(32, 2, true) // bytes a frame
  view.setUint16(34, 16, true) // bits a sample
  text(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  for (let index = 0; index < samples.length; index++) {
    const sample = Math.max(-1, Math.min(1, samples[index] || 0))
    view.setInt16(44 + index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
  }
  return bytes
}

/**
 * A recording cut into windows of WINDOW_SECONDS, the last one shorter.
 *
 * No overlap: a window boundary can split a word, but an overlap makes the
 * model write the same words twice, which is worse to read and harder to
 * undo than one word cut in half.
 *
 * @param {Float32Array} samples
 * @param {number} [rate]
 * @returns {Float32Array[]}
 */
export function windows(samples, rate = SAMPLE_RATE) {
  const size = WINDOW_SECONDS * rate
  const out = []
  for (let start = 0; start < samples.length; start += size) out.push(samples.subarray(start, start + size))
  return out
}

/**
 * The words from a model's answer, without the markers some models add.
 *
 * Qwen3-ASR starts with `language English<asr_text>`; reasoning models wrap
 * a preamble in <think>; others quote the transcript or add "Transcript:".
 *
 * @param {string} text
 * @returns {string}
 */
export function cleanTranscript(text) {
  return String(text ?? '')
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/(^|\s)language\s+[^\s<]*\s*<asr_text>/gi, '$1')
    .replace(/<\/?asr_text>/gi, '')
    .replace(/^\s*(transcript(ion)?|text)\s*:\s*/i, '')
    .replace(/^\s*["“](.*)["”]\s*$/s, '$1')
    .replace(/[ \t]+/g, ' ')
    .trim()
}

/** A byte count as the panel shows it. */
export function formatSize(bytes) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`
  return `${Math.max(1, Math.round(bytes / 1e6))} MB`
}
