// The pure half of speech through the reader's own GGUF model: reading a
// file's header, pairing a model with its projector, the WAV the engine is
// handed, the windows a recording is cut into, and the transcript cleaned.

import assert from 'node:assert/strict'
import {test} from 'node:test'

import {
  WINDOW_SECONDS,
  cleanTranscript,
  describeGguf,
  encodeWav,
  isGguf,
  pairGguf,
  readGgufMetadata,
  windows,
} from '../../lib/gguf.js'

/** A GGUF header with these key/value pairs, written the way llama.cpp writes it. */
function gguf(pairs, {version = 3} = {}) {
  const parts = []
  const u32 = (value) => {
    const bytes = new Uint8Array(4)
    new DataView(bytes.buffer).setUint32(0, value, true)
    parts.push(bytes)
  }
  const u64 = (value) => {
    const bytes = new Uint8Array(8)
    new DataView(bytes.buffer).setBigUint64(0, BigInt(value), true)
    parts.push(bytes)
  }
  const string = (text) => {
    const bytes = new TextEncoder().encode(text)
    u64(bytes.length)
    parts.push(bytes)
  }
  parts.push(new TextEncoder().encode('GGUF'))
  u32(version)
  u64(0) // tensors
  u64(pairs.length)
  for (const [key, value] of pairs) {
    string(key)
    if (typeof value === 'string') {
      u32(8)
      string(value)
    } else if (typeof value === 'boolean') {
      u32(7)
      parts.push(new Uint8Array([value ? 1 : 0]))
    } else if (Array.isArray(value)) {
      u32(9)
      u32(8) // an array of strings, like a vocabulary
      u64(value.length)
      for (const item of value) string(item)
    } else {
      u32(4)
      u32(value)
    }
  }
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

const MODEL = gguf([
  ['general.architecture', 'qwen3vl'],
  ['general.type', 'model'],
  ['tokenizer.ggml.tokens', ['a', 'b', 'c']],
  ['general.name', 'Qwen3 ASR'],
  ['qwen3vl.block_count', 28],
])
const PROJECTOR = gguf([
  ['general.architecture', 'clip'],
  ['general.type', 'mmproj'],
  ['clip.has_audio_encoder', true],
  ['clip.audio.projector_type', 'qwen3a'],
])
const VISION = gguf([
  ['general.architecture', 'clip'],
  ['clip.has_vision_encoder', true],
])

test('a GGUF file is known by its first four bytes', () => {
  assert.equal(isGguf(MODEL), true)
  assert.equal(isGguf(new TextEncoder().encode('RIFF....')), false)
  assert.equal(isGguf(new Uint8Array(2)), false)
  assert.throws(() => readGgufMetadata(new TextEncoder().encode('not a model at all')), /not a GGUF file/)
})

test('the header gives the wanted keys and walks past arrays', () => {
  assert.deepEqual(readGgufMetadata(MODEL), {
    'general.architecture': 'qwen3vl',
    'general.type': 'model',
    'general.name': 'Qwen3 ASR',
  })
  assert.equal(readGgufMetadata(PROJECTOR)['clip.has_audio_encoder'], true)
})

test('a header cut short keeps what was read before the cut', () => {
  const cut = MODEL.slice(0, 75)
  assert.deepEqual(readGgufMetadata(cut), {'general.architecture': 'qwen3vl'})
})

test('version 1 files are refused, as llama.cpp refuses them', () => {
  assert.throws(() => readGgufMetadata(gguf([], {version: 1})), /too old/)
})

test('a projector is told apart from a model, and whether it hears', () => {
  assert.deepEqual(describeGguf(readGgufMetadata(MODEL)), {kind: 'model', audio: false, name: 'Qwen3 ASR'})
  assert.deepEqual(describeGguf(readGgufMetadata(PROJECTOR)), {kind: 'projector', audio: true, name: ''})
  assert.equal(describeGguf(readGgufMetadata(VISION)).audio, false)
})

test('the pair needs one model and one projector that hears', () => {
  const model = {name: 'm.gguf', kind: 'model', audio: false}
  const projector = {name: 'mmproj.gguf', kind: 'projector', audio: true}
  assert.deepEqual(pairGguf([projector, model]), {model, projector})
  assert.match(pairGguf([model]).error, /projector too/)
  assert.match(pairGguf([projector]).error, /language model too/)
  assert.match(pairGguf([model, model, projector]).error, /two files/)
  assert.match(pairGguf([model, {...projector, audio: false}]).error, /reads images, not audio/)
})

test('samples become a 16 kHz mono 16-bit WAV', () => {
  const wav = encodeWav(new Float32Array([0, 1, -1, 2]))
  const view = new DataView(wav.buffer)
  assert.equal(new TextDecoder().decode(wav.slice(0, 4)), 'RIFF')
  assert.equal(new TextDecoder().decode(wav.slice(8, 12)), 'WAVE')
  assert.equal(view.getUint32(24, true), 16000)
  assert.equal(view.getUint16(22, true), 1)
  assert.equal(view.getUint32(40, true), 8)
  assert.deepEqual([0, 1, 2, 3].map((index) => view.getInt16(44 + index * 2, true)), [0, 32767, -32768, 32767])
})

test('a long recording is cut into windows with nothing lost', () => {
  const size = WINDOW_SECONDS * 16000
  const parts = windows(new Float32Array(size * 2 + 5))
  assert.deepEqual(parts.map((part) => part.length), [size, size, 5])
  assert.deepEqual(windows(new Float32Array(0)), [])
})

test('the transcript loses the markers models add', () => {
  assert.equal(cleanTranscript('language English<asr_text>Ask not.'), 'Ask not.')
  assert.equal(cleanTranscript('<think>hm</think>\nTranscript: "Hello there."'), 'Hello there.')
  assert.equal(cleanTranscript('language None<asr_text>'), '')
  assert.equal(cleanTranscript(undefined), '')
})
