// The end-to-end check the gate refuses to be: press Run in the real writing
// tools and wait for the real committed model to answer.
//
// `npm run check:model` - Gemma. `MODEL=minicpm5` or `MODEL=minicpm-v` checks
// one of the others (the vision one also describes an image), and `WEBGPU=1`
// gives headless Chromium a real GPU adapter on a Mac, so the run is the
// WebGPU one a reader's browser does.
//
// Not part of test:all on purpose. It moves 241 MB of chunks through the
// service worker, starts a wasm engine and runs inference - tens of seconds
// to minutes, where a gate is expected to stay under a minute. What the
// committed suite proves instead is everything up to this script's first
// line: the prompt the panel builds, the loader's checks over a stubbed
// fetch, the service worker's cache, and the wiring. This script is the one
// place where all of it runs at once, against the bytes in models/.
//
// It exits non-zero - and says why - if the answer does not arrive, if any
// model file had to come down twice, if a fetch escaped this origin, or if
// the page threw.

import {mkdtemp, readFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {chromium} from 'playwright'

import {manifestFiles, MODELS} from '../lib/gemma.js'
import {listen} from './serve.js'

const MODEL = process.env.MODEL ?? 'gemma'
if (!MODELS[MODEL]) throw new Error(`MODEL=${MODEL} is not one of ${Object.keys(MODELS).join(', ')}`)
const DIR = MODELS[MODEL].dir

/** Generous: a cold start pays a download, a wasm compile and a warm-up. */
const RUN_TIMEOUT_MS = Number(process.env.MODEL_CHECK_TIMEOUT ?? 300_000)

const {origin, close} = await listen(0)
// A throwaway profile rather than chromium.launch(): that one behaves like a
// private window, where Chrome keeps every Blob in memory and refuses to read
// back a 1.5 GB model - which is not what a reader's own profile does.
const profile = await mkdtemp(join(tmpdir(), 'textarea-model-check-'))
const browser = await chromium.launchPersistentContext(profile, {
  args: process.env.WEBGPU ? ['--enable-unsafe-webgpu', '--use-angle=metal'] : [],
})

let failed = false
const complain = (message) => {
  failed = true
  console.error(`  ✗ ${message}`)
}

try {
  const page = await browser.newPage()
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(String(error)))

  await page.goto(origin + '/')

  // A note worth rewriting: short enough that the prompt is quick to eval,
  // long enough that "Improve wording" has a sentence to work on.
  await page.evaluate(async () => {
    globalThis.textarea.editor.replace(
      'we talked about the plan for a while and then everybody agreed. it should start next week.',
    )
    await globalThis.textarea.save()
  })

  // The panel the way a reader opens it: menu row, not a test hook.
  await page.locator('#button').click()
  await page.locator('#menu').waitFor({state: 'visible'})
  await page.locator('#menu-writing').click()
  const panel = page.locator('#writing-panel')
  await panel.waitFor({state: 'visible'})
  await panel.locator('.writing-model select').selectOption(MODEL)
  console.log(`Model: ${MODEL}; WebGPU adapter: ${await page.evaluate(async () => Boolean(await navigator.gpu?.requestAdapter()))}`)

  const probe = () =>
    panel.evaluate((root) => ({
      status: root.querySelector('.writing-status').textContent.trim(),
      error: root.querySelector('.writing-status').classList.contains('error'),
      output: root.querySelector('.writing-output').textContent.trim(),
      runEnabled: !root.querySelector('.writing-run').disabled,
    }))

  /** Watch the status line until the run settles: it is the only progress shown. */
  const untilSettled = async (label) => {
    let last = ''
    let sawBusy = false
    const deadline = Date.now() + RUN_TIMEOUT_MS
    for (;;) {
      const state = await probe()
      if (state.status && state.status !== last) {
        last = state.status
        console.log(`  ${label}: ${last}`)
      }
      if (state.status) sawBusy = true
      if (state.error) throw new Error(`${label} reported an error: ${state.status}`)
      if (sawBusy && state.status === '' && state.runEnabled && state.output) return state
      if (Date.now() > deadline) {
        throw new Error(`${label} timed out after ${RUN_TIMEOUT_MS}ms; last status: ${last}`)
      }
      await page.waitForTimeout(250)
    }
  }

  console.log('First run - download, verify, compile, warm up, write:')
  const cold = Date.now()
  await panel.locator('.writing-run').click()
  await untilSettled('cold run')
  console.log(`  first answer after ${((Date.now() - cold) / 1000).toFixed(1)}s`)

  const firstAnswer = await probe()
  console.log(`  answer: ${firstAnswer.output.replace(/\s+/g, ' ')}`)

  console.log('Second run - the engine is up; this one is inference only:')
  const warm = Date.now()
  await panel.locator('.writing-run').click()
  await untilSettled('warm run')
  console.log(`  second answer after ${((Date.now() - warm) / 1000).toFixed(1)}s`)

  // What the two runs together have to have looked like from outside.
  const timing = await page.evaluate(() =>
    performance.getEntriesByType('resource').map((entry) => entry.name),
  )
  if (MODEL === 'minicpm-v') {
    console.log('Image run - Describe image on a drawn picture:')
    const png = await page.evaluate(() => {
      const canvas = document.createElement('canvas')
      canvas.width = 320
      canvas.height = 200
      const g = canvas.getContext('2d')
      g.fillStyle = '#fff'
      g.fillRect(0, 0, 320, 200)
      g.fillStyle = '#d00'
      g.beginPath()
      g.arc(90, 100, 60, 0, 7)
      g.fill()
      g.fillStyle = '#000'
      g.font = 'bold 40px sans-serif'
      g.fillText('CAT 42', 160, 115)
      return canvas.toDataURL('image/png').split(',')[1]
    })
    await panel.locator('.writing-tool[data-tool="describe"]').click()
    await panel.locator('.writing-image input[type="file"]').setInputFiles({
      name: 'drawing.png',
      mimeType: 'image/png',
      buffer: Buffer.from(png, 'base64'),
    })
    await page.waitForFunction(() => !document.querySelector('.writing-preview').hidden)
    const seen = Date.now()
    await panel.locator('.writing-run').click()
    const described = await untilSettled('image run')
    console.log(`  answer after ${((Date.now() - seen) / 1000).toFixed(1)}s: ${described.output.replace(/\s+/g, ' ')}`)
    if (!/42/.test(described.output)) complain('the description does not mention the "42" drawn in the image')
  }

  const manifest = JSON.parse(await readFile(new URL(`..${DIR}manifest.json`, import.meta.url), 'utf8'))
  const partNames = manifestFiles(manifest).flatMap((file) => file.chunks.map((chunk) => DIR + chunk.path))
  for (const part of partNames) {
    const count = timing.filter((name) => name.endsWith(part)).length
    if (count !== 1) complain(`${part} was fetched ${count} times, expected exactly once`)
  }
  if (!timing.some((name) => name.endsWith('/vendor/wllama/wllama.js'))) {
    complain('the vendored engine was never fetched')
  }
  // The wasm is fetched inside wllama's worker, where the page's resource
  // timing cannot see it - so what is asked instead is the cache the service
  // worker would have filled had it seen the request, which for a request for
  // an origin path it does. If neither shows it, print what was seen.
  const wasmSaw = timing.filter((name) => name.includes('wllama') || name.endsWith('.wasm'))
  const vendorCached = await page.evaluate(async () => {
    const names = await caches.keys()
    const name = names.find((entry) => entry.startsWith('textarea-vendor'))
    if (!name) return []
    const cache = await caches.open(name)
    return (await cache.keys()).map((request) => new URL(request.url).pathname)
  })
  const wasmFetched = wasmSaw.some((name) => name.endsWith('/vendor/wllama/wllama.wasm'))
  const wasmCached = vendorCached.includes('/vendor/wllama/wllama.wasm')
  if (!wasmFetched && !wasmCached) {
    complain(
      `the vendored wasm cannot be accounted for; timing: ${wasmSaw.join(', ') || '(none)'}; ` +
        `vendor cache: ${vendorCached.join(', ') || '(none)'}`,
    )
  }
  if (vendorCached.some((name) => name.includes('jsdelivr'))) {
    complain(`the compat files came from a CDN after all: ${vendorCached.join(', ')}`)
  }
  const escaped = timing.filter(
    (name) => name.includes('jsdelivr') || (name.startsWith('http') && !name.startsWith(origin)),
  )
  if (escaped.length) complain(`fetches left this origin: ${escaped.join(', ')}`)

  const cached = await page.evaluate(async () => {
    const cache = await caches.open('textarea-models')
    return (await cache.keys()).map((request) => new URL(request.url).pathname)
  })
  for (const path of [DIR + 'manifest.json', ...partNames]) {
    if (!cached.includes(path)) complain(`${path} is not in the model cache`)
  }

  if (pageErrors.length) complain(`the page threw: ${pageErrors.join(' | ')}`)

  if (failed) {
    process.exitCode = 1
    console.error('\nThe model check failed.')
  } else {
    console.log('\nOK - the committed model answered twice, from this origin, from cache.')
  }
} catch (error) {
  process.exitCode = 1
  console.error(`\nThe model check failed: ${error.message}`)
} finally {
  await browser.close()
  await close()
  await rm(profile, {recursive: true, force: true})
}
