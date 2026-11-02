// The speech model as it sits in the repository, and the two small pieces of
// arithmetic around it.
//
// The engine cannot run here - that would put 249 MB of weights and a wasm
// runtime inside every gate; `npm run check:whisper` is where it does. What
// is checked instead is what the engine is a stranger to: that the chunks on
// disk are the ones the manifest pins and stitch back into the files Hugging
// Face published, that the manifest passes the loader's own rules, that the
// panel's language list is this model's, and that two channels become one.

import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {createReadStream} from 'node:fs'
import {access, readFile} from 'node:fs/promises'
import {test} from 'node:test'

import {fetchPlan} from '../../lib/gemma.js'
import {LANGUAGES, MODELS as OFFERED, defaultLanguage, hasWebGPU} from '../../lib/speech-panel.js'
import {MODELS, mixToMono} from '../../lib/whisper.js'

const models = new URL('../../models/', import.meta.url)
const root = new URL(`${MODELS.small.dir}/`, models)

/** The two ONNX files each model's dtype makes the library ask for. */
const EXPECTED_FILES = {
  small: ['onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx'],
  turbo: ['onnx/encoder_model_fp16.onnx', 'onnx/decoder_model_merged_q4.onnx'],
}

test('the panel offers exactly the models the engine knows how to run', () => {
  assert.deepEqual(
    OFFERED.map(({id}) => id),
    Object.keys(MODELS),
  )
  assert.deepEqual(Object.keys(EXPECTED_FILES), Object.keys(MODELS))
})

for (const [id, {dir}] of Object.entries(MODELS)) {
  test(`the ${id} speech chunks on disk are the ones the manifest pins, and stitch into the published files`, async () => {
    const root = new URL(`${dir}/`, models)
    const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'))
    const files = Object.entries(manifest.files)
    assert.deepEqual(
      files.map(([name]) => name),
      EXPECTED_FILES[id],
    )

    for (const [name, entry] of files) {
      // The loader's own gate: sizes that add up, hashes that are hashes,
      // chunk names that cannot climb out of their directory.
      const plan = fetchPlan(entry)
      const whole = createHash('sha256')
      for (const part of plan) {
        const single = createHash('sha256')
        let size = 0
        for await (const bytes of createReadStream(new URL(part.path, new URL(name, root)))) {
          whole.update(bytes)
          single.update(bytes)
          size += bytes.length
        }
        assert.equal(size, part.size, `${part.path} is the size the manifest says`)
        assert.equal(single.digest('hex'), part.sha256, `${part.path} is the chunk the manifest pins`)
      }
      assert.equal(whole.digest('hex'), entry.sha256, `${name} stitches back into the published file`)
    }
  })
}

test('the files the library asks for beside the weights are all here', async () => {
  // The five requests a load makes besides the chunks, read off the network
  // log of a real one. A missing file is a 404 in a worker, a long way from
  // whoever deleted it.
  for (const {dir} of Object.values(MODELS)) {
    for (const name of [
      'config.json',
      'generation_config.json',
      'preprocessor_config.json',
      'tokenizer.json',
      'tokenizer_config.json',
    ]) {
      await access(new URL(`${dir}/${name}`, models))
    }
  }
})

test('turbo is offered only where a GPU can do half precision', async () => {
  const gpu = (features) => ({requestAdapter: async () => (features ? {features: new Set(features)} : null)})
  assert.equal(await hasWebGPU(gpu(['shader-f16'])), true)
  assert.equal(await hasWebGPU(gpu([])), false, 'an adapter without fp16')
  assert.equal(await hasWebGPU(gpu(null)), false, 'no adapter at all')
  assert.equal(await hasWebGPU(undefined), false, 'no WebGPU at all')
  assert.equal(
    await hasWebGPU({
      requestAdapter: async () => {
        throw new Error('blocked')
      },
    }),
    false,
  )
})

test('the panel offers exactly the languages this model was trained to name', async () => {
  const config = JSON.parse(await readFile(new URL('generation_config.json', root), 'utf8'))
  const known = Object.keys(config.lang_to_id).map((token) => token.slice(2, -2))
  assert.deepEqual([...LANGUAGES].sort(), known.sort())
})

test('a reader who never chose is offered the browser’s language, or English', () => {
  assert.equal(defaultLanguage('nl-NL'), 'nl')
  assert.equal(defaultLanguage('NL'), 'nl')
  assert.equal(defaultLanguage('en-GB'), 'en')
  assert.equal(defaultLanguage('zh-Hant-TW'), 'zh')
  assert.equal(defaultLanguage('tlh'), 'en', 'a language Whisper does not know')
  assert.equal(defaultLanguage(''), 'en')
  assert.equal(defaultLanguage(undefined), 'en')
})

test('channels are averaged into one, in an array of its own', () => {
  const left = Float32Array.of(1, 0, -1)
  const right = Float32Array.of(0, 0, 1)
  assert.deepEqual([...mixToMono([left, right])], [0.5, 0, 0])

  // One channel is copied rather than passed through: the result is
  // transferred to a worker, which empties whatever array it was.
  const mono = mixToMono([left])
  assert.deepEqual([...mono], [1, 0, -1])
  assert.notEqual(mono, left)
  assert.equal(mixToMono([]).length, 0)
})
