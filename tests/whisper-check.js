// The end-to-end check the gate refuses to be: hand the real speech panel a
// real recording and wait for the real committed Whisper to write it down.
//
// `npm run check:whisper`, or `WHISPER_MODEL=turbo npm run check:whisper`
// for large v3 turbo on WebGPU (1.65 GB; Chromium is given a real GPU for it).
//
// Not part of test:all, for the reason tests/model-check.js is not: it moves
// 249 MB of chunks through the service worker, starts a wasm runtime and
// transcribes three times over - a minute or more, where a gate is expected
// to stay under one. The committed suite proves the panel against a fake
// engine and the chunks against their hashes; this script is the one place
// where all of it runs at once, against the bytes in models/.
//
// Three passes over tests/fixtures/jfk.wav, eleven seconds of a 1961
// inaugural address: through the file button, through Record with Chromium's
// fake microphone playing the same file, and through the file button again
// with the network cut. It exits non-zero - and says why - if the words do
// not come back, if a fetch left this origin or missed, if anything but the
// vendored runtime was asked for, or if the page threw.

import {mkdtemp, readFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'

import {chromium} from 'playwright'

import {MODELS} from '../lib/whisper.js'
import {listen} from './serve.js'

/** Generous: a cold start pays a download, a wasm compile and a warm-up. */
const RUN_TIMEOUT_MS = Number(process.env.WHISPER_CHECK_TIMEOUT ?? 300_000)

const FIXTURE = fileURLToPath(new URL('./fixtures/jfk.wav', import.meta.url))
/** What the clip says, give or take Whisper's punctuation. */
const EXPECTED = /ask not what your country can do for you/i

const MODEL = process.env.WHISPER_MODEL ?? 'small'
const {dir, runtime: RUNTIME_BUILD} = MODELS[MODEL] ?? {}
if (!dir) throw new Error(`WHISPER_MODEL=${MODEL} is not one of ${Object.keys(MODELS).join(', ')}`)
const MODEL_ROOT = `/models/${dir}/`
// Every chunk the manifest lists, read off the manifest itself.
const PARTS = Object.entries(
  JSON.parse(await readFile(fileURLToPath(new URL(`../models/${dir}/manifest.json`, import.meta.url)), 'utf8')).files,
).flatMap(([name, entry]) =>
  entry.chunks.map((chunk) => MODEL_ROOT + name.slice(0, name.lastIndexOf('/') + 1) + chunk.path),
)
const RUNTIME = ['transformers.min.js', `${RUNTIME_BUILD}.mjs`, `${RUNTIME_BUILD}.wasm`].map(
  (name) => '/vendor/transformers/' + name,
)

const {origin, close} = await listen(0)
const args = {
  args: [
    // A microphone that needs no hands: the permission prompt answers itself,
    // and the device plays the fixture once instead of a test tone.
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${FIXTURE}%noloop`,
    // A real adapter in headless Chromium on a Mac, for turbo's fp16 encoder.
    ...(MODEL === 'turbo' ? ['--enable-unsafe-webgpu', '--use-angle=metal'] : []),
  ],
}
// Turbo needs a profile on disk: a throwaway context's storage quota is far
// short of the 1.65 GB the service worker has to keep for the offline pass.
const profile = MODEL === 'turbo' ? await mkdtemp(join(tmpdir(), 'whisper-check-')) : null
const browser = profile ? null : await chromium.launch(args)

let failed = false
const complain = (message) => {
  failed = true
  console.error(`  ✗ ${message}`)
}

const context = profile ? await chromium.launchPersistentContext(profile, args) : await browser.newContext()

try {
  const page = context.pages()[0] ?? (await context.newPage())
  const pageErrors = []
  const requested = []
  page.on('pageerror', (error) => pageErrors.push(String(error)))
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(message.text())
  })
  page.on('request', (request) => requested.push(request.url()))
  page.on('response', (response) => {
    if (response.status() >= 400) complain(`${response.url()} answered ${response.status()}`)
  })

  await page.goto(origin + '/')
  // Everything below is meant to pass through the service worker: its caches
  // are half of what is being checked.
  await page.waitForFunction(() => navigator.serviceWorker?.controller)

  const panel = page.locator('#speech-panel')

  /** The panel the way a reader opens it: menu row, not a test hook. */
  const openPanel = async () => {
    await page.locator('#button').click()
    await page.locator('#menu').waitFor({state: 'visible'})
    await page.locator('#menu-speech').click()
    await panel.waitFor({state: 'visible'})
    await panel.getByLabel('Spoken language').selectOption('en')
    // Turbo is only offered where the panel's own GPU check passes.
    if (MODEL === 'turbo' && !(await page.evaluate(async () => (await import('/lib/speech-panel.js')).hasWebGPU()))) {
      throw new Error('this Chromium has no WebGPU adapter with shader-f16, so turbo cannot be checked here')
    }
    await panel.getByLabel('Model').selectOption(MODEL)
  }

  const probe = () =>
    panel.evaluate((root) => ({
      status: root.querySelector('.writing-status').textContent.trim(),
      error: root.querySelector('.writing-status').classList.contains('error'),
      output: root.querySelector('.writing-result').hidden
        ? ''
        : root.querySelector('.writing-output').textContent.trim(),
    }))

  /** Watch the status line until a transcript is on show: it is the only progress there is. */
  const untilTranscribed = async (label) => {
    const started = Date.now()
    let last = ''
    for (;;) {
      const state = await probe()
      if (state.status && state.status !== last) {
        last = state.status
        console.log(`  ${label}: ${last}`)
      }
      if (state.error) throw new Error(`${label} reported an error: ${state.status}`)
      if (state.output) {
        console.log(`  ${label}: “${state.output}” after ${((Date.now() - started) / 1000).toFixed(1)}s`)
        if (!EXPECTED.test(state.output)) complain(`${label} did not hear the clip: ${state.output}`)
        return state.output
      }
      if (Date.now() - started > RUN_TIMEOUT_MS) {
        throw new Error(`${label} timed out after ${RUN_TIMEOUT_MS}ms; last status: ${last}`)
      }
      await page.waitForTimeout(250)
    }
  }

  await openPanel()

  console.log('A file, cold - download, verify, compile, transcribe:')
  await panel.locator('.speech-input').setInputFiles(FIXTURE)
  const heard = await untilTranscribed('file')

  // The transcript goes where the reader's words go: into the note.
  await panel.locator('.writing-replace').click()
  const note = await page.evaluate(() => document.querySelector('article').textContent)
  if (!note.includes(heard)) complain(`Insert did not put the transcript in the note: ${note}`)

  console.log('The microphone - the engine is up; record, stop, transcribe:')
  await panel.locator('.speech-record').click()
  await page.waitForFunction(() =>
    document.querySelector('#speech-panel .writing-status').textContent.startsWith('Recording'),
  )
  // The clip is eleven seconds long and the fake device plays it in real time.
  await page.waitForTimeout(12_000)
  await panel.locator('.speech-record').click()
  await untilTranscribed('microphone')

  // What the two runs together have to have looked like from outside.
  const paths = requested.filter((url) => url.startsWith(origin)).map((url) => new URL(url).pathname)
  const escaped = requested.filter((url) => /^https?:/.test(url) && !url.startsWith(origin))
  if (escaped.length) complain(`fetches left this origin: ${escaped.join(', ')}`)
  for (const part of PARTS) {
    const count = paths.filter((path) => path === part).length
    if (count !== 1) complain(`${part} was fetched ${count} times, expected exactly once`)
  }
  // The stitched files exist only in the worker's memory. A request for one
  // by name means the library went around the door it was given.
  const unsplit = paths.filter((path) => path.endsWith('.onnx'))
  if (unsplit.length) complain(`an unsplit model file was asked for: ${unsplit.join(', ')}`)
  const runtime = [...new Set(paths.filter((path) => path.startsWith('/vendor/transformers/')))].sort()
  if (runtime.join() !== [...RUNTIME].sort().join()) {
    complain(`the runtime fetched was not the vendored three: ${runtime.join(', ') || '(none)'}`)
  }

  const cacheNames = await page.evaluate(() => caches.keys())
  const foreign = cacheNames.filter((name) => !name.startsWith('textarea-'))
  if (foreign.length) complain(`the library kept a cache of its own: ${foreign.join(', ')}`)
  const cached = await page.evaluate(async () => {
    const cache = await caches.open('textarea-models')
    return (await cache.keys()).map((request) => new URL(request.url).pathname)
  })
  for (const path of [MODEL_ROOT + 'manifest.json', ...PARTS]) {
    if (!cached.includes(path)) complain(`${path} is not in the model cache`)
  }

  console.log('Offline - a fresh page, the network cut, everything from cache:')
  await context.setOffline(true)
  await page.reload()
  await openPanel()
  await panel.locator('.speech-input').setInputFiles(FIXTURE)
  await untilTranscribed('offline')

  if (pageErrors.length) complain(`the page threw: ${pageErrors.join(' | ')}`)

  if (failed) {
    process.exitCode = 1
    console.error('\nThe speech check failed.')
  } else {
    console.log('\nOK - the committed Whisper heard a file, a microphone and a file offline, from this origin.')
  }
} catch (error) {
  process.exitCode = 1
  console.error(`\nThe speech check failed: ${error.message}`)
} finally {
  await (browser ?? context).close()
  if (profile) await rm(profile, {recursive: true, force: true})
  await close()
}
