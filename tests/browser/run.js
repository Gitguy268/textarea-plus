// Browser tests: drive the real app in Chromium over a real HTTP origin.
//
// These cover what the unit tests cannot: that the modules load, that a PDF goes
// through pdf.js, that the AES-256 archive is really encrypted, and that the
// download handlers produce the right bytes.

import assert from 'node:assert/strict'
import {promises as fs} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {chromium, firefox, webkit} from 'playwright'

import {listen} from '../serve.js'
import {makeLayoutPdf, makePdf} from '../fixtures/make-pdf.js'
import {decodeHash} from '../../lib/share.js'
import {MAX_SYNC_FILE_BYTES} from '../../lib/folder-sync.js'

const DOWNLOADS = join(tmpdir(), 'textarea-browser-tests')

let server
let browser
let context
let page
let consoleErrors = []

/**
 * The hash an empty note occupies, captured by reset().
 *
 * The note is autosaved into the URL half a second after it changes, so a test
 * that has just opened a file has to wait for the URL to move on before it can
 * say anything about the hash.
 */
let emptyHash = ''

/**
 * The engine under test: Chromium unless BROWSER says firefox or webkit.
 * Chromium is the gate; the other two are run to find what only they break.
 */
const ENGINE_NAME = ['firefox', 'webkit'].includes(process.env.BROWSER) ? process.env.BROWSER : 'chromium'
const ENGINE = {chromium, firefox, webkit}[ENGINE_NAME]

/**
 * A test of something only Chromium has - folder sync, the file pickers, the
 * clipboard permission the harness grants, the SVG backdrop filter. Under
 * Chromium it is an ordinary test; under the other engines it is skipped by
 * name rather than left to fail, so a red run there means something real.
 */
const chromiumOnly = ENGINE_NAME === 'chromium' ? test : test.skip

/**
 * A test whose harness, not its subject, stops at WebKit: Playwright's
 * WebKit does not hand a cross-origin fetch to page.route(), so a test that
 * answers GitHub from a stub cannot be run there.
 */
const notWebkit = ENGINE_NAME === 'webkit' ? test.skip : test

/**
 * Two tabs talking over WebRTC. On a Mac with the application firewall on,
 * the peer-to-peer UDP of Playwright's unsigned browsers between two tabs is
 * dropped (checks go out, none arrive), so there it is skipped. Elsewhere it
 * runs in every engine; it has not yet been run in CI.
 */
const peerToPeer = process.platform === 'darwin' ? test.skip : test

test.before(async () => {
  await fs.mkdir(DOWNLOADS, {recursive: true})
  server = await listen(0)
  browser = await ENGINE.launch()
  context = await browser.newContext({acceptDownloads: true})

  // The real File System Access API opens a native dialog that no automation can
  // dismiss, so it is removed here and covered separately with a stub. What is
  // left is the object-URL download every other browser takes.
  await context.addInitScript(() => {
    Reflect.deleteProperty(window, 'showSaveFilePicker')
  })

  // Every page this context opens is the app under test - the two-tab,
  // themed and download tests open more of them - so the gate at the end
  // listens to all of them, not just the first. pageerror is the half a
  // console listener alone would miss: an uncaught throw and a rejection
  // nobody caught both land here, the second as "Uncaught (in promise)".
  const watch = (target) => {
    target.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
    target.on('pageerror', (error) => consoleErrors.push(String(error)))
  }
  context.on('page', watch)

  page = await context.newPage()

  // Record every message the bubble shows, so a test can read one that has
  // already gone off screen.
  //
  // Polling the bubble from here does not work: it is on screen for two seconds,
  // and an action that takes longer than that finishes with the message already
  // expired. A MutationObserver in the page sees the mutation either way, which
  // is the difference between a test that is occasionally wrong for no visible
  // reason and one that is either right or failing.
  await page.addInitScript(() => {
    globalThis.__messages = []
    const install = () => {
      const bubble = document.querySelector('#notification')
      if (!bubble) return false
      new MutationObserver(() => {
        const entry = {
          sequence: bubble.dataset.sequence ?? '',
          text: bubble.textContent,
          isError: bubble.classList.contains('error'),
          busy: bubble.classList.contains('busy'),
        }
        const log = globalThis.__messages
        // Progress and results both bump the sequence; reset() rewrites the
        // content without bumping it, and that is not a new message.
        if (log.length && log[log.length - 1].sequence === entry.sequence) return
        log.push(entry)
      }).observe(bubble, {
        attributes: true,
        childList: true,
        characterData: true,
        subtree: true,
        attributeFilter: ['class', 'data-sequence'],
      })
      return true
    }
    // An init script runs before the document is parsed, so the bubble is usually
    // not there yet.
    if (!install()) addEventListener('DOMContentLoaded', install)
  })

  await page.goto(server.origin + '/')
  await page.waitForFunction(() => Boolean(globalThis.textarea))
})

test.after(async () => {
  await context?.close()
  await browser?.close()
  await server?.close()
})

/**
 * Run an action, then wait for the notification it produces and return it.
 *
 * The bubble doubles as a progress indicator while a file is being read, so this
 * waits for a *finished* message: the newest one the page recorded, and no
 * longer busy. Waiting on the recorded log rather than on the bubble's current
 * state is what makes a slow action safe, and the same reason the log exists.
 */
async function notification(run) {
  const from = await page.evaluate(() => globalThis.__messages.length)
  if (run) await run()

  try {
    await page.waitForFunction(
      (seen) => {
        const log = globalThis.__messages
        if (!log || log.length <= seen) return false
        const last = log[log.length - 1]
        return Boolean(last.sequence) && !last.busy
      },
      from,
      // Polled on a timer rather than on animation frames. Frames stop when the
      // page is backgrounded, and another test can leave one in front, which is
      // how this went wrong: the notification arrived, expired before the next
      // frame, and the wait sat on a correct message it could no longer see.
      {timeout: 150_000, polling: 50},
    )
  } catch {
    throw new Error(
      'no notification arrived; the page said: ' +
        JSON.stringify(
          await page.evaluate(() => ({
            sequence: document.querySelector('#notification').dataset.sequence ?? null,
            classes: document.querySelector('#notification').className,
            text: document.querySelector('#notification').textContent,
          })),
        ),
    )
  }

  return page.evaluate(() => {
    const last = globalThis.__messages[globalThis.__messages.length - 1]
    return {text: last.text, isError: last.isError}
  })
}

async function setNote(text) {
  await page.evaluate((value) => {
    globalThis.textarea.editor.replace(value)
  }, text)
}

/**
 * The editor's save, run now instead of after its 500ms debounce.
 *
 * Tests that need the save to have happened - the hash rewritten, the library
 * row updated, the folder mirror told - wait for the outcome rather than for
 * the debounce's delay, and this is how they ask for it.
 */
async function saveNow() {
  await page.evaluate(() => globalThis.textarea.save())
}

async function noteText() {
  return page.evaluate(() => globalThis.textarea.article.textContent)
}

async function openMenu() {
  await page.locator('#button').click()
  await page.locator('#menu').waitFor({state: 'visible'})
}

/** Fill a dialog field by its label. Matches the repeat-password field by its aria-label. */
async function fillDialog(label, value) {
  const input = page.getByLabel(label, {exact: true}).last()
  await input.fill(value)
  return input
}

/** Start from a clean editor with no dialog and no bubble left over. */
async function reset() {
  // An encrypted note stops the autosave rewriting the URL, so the next test
  // would start encrypted without asking. Reloading at the root is the honest
  // way back: it is the same thing a reader does when they open the app fresh.
  // The menu question rides along with this evaluate rather than costing a
  // round trip of its own on every one of the 67 resets; a reload answers it
  // anyway, because the menu comes back closed.
  const {encrypted, menuWasOpen} = await page.evaluate(() => {
    // Remove rather than close: a dialog left in the document breaks the next
    // test's strict-mode locator.
    document.querySelectorAll('dialog.dialog').forEach((dialog) => dialog.remove())
    const bubble = document.querySelector('#notification')
    bubble.classList.remove('visible', 'busy', 'error')
    bubble.textContent = ''
    // notify() raises this to assertive for errors and puts it back on the next
    // plain message, so an empty reset has to restore the shipped default or the
    // next test inherits the last one's politeness.
    bubble.setAttribute('aria-live', 'polite')
    return {
      encrypted: Boolean(globalThis.textarea?.state.encrypted),
      // An open menu survives into the next test and swallows its first click.
      menuWasOpen: document.querySelector('#menu').classList.contains('visible'),
    }
  })
  if (encrypted) await freshEditor()
  await page.locator('#notification').waitFor({state: 'hidden'})
  if (menuWasOpen && !encrypted) {
    await page.keyboard.press('Escape')
    await page.locator('#menu').waitFor({state: 'hidden'})
  }

  // The document library outlives the page, by design, so it has to be emptied
  // here or every test would see the rows the previous ones wrote. Folder sync
  // goes first for the same reason in reverse: an active mirror would follow
  // the deletions with deletions of its own, and the next folder test would
  // inherit a manifest pointing at files this one never made.
  //
  // The empty note is written in the same round trip - it is the floor every
  // later test builds on, and save() run directly is the debounce's own save
  // without the 500ms, which would otherwise be paid by every test in the
  // file. save() writes the hash before it resolves, so what comes back is
  // already the final value: there is nothing left to poll for.
  emptyHash = await page.evaluate(async () => {
    await globalThis.textarea.folderSync.disconnect()
    const library = await import('/lib/library.js')
    const entries = await library.listDocuments()
    await Promise.all(entries.map((entry) => library.deleteDocument(entry.id)))
    // The trash outlives the page like the library does, and a note left in it
    // would turn up in the next test's panel.
    await library.emptyTrash()
    localStorage.removeItem('textarea:stats')
    globalThis.textarea.statsPanel.close()
    globalThis.textarea.editor.replace('')
    await globalThis.textarea.save()
    return location.hash
  })
  assert.ok(emptyHash.length > 1, 'the empty note has a hash of its own')
}

/**
 * Wait for a predicate evaluated in the page, which may be async.
 *
 * `page.waitForFunction` is not this: it treats a returned promise as a truthy
 * value rather than awaiting it, so a predicate that reads IndexedDB resolves on
 * the first poll and the next line finds nothing there. This polls on a timer,
 * the same reason notification() does: frames stop when the page is backgrounded.
 *
 * @param {() => any} predicate
 * @param {{timeout?: number, what?: string}} [options]
 */
async function until(predicate, {timeout = 30_000, what = 'a condition'} = {}) {
  const deadline = Date.now() + timeout
  for (;;) {
    if (await page.evaluate(predicate)) return
    if (Date.now() > deadline) throw new Error(`timed out after ${timeout}ms waiting for ${what}`)
    await page.waitForTimeout(40)
  }
}

test.beforeEach(reset)

/**
 * Wait past the editor's history debounce.
 *
 * A keyup schedules the history record 300ms later, so an undo pressed sooner
 * finds a stack that does not contain the edit that was just typed. A fixed
 * wait is honest here: the delay lives in app.js as debounceRecordHistory, and
 * this only has to be later than that.
 */
async function settleHistory() {
  await page.waitForTimeout(400)
}

/**
 * Reload the editor so its undo stack starts empty.
 *
 * The history lives in the page, and replace() pushes onto it, so by the time a
 * later test presses undo the stack holds records from earlier tests too. Tests
 * that reach for undo need to start from a known stack.
 */
async function freshEditor() {
  await page.goto(server.origin + '/')
  await page.waitForFunction(() => Boolean(globalThis.textarea))
}

/** Put the caret at a character offset measured across the whole document. */
async function placeCaret(offset) {
  await page.evaluate((want) => {
    const article = document.querySelector('article')
    const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT)
    let seen = 0
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const length = node.nodeValue.length
      if (seen + length >= want) {
        const range = document.createRange()
        range.setStart(node, want - seen)
        range.collapse(true)
        article.focus()
        const selection = getSelection()
        selection.removeAllRanges()
        selection.addRange(range)
        return
      }
      seen += length
    }
  }, offset)
}

/** Where the caret is now, as a character offset across the whole document. */
async function caretOffset() {
  return page.evaluate(() => {
    const article = document.querySelector('article')
    const {anchorNode, anchorOffset} = getSelection()
    if (!anchorNode) return null
    const range = document.createRange()
    range.setStart(article, 0)
    range.setEnd(anchorNode, anchorOffset)
    return range.toString().length
  })
}

/** Count empty text nodes, which the old selection code used to inject. */
async function emptyTextNodes() {
  return page.evaluate(() => {
    const walker = document.createTreeWalker(document.querySelector('article'), NodeFilter.SHOW_TEXT)
    let count = 0
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.nodeValue === '') count++
    }
    return count
  })
}

/**
 * Poll the caret until it reads the given offset, the way until() polls the
 * page. The caret follows the DOM mutation that re-rendered the note, so a
 * fixed wait for it is a guess about how long that takes; this waits for the
 * value itself.
 *
 * @param {number} offset
 * @param {string} what
 * @returns {Promise<number>} the offset it settled on
 */
async function untilCaret(offset, what = 'the caret to settle') {
  const deadline = Date.now() + 30_000
  for (;;) {
    const actual = await caretOffset()
    if (actual === offset) return actual
    if (Date.now() > deadline) {
      throw new Error(`timed out after 30000ms waiting for ${what}`)
    }
    await page.waitForTimeout(40)
  }
}

test('the editor boots and shares a note through the URL', async () => {
  await setNote('# Hello\n\nThis is a note.')
  await until(() => location.hash.length > 10, {what: 'the hash to be written'})

  const hash = await page.evaluate(() => location.hash)
  assert.ok(hash.length > 10, 'a hash should have been written')
  assert.match(hash, /^#[A-Za-z0-9_-]+$/, 'a plain hash stays base64url')
  assert.equal(await page.title(), 'Hello')

  // A fresh load must restore the same text.
  const second = await context.newPage()
  await second.goto(server.origin + '/' + hash)
  await second.waitForFunction(
    () => document.querySelector('article')?.textContent === '# Hello\n\nThis is a note.',
    undefined,
    {polling: 100, timeout: 10_000},
  )
  assert.equal(await second.locator('article').textContent(), '# Hello\n\nThis is a note.')
  await second.close()
})

test('a plaintext link is not mistaken for an encrypted one', async () => {
  // The link comes from this test's own note rather than whatever a previous
  // one left in the address bar: the point is that a hash the editor wrote for
  // plaintext still decodes as plaintext.
  await setNote('# Hello\n\nThis is a note.')
  await saveNow()
  const hash = await page.evaluate(() => location.hash)
  assert.ok(!hash.slice(1).startsWith('!'))
  // Decoded in Node with the very codec the page uses.
  assert.ok((await decodeHash(hash.slice(1))).startsWith('# Hello'))
})

test('the caret survives the editor rebuilding its own DOM', async () => {
  // Upstream issue #27. Typing schedules a highlight pass that throws the DOM
  // away and rebuilds it, and the selection has to survive that.
  await setNote('alpha beta gamma')
  await placeCaret(10)
  assert.equal(await caretOffset(), 10, 'the caret started where it was put')

  await page.keyboard.type('X')
  await page.waitForFunction(
    () => document.querySelector('article').textContent === 'alpha betaX gamma',
  )

  assert.equal(
    await untilCaret(11, 'the caret to follow the character it typed'),
    11,
    'the caret followed the character it typed',
  )
  assert.equal(await emptyTextNodes(), 0, 'measuring the selection left no nodes behind')

  // The keystroke armed the record debounce, and it has a "recording" flag up
  // until it fires. Leaving it pending would let it land inside the next test,
  // recording that test's content instead of this one's.
  await settleHistory()
})

test('the caret stays between formatted runs', async () => {
  // Markdown rendering splits the note into runs, so a caret can sit on the
  // boundary between two child elements rather than inside a text node. The old
  // code had a special case for that, which put the caret at the end of the
  // document: every keystroke after a highlight pass landed at the bottom.
  await setNote('before **bold** after')
  // Three children: the leading text, the bold span, the trailing text.
  await page.waitForFunction(
    () => document.querySelector('article').childNodes.length === 3,
  )

  await page.evaluate(() => {
    const article = document.querySelector('article')
    const range = document.createRange()
    range.setStart(article, 1)
    range.collapse(true)
    article.focus()
    const selection = getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
  })
  assert.equal(await caretOffset(), 7, 'the caret starts on the boundary')

  await page.keyboard.type('X')
  await page.waitForFunction(
    () => document.querySelector('article').textContent === 'before X**bold** after',
  )

  assert.equal(
    await untilCaret(8, 'the caret to stay on the boundary'),
    8,
    'the caret stayed between the runs',
  )
  assert.equal(await emptyTextNodes(), 0, 'no nodes were injected at the boundary')

  // The record that keydown took is the one undo comes back to, and it was
  // taken while the caret sat on the boundary. This is where the old code put
  // it at the end of the document instead.
  await settleHistory()
  // Keydown alone: the undo runs on keydown, and the keyup that would arm
  // the debounced highlight has not happened, so what the page shows here is
  // the undo's own doing - it re-runs the highlighter over the restored text
  // rather than leaving raw markdown for a later pass to notice.
  await page.keyboard.down('Control')
  await page.keyboard.down('z')
  const undone = await page.evaluate(() => ({
    text: document.querySelector('article').textContent,
    bold: Boolean(document.querySelector('article .md-bold')),
  }))
  await page.keyboard.up('z')
  await page.keyboard.up('Control')

  assert.equal(undone.text, 'before **bold** after', 'the undo restored the note')
  assert.ok(undone.bold, 'undo re-rendered the runs over the text itself')
  assert.equal(await caretOffset(), 7, 'undo put the caret back on the boundary')
})

test('undo puts a selected run back under the cursor', async () => {
  // The recorded position has to carry a real selection, not just a caret, and
  // it has to survive the document being rebuilt in between. Undo puts the
  // text back and re-highlights, then restores the position - the sharpest
  // test of both.
  await freshEditor()
  await setNote('alpha beta gamma')
  await page.evaluate(() => {
    const article = document.querySelector('article')
    const node = document.createTreeWalker(article, NodeFilter.SHOW_TEXT).nextNode()
    const range = document.createRange()
    range.setStart(node, 6)
    range.setEnd(node, 10)
    article.focus()
    const selection = getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
  })

  await page.keyboard.type('X')
  await page.waitForFunction(() => document.querySelector('article').textContent === 'alpha X gamma')
  await settleHistory()

  await page.keyboard.press('Control+z')
  await page.waitForFunction(
    () => document.querySelector('article').textContent === 'alpha beta gamma',
  )
  assert.equal(await page.evaluate(() => getSelection().toString()), 'beta')

  await page.keyboard.press('Control+Shift+z')
  await page.waitForFunction(() => document.querySelector('article').textContent === 'alpha X gamma')
  assert.equal(await emptyTextNodes(), 0, 'redo left no nodes behind')
})

test('undo after typing leaves the note as it was', async () => {
  await freshEditor()
  await setNote('one two three')
  await placeCaret(8)
  await page.keyboard.type('XYZ')
  await page.waitForFunction(
    () => document.querySelector('article').textContent === 'one two XYZthree',
  )
  await settleHistory()

  await page.keyboard.press('Control+z')
  await page.waitForFunction(
    () => document.querySelector('article').textContent === 'one two three',
  )
  assert.equal(await emptyTextNodes(), 0, 'undo restored the text without stray nodes')
})

test('undo and redo bring a typed html marker back as text', async () => {
  // The marker is text the whole way in: the renderer builds the document
  // from text nodes, and history stores what textContent reads back, so
  // there is no point at which it is parsed as markup - typed, undone, or
  // redone. The second burst is what makes that checkable: the undo below
  // restores a state that CONTAINS the marker, which is the restore that
  // would build a real element if the stack held markup instead of text.
  await freshEditor()
  await setNote('safe')
  await placeCaret(4)
  await page.keyboard.type('<img src=x onerror=alert(1)>')
  await page.waitForFunction(
    () => document.querySelector('article').textContent === 'safe<img src=x onerror=alert(1)>',
  )
  // Let the first burst close before the next one starts, or the two record
  // as one and the undo lands before the marker instead of on it.
  await settleHistory()
  await page.keyboard.type(' more')
  await page.waitForFunction(
    () => document.querySelector('article').textContent === 'safe<img src=x onerror=alert(1)> more',
  )
  await settleHistory()

  const elements = () =>
    page.evaluate(
      () => document.querySelector('article').querySelectorAll('img, script, iframe').length,
    )
  assert.equal(await elements(), 0, 'typed as text, no element is born')

  await page.keyboard.press('Control+z')
  await page.waitForFunction(
    () => document.querySelector('article').textContent === 'safe<img src=x onerror=alert(1)>',
  )
  assert.equal(await elements(), 0, 'undo hands the marker back as text')

  await page.keyboard.press('Control+Shift+z')
  await page.waitForFunction(
    () => document.querySelector('article').textContent === 'safe<img src=x onerror=alert(1)> more',
  )
  assert.equal(await elements(), 0, 'redo, and still no element')
})

test('only a first level one heading names the document', async () => {
  // Upstream issue #26. The title used to need a trailing newline, so a note that
  // was just a heading lost its title, and the space after the hash leaked in.
  const cases = [
    ['# Title', 'Title'],
    ['# Title\nbody', 'Title'],
    ['\n# After a blank line', 'After a blank line'],
    ['#\tTabbed', 'Tabbed'],
    ['# Trailing spaces  ', 'Trailing spaces'],
    ['#Title', 'Textarea'],
    ['## Subheading', 'Textarea'],
    ['#### Deep heading', 'Textarea'],
    ['not a heading\n# Second', 'Textarea'],
    ['just a body', 'Textarea'],
  ]

  for (const [text, expected] of cases) {
    // Sentinel first, so a stale title cannot pass the wait by coincidence.
    await page.evaluate(() => {
      document.title = '__sentinel__'
    })
    await setNote(text)
    await page.waitForFunction((want) => document.title === want, expected, {timeout: 10_000})
  }
})

test('the theme follows the system until the menu says otherwise', async () => {
  await openMenu()
  assert.equal(await page.locator('#menu-theme-label').textContent(), 'Theme: system')
  assert.equal(
    await page.evaluate(() => document.documentElement.dataset.theme),
    undefined,
    'no explicit theme leaves the system in charge',
  )

  // Light, then dark, then back to the system.
  await page.locator('#menu-theme').click()
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light')
  assert.equal(await page.locator('#menu-theme-label').textContent(), 'Theme: light')
  assert.equal(await page.evaluate(() => new URLSearchParams(location.search).get('theme')), 'light')
  // The themes are custom properties on the root, so read those rather than a
  // colour the browser resolves on our behalf.
  const themeVar = () =>
    page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--text').trim(),
    )
  const lightText = await themeVar()

  await openMenu()
  await page.locator('#menu-theme').click()
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark')
  assert.equal(await page.locator('#menu-theme-label').textContent(), 'Theme: dark')
  assert.equal(await page.evaluate(() => new URLSearchParams(location.search).get('theme')), 'dark')
  const darkText = await themeVar()
  assert.notEqual(lightText, darkText, 'the two themes actually differ')
  assert.deepEqual([lightText, darkText], ['#161616', '#fff'])

  // An installed app shows theme-color in its title bar, so the meta tags have to
  // stop deferring to the system once a theme is chosen.
  const metas = await page.evaluate(() =>
    [...document.querySelectorAll('meta[name="theme-color"]')].map((meta) => ({
      media: meta.getAttribute('media'),
      content: meta.getAttribute('content'),
    })),
  )
  // Dark is the theme in force at this point, so both tags carry its chrome.
  assert.deepEqual(metas, [
    {media: null, content: '#000000'},
    {media: null, content: '#000000'},
  ])

  await openMenu()
  await page.locator('#menu-theme').click()
  assert.equal(
    await page.evaluate(() => new URLSearchParams(location.search).has('theme')),
    false,
    'going back to the system drops the parameter',
  )
  const restored = await page.evaluate(() =>
    [...document.querySelectorAll('meta[name="theme-color"]')].map((meta) => meta.getAttribute('media')),
  )
  assert.deepEqual(restored, [
    '(prefers-color-scheme: light)',
    '(prefers-color-scheme: dark)',
  ])
})

test('a theme in the url survives a reload without touching the note', async () => {
  await setNote('# A note\n\nwith **body**')
  await page.waitForFunction((empty) => location.hash.length > 1 && location.hash !== empty, emptyHash)
  const hash = await page.evaluate(() => location.hash)

  const themed = await context.newPage()
  await themed.goto(server.origin + '/?theme=dark' + hash)
  await themed.waitForFunction(
    () =>
      document.documentElement.dataset.theme === 'dark' &&
      document.querySelector('article')?.textContent === '# A note\n\nwith **body**',
    undefined,
    {polling: 100, timeout: 10_000},
  )

  assert.equal(await themed.evaluate(() => document.documentElement.dataset.theme), 'dark')
  assert.equal(await themed.locator('article').textContent(), '# A note\n\nwith **body**')
  await themed.close()
})

test('the rendered markup still looks like it used to', async () => {
  // The expected string was captured from upstream's parseMarkdown before the
  // renderer moved into lib/markdown.js. Pinning it here means the extraction
  // cannot quietly change what the editor draws; the unit tests cover the tree
  // this builds.
  const fixture = [
    '# Title',
    '',
    'A line with **bold**, *italic*, ~~strike~~, `code` and https://example.com/a?b=c.',
    '',
    '## Sub',
    '',
    '```',
    'fenced block',
    '```',
    '',
    'Plain * item and a - dash and 1. numbered',
  ].join('\n')

  await setNote(fixture)
  await until(() => Boolean(document.querySelector('article')?.innerHTML.includes('md-h1')), {
    what: 'the fixture to be rendered',
  })

  const html = await page.evaluate(() => document.querySelector('article').innerHTML)
  const expected = [
    '<span class="md-h1"># Title</span>',
    '',
    'A line with <span class="md-bold">**bold**</span>, <span class="md-italic">*italic*</span>, ' +
      '<span class="md-strike">~~strike~~</span>, <span class="md-code">`code`</span> and ' +
      '<a class="md-url" href="https://example.com/a?b=c." target="_blank" rel="noopener noreferrer">' +
      'https://example.com/a?b=c.</a>',
    '',
    '<span class="md-h2">## Sub</span>',
    '',
    '<span class="md-codeblock">```\nfenced block\n```</span>',
    '',
    'Plain * item and a - dash and 1. numbered',
  ].join('\n')

  assert.equal(html, expected)
  assert.equal(await noteText(), fixture, 'the note itself is unchanged')
})

test('a bulleted list is drawn as one and keeps its text', async () => {
  const fixture = [
    '* Top-level item one',
    '  * Sub-bullet',
    '  * Sub-bullet two',
    '* Top-level item two',
    '    1. Numbered point one',
    '    2. Numbered point two',
  ].join('\n')

  await setNote(fixture)
  await until(() => Boolean(document.querySelector('article .md-li')), {
    what: 'the list fixture to be rendered',
  })

  const items = await page.evaluate(() =>
    [...document.querySelectorAll('article .md-li')].map((li) => ({
      level: li.className,
      // The marker the reader typed is hidden by CSS but still in the text.
      text: li.textContent,
      bullet: getComputedStyle(li, '::before').content,
      indent: getComputedStyle(li).marginLeft,
    })),
  )

  assert.equal(items.length, 6)
  assert.deepEqual(
    items.map((item) => item.level),
    // Four spaces of indent is the third level, since a level is two spaces.
    ['md-li md-li-1', 'md-li md-li-2', 'md-li md-li-2', 'md-li md-li-1', 'md-li md-li-3 md-ol', 'md-li md-li-3 md-ol'],
  )
  // Each item holds its whole source line, indent and marker included, which is
  // what keeps the note round-tripping through the URL unchanged.
  assert.deepEqual(
    items.map((item) => item.text),
    [
      '* Top-level item one',
      '  * Sub-bullet',
      '  * Sub-bullet two',
      '* Top-level item two',
      '    1. Numbered point one',
      '    2. Numbered point two',
    ],
  )
  // The note itself is untouched: the bullet is drawn, never inserted.
  assert.equal(await noteText(), fixture)
})

test('the editor and the menu button have accessible names', async () => {
  // A contenteditable element with no role is announced as a group, and the menu
  // button was an icon with no name at all.
  const article = page.locator('article')
  assert.equal(await article.getAttribute('role'), 'textbox')
  assert.equal(await article.getAttribute('aria-multiline'), 'true')
  assert.equal(await article.getAttribute('aria-label'), 'Note')

  const trigger = page.locator('#button')
  assert.equal(await trigger.getAttribute('aria-label'), 'Menu')
  assert.equal(await trigger.getAttribute('aria-haspopup'), 'menu')
  assert.equal(await trigger.getAttribute('aria-expanded'), 'false')

  await trigger.click()
  assert.equal(await trigger.getAttribute('aria-expanded'), 'true')
  await page.keyboard.press('Escape')
  await page.locator('#menu').waitFor({state: 'hidden'})
  assert.equal(await trigger.getAttribute('aria-expanded'), 'false')
})

chromiumOnly('copying the link says so when the clipboard refuses', async () => {
  await setNote('something worth sharing')
  await page.waitForFunction((empty) => location.hash.length > 1 && location.hash !== empty, emptyHash)

  // The context grants no clipboard permission, and the legacy fallback is
  // refused as well, which is the case that used to be broken: the write
  // rejects, and the app reported success anyway while leaving the rejection
  // unhandled in the console. The last test in the suite fails if that rejection
  // ever comes back.
  //
  // Without the stub the write still succeeds, because the fallback is a real
  // fallback rather than a formality, and a test that only breaks on one of the
  // two routes is testing less than it looks like it is.
  await page.evaluate(() => {
    document.execCommand = () => false
  })
  await openMenu()
  const refused = await notification(async () => {
    await page.locator('#menu-share').click()
  })
  assert.equal(refused.isError, true)
  assert.match(refused.text, /copy to the clipboard/)
})

test('the arrow keys walk the menu', async () => {
  await openMenu()

  // Menu labels are icons followed by text on their own line, so compare on
  // collapsed whitespace rather than on the raw markup.
  const label = () =>
    page.evaluate(() => {
      const active = document.activeElement
      return active?.textContent?.trim().replace(/\s+/g, ' ') ?? null
    })
  const names = await page.evaluate(() =>
    [...document.querySelectorAll('#menu .item:not([hidden])')].map((item) =>
      item.textContent.trim().replace(/\s+/g, ' '),
    ),
  )
  assert.ok(names.length > 4, `expected a real menu, got ${names.join(', ')}`)

  // Focus is put back on the button first so the walk starts from a known place
  // whether or not opening the menu moved the focus itself.
  await page.locator('#button').focus()
  await page.keyboard.press('ArrowDown')
  assert.equal(await label(), names[0], 'the first arrow press walks into the menu')
  await page.keyboard.press('ArrowDown')
  assert.equal(await label(), names[1])
  await page.keyboard.press('ArrowUp')
  assert.equal(await label(), names[0])

  await page.keyboard.press('End')
  assert.equal(await label(), names[names.length - 1])
  await page.keyboard.press('ArrowDown')
  assert.equal(await label(), names[0], 'the list wraps')
  await page.keyboard.press('Home')
  assert.equal(await label(), names[0])

  // The item that only appears while a link is encrypted is skipped rather than
  // focused, since it is hidden.
  assert.ok(
    !names.some((name) => name === 'Remove encryption'),
    'the hidden item should not be in the list',
  )

  // Escape closes and hands the focus back. Waited on rather than sampled: the
  // menu finishes hiding on a 100ms transition, and the browser settles the
  // focus around the same moment.
  await page.keyboard.press('Escape')
  await page.locator('#menu').waitFor({state: 'hidden'})
  await page.waitForFunction(() => document.activeElement?.id === 'button', undefined, {
    timeout: 5000,
  })
})

test('the menu closes when the keyboard tabs away from it', async () => {
  await openMenu()
  await page.keyboard.press('Tab')
  await page.locator('#menu').waitFor({state: 'hidden'})
  assert.equal(await page.locator('#menu').isVisible(), false)
})

test('notifications are announced, errors more insistently', async () => {
  const bubble = page.locator('#notification')
  assert.equal(await bubble.getAttribute('role'), 'status')
  assert.equal(await bubble.getAttribute('aria-live'), 'polite')

  // The two-column toggle is the cheapest thing in the menu that reports a plain
  // success.
  await openMenu()
  const toggled = await notification(async () => {
    await page.locator('#menu-columns').click()
  })
  assert.equal(toggled.isError, false)
  assert.equal(await bubble.getAttribute('aria-live'), 'polite')

  // Encrypting an empty note is an error, and an error should interrupt rather
  // than queue politely behind whatever comes next.
  const failed = await notification(async () => {
    await openMenu()
    await page.locator('#menu-encryption').click()
    const panel = page.locator('dialog.dialog[aria-label="Encryption"]')
    await panel.waitFor({state: 'visible'})
    await panel.getByRole('button', {name: 'Encrypted link', exact: true}).click()
  })
  assert.equal(failed.isError, true)
  assert.match(failed.text, /nothing to share/)
  assert.equal(await bubble.getAttribute('aria-live'), 'assertive')
})

test('the New menu link opens a tab with an empty note', async () => {
  // Upstream issues #37 and #29. #new is not a note: upstream fed it to the
  // hash decoder, where it failed and the failure path cleared the editor, so
  // the new tab was empty by accident rather than by intent.
  await setNote('the note that should not leak into the new tab')
  // Written now: the hash differing from the empty note's is the setup here,
  // and waiting out the save's debounce would be paying for a timer.
  await saveNow()
  await page.waitForFunction((empty) => location.hash.length > 1 && location.hash !== empty, emptyHash)

  await openMenu()
  const [fresh] = await Promise.all([
    context.waitForEvent('page'),
    page.locator('#menu a[href="#new"]').click(),
  ])
  await fresh.waitForFunction(
    () =>
      Boolean(globalThis.textarea) &&
      document.querySelector('article')?.innerHTML === '' &&
      document.title === 'Textarea',
    undefined,
    {polling: 100, timeout: 10_000},
  )

  assert.equal(new URL(fresh.url()).hash, '#new')
  assert.equal(await fresh.evaluate(() => document.querySelector('article').innerHTML), '')
  assert.equal(await fresh.title(), 'Textarea')

  // The new tab is a real editor: typing replaces the #new link with the note.
  await fresh.locator('article').fill('a fresh note')
  // Same again in the new tab: save rather than wait out its debounce.
  await fresh.evaluate(() => globalThis.textarea.save())
  await fresh.waitForFunction(() => location.hash.length > 1 && location.hash !== '#new', undefined, {
    timeout: 10_000,
  })
  const hash = await fresh.evaluate(() => location.hash)
  assert.ok((await decodeHash(hash.slice(1))).startsWith('a fresh note'))
  await fresh.close()
})

test('following a #new link clears the note in the same tab', async () => {
  await setNote('a note worth keeping')
  await page.waitForFunction((empty) => location.hash.length > 1 && location.hash !== empty, emptyHash)

  // The same link opened without target="_blank", e.g. pasted or followed by
  // hand. hashchange lands in load() with a note already on screen.
  await page.evaluate(() => {
    location.hash = '#new'
  })
  await page.waitForFunction(() => document.querySelector('article').textContent === '')
  assert.equal(await noteText(), '')
  assert.equal(await page.title(), 'Textarea')

  // And the note is still one back-navigation away.
  await page.goBack()
  await page.waitForFunction(() => document.querySelector('article').textContent !== '')
})

test('links in the note open without handing back window.opener', async () => {
  await setNote('see https://example.com/ for the details')

  const calls = await page.evaluate(() => {
    const article = document.querySelector('article')
    const link = article.querySelector('a')
    if (!link) return {error: 'no link was rendered'}

    const opened = []
    const original = window.open
    window.open = (...args) => {
      opened.push(args)
      return null
    }
    // Cancel the default navigation too: the spy stops the new tab, but the
    // anchor's own target=_blank would still go to the network.
    const block = (event) => event.preventDefault()
    article.addEventListener('click', block)
    try {
      link.click()
      return {opened}
    } finally {
      window.open = original
      article.removeEventListener('click', block)
    }
  })

  assert.equal(calls.error, undefined, calls.error)
  assert.equal(calls.opened.length, 1, 'exactly one window.open call')
  const [href, target, features] = calls.opened[0]
  assert.equal(href, 'https://example.com/')
  assert.equal(target, '_blank')
  assert.match(features ?? '', /noopener/, 'the opened page must not get window.opener')
  assert.match(features ?? '', /noreferrer/, 'and not the referrer either')
})

test('an email address in the note is a link to the mail client', async () => {
  await setNote('write to jane.doe@example.com about the report')

  const calls = await page.evaluate(() => {
    const article = document.querySelector('article')
    const link = article.querySelector('a')
    if (!link) return {error: 'no link was rendered'}

    const opened = []
    const original = window.open
    window.open = (...args) => {
      opened.push(args)
      return null
    }
    const block = (event) => event.preventDefault()
    article.addEventListener('click', block)
    try {
      link.click()
      return {
        opened,
        href: link.getAttribute('href'),
        text: link.textContent,
        target: link.getAttribute('target'),
        rel: link.getAttribute('rel'),
      }
    } finally {
      window.open = original
      article.removeEventListener('click', block)
    }
  })

  assert.equal(calls.error, undefined, calls.error)
  assert.equal(calls.text, 'jane.doe@example.com')
  assert.equal(calls.href, 'mailto:jane.doe@example.com')
  assert.equal(calls.target, '_blank')
  assert.match(calls.rel ?? '', /noopener/)
  assert.equal(calls.opened.length, 1, 'exactly one window.open call')
  assert.equal(calls.opened[0][0], 'mailto:jane.doe@example.com')
})

test('google: in the note is a link to the search results', async () => {
  await setNote('compare google:textarea vs the rest')

  const calls = await page.evaluate(() => {
    const article = document.querySelector('article')
    const link = article.querySelector('a')
    if (!link) return {error: 'no link was rendered'}

    const opened = []
    const original = window.open
    window.open = (...args) => {
      opened.push(args)
      return null
    }
    const block = (event) => event.preventDefault()
    article.addEventListener('click', block)
    try {
      link.click()
      return {opened, href: link.getAttribute('href'), text: link.textContent}
    } finally {
      window.open = original
      article.removeEventListener('click', block)
    }
  })

  assert.equal(calls.error, undefined, calls.error)
  assert.equal(calls.text, 'google:textarea vs the rest')
  assert.equal(
    calls.href,
    'https://www.google.com/search?q=textarea%20vs%20the%20rest',
    'the query is the rest of the line, encoded',
  )
  assert.equal(calls.opened.length, 1, 'exactly one window.open call')
  assert.equal(calls.opened[0][0], calls.href)
})

chromiumOnly('a local file can be linked from the menu and opened from the note', async () => {
  // The picker opens a native dialog no automation can dismiss, so it is
  // replaced with a stand-in that hands over a real handle from this
  // origin's private storage - a real one, because the store has to survive
  // structured clone on the way in and an object with methods would not.
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory()
    const handle = await root.getFileHandle('linked note.txt', {create: true})
    const writable = await handle.createWritable()
    await writable.write('from the linked file')
    await writable.close()
    globalThis.__realOpenFilePicker = globalThis.showOpenFilePicker
    globalThis.showOpenFilePicker = async () => [handle]
  })

  try {
    await setNote('see the linked file: ')

    await openMenu()
    const linked = await notification(() => page.locator('#menu-filelink').click())
    assert.equal(linked.isError, false)
    assert.match(linked.text, /Linked linked note\.txt/)

    const token = await noteText()
    assert.match(
      token,
      /^see the linked file: \[linked note\.txt\]\(file:\d+\)$/,
      `the token landed at the caret: ${JSON.stringify(token)}`,
    )
    assert.equal(await page.locator('article a.md-file').count(), 1, 'and rendered as a link')

    // The write above was the real store with a real handle in it - the id
    // in the token proves the row landed. Reading it back is the part this
    // build of Chromium cannot survive, the same wall the folder sync's
    // restore test hits, so the click's read is answered from a stand-in for
    // the one table this resolves against: what is under test here is the
    // link, the permission gate and the open, not the storage.
    await page.evaluate(() => {
      const factory = globalThis.indexedDB
      const realOpen = factory.open
      factory.open = (name, version) => {
        if (name !== 'textarea-links') return realOpen.call(factory, name, version)
        const request = {}
        queueMicrotask(() => {
          request.result = {
            close: () => {},
            transaction: () => ({
              objectStore: () => ({
                get: (key) => {
                  // The key the lookup arrived with is kept so the test can
                  // prove it is the number the row was stored under: a string
                  // key is a different key in IndexedDB, and the stand-in
                  // would otherwise mask the miss it causes.
                  globalThis.__linkedFileKey = key
                  const get = {}
                  queueMicrotask(() => {
                    get.result = {
                      name: 'linked note.txt',
                      handle: {
                        name: 'linked note.txt',
                        queryPermission: async () => 'granted',
                        requestPermission: async () => 'granted',
                        getFile: async () =>
                          new File(['from the linked file'], 'linked note.txt', {
                            type: 'text/plain',
                          }),
                      },
                    }
                    get.onsuccess?.()
                  })
                  return get
                },
              }),
            }),
          }
          request.onsuccess?.()
        })
        return request
      }
    })

    // Following the link re-asks for permission, reads the file and - since
    // the note is not empty - asks before replacing it, exactly as the Open
    // menu entry would.
    try {
      const opened = await notification(async () => {
        await page.locator('article a.md-file').click()
        const dialog = page.locator('dialog.dialog')
        await dialog.waitFor({state: 'visible'})
        await dialog.locator('.dialog-button-primary').click()
      })
      assert.equal(opened.isError, false)
      assert.match(opened.text, /Opened linked note\.txt/)
      assert.equal(await noteText(), 'from the linked file')
      const key = await page.evaluate(() => globalThis.__linkedFileKey)
      assert.equal(typeof key, 'number', `the store is keyed by number, not by the note's text: ${key}`)
    } finally {
      await page.evaluate(() => delete globalThis.indexedDB.open)
    }
  } finally {
    await page.evaluate(async () => {
      globalThis.showOpenFilePicker = globalThis.__realOpenFilePicker
      const root = await navigator.storage.getDirectory()
      await root.removeEntry('linked note.txt')
    })
  }
})

chromiumOnly('a file link the browser will not re-admit says so and opens nothing', async () => {
  await setNote('[secret.txt](file:5)')

  // A refused permission is not something the harness can provoke for real,
  // so the read of the one table this link resolves against is answered from
  // a stand-in - the same shape the folder sync's permission tests use - and
  // the stand-in is gone again before anything else touches storage.
  await page.evaluate(() => {
    const factory = globalThis.indexedDB
    const realOpen = factory.open
    factory.open = (name, version) => {
      if (name !== 'textarea-links') return realOpen.call(factory, name, version)
      const request = {}
      queueMicrotask(() => {
        request.result = {
          close: () => {},
          transaction: () => ({
            objectStore: () => ({
              get: () => {
                const get = {}
                queueMicrotask(() => {
                  get.result = {
                    id: 5,
                    name: 'secret.txt',
                    handle: {
                      name: 'secret.txt',
                      queryPermission: async () => 'denied',
                      requestPermission: async () => 'denied',
                    },
                  }
                  get.onsuccess?.()
                })
                return get
              },
            }),
          }),
        }
        request.onsuccess?.()
      })
      return request
    }
  })

  try {
    const before = await noteText()
    const message = await notification(() => page.locator('article a.md-file').click())
    assert.equal(message.isError, true, 'a refusal is reported, not swallowed')
    assert.match(message.text, /Permission to read "secret\.txt"/)
    assert.equal(await noteText(), before, 'the note never moved')
    assert.equal(await page.locator('dialog.dialog').count(), 0, 'and no dialog was raised')
  } finally {
    await page.evaluate(() => delete globalThis.indexedDB.open)
  }
})

chromiumOnly('a link to a file this browser never held says so', async () => {
  await setNote('[gone.txt](file:999)')

  const message = await notification(() => page.locator('article a.md-file').click())
  assert.equal(message.isError, true)
  assert.match(message.text, /no record of/)
  assert.equal(await noteText(), '[gone.txt](file:999)', 'the note is untouched')
})

chromiumOnly('the file links switch hides the action and stops rendering the token', async () => {
  await setNote('[budget](file:3)')

  // The default: the switch is on, the action is offered, the token is a link.
  await openMenu()
  assert.equal(await page.locator('#menu-filelinks').getAttribute('aria-checked'), 'true')
  assert.match(await page.locator('#menu-filelinks-label').textContent(), /File links: on/)
  assert.equal(await page.locator('#menu-filelink').isVisible(), true)
  await page.locator('#menu-filelinks').click()

  // Off: the token is only the text it always was, and the action that would
  // add more of them is gone with it.
  assert.equal(await page.locator('article a.md-file').count(), 0, 'the token stops being a link')
  assert.equal(await noteText(), '[budget](file:3)', 'the note itself never changed')
  await openMenu()
  assert.equal(await page.locator('#menu-filelinks').getAttribute('aria-checked'), 'false')
  assert.match(await page.locator('#menu-filelinks-label').textContent(), /File links: off/)
  assert.equal(await page.locator('#menu-filelink').isVisible(), false, 'the action goes too')
  await page.locator('#menu-filelinks').click()

  // Back on: the same note is a link again, in one click.
  assert.equal(await page.locator('article a.md-file').count(), 1)
  await openMenu()
  assert.equal(await page.locator('#menu-filelinks').getAttribute('aria-checked'), 'true')
  assert.equal(await page.locator('#menu-filelink').isVisible(), true)
  await page.locator('#button').click()

  // Leave the preference where the app ships it.
  await page.evaluate(() => localStorage.removeItem('textarea:file-links'))
})

test('opens a plain text file and puts it in the editor', async () => {
  await page.evaluate(() => localStorage.removeItem('textarea:two-columns'))
  const path = join(DOWNLOADS, 'notes.md')
  await fs.writeFile(path, '# From disk\n\nHello from a **file**.\n')

  const message = await notification(() => page.locator('#file-input').setInputFiles(path))

  assert.match(message.text, /Opened notes\.md/)
  assert.equal(message.isError, false)
  assert.equal(await noteText(), '# From disk\n\nHello from a **file**.\n')
  assert.equal(await page.title(), 'From disk')

  // Wait for the autosave to replace the empty note before reading the URL.
  await page.waitForFunction(
    (empty) => location.hash.length > 1 && location.hash !== empty,
    emptyHash,
    {timeout: 10_000},
  )
  const hash = await page.evaluate(() => location.hash)
  assert.match(hash, /^#[A-Za-z0-9_-]+$/)
  assert.ok((await decodeHash(hash.slice(1))).startsWith('# From disk'))
})

test('reads a UTF-8 file with a byte order mark', async () => {
  const path = join(DOWNLOADS, 'bom.txt')
  await fs.writeFile(path, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('BOM text')]))

  await notification(() => page.locator('#file-input').setInputFiles(path))
  assert.equal(await noteText(), 'BOM text')
})

test('reads a Windows-1252 file and says so', async () => {
  const path = join(DOWNLOADS, 'legacy.txt')
  // 0x92 is a curly quote in Windows-1252 and invalid UTF-8 on its own.
  await fs.writeFile(path, Buffer.from([0x61, 0x92, 0x62]))

  const message = await notification(() => page.locator('#file-input').setInputFiles(path))
  assert.equal(await noteText(), 'a\u2019b')
  assert.match(message.text, /not UTF-8|Windows-1252/)
})

test('warns when the editor already holds text instead of dropping it silently', async () => {
  await setNote('something already here')
  await setNote('something already here')
  const path = join(DOWNLOADS, 'second.txt')
  await fs.writeFile(path, 'second file')

  // The confirm dialog appears because the editor is not empty.
  await page.locator('#file-input').setInputFiles(path)
  const dialog = page.locator('dialog.dialog')
  await dialog.waitFor({state: 'visible'})
  assert.match(await dialog.textContent(), /Replace the current note\?/)

  const message = await notification(() => dialog.locator('.dialog-button-primary').click())
  assert.equal(message.isError, false)
  assert.equal(await noteText(), 'second file')
})

test('extracts a two column PDF and a table from a real PDF', async () => {
  const path = join(DOWNLOADS, 'layout.pdf')
  await fs.writeFile(path, makeLayoutPdf())

  // pdf.js is 1.7 MB and loads on demand, so this is the slow one.
  const message = await notification(() => page.locator('#file-input').setInputFiles(path))
  assert.match(message.text, /Opened layout\.pdf, 2 pages/, message.text)

  const text = await noteText()
  assert.ok(text.includes('Column layout test'), 'the heading survives')

  // Page 1: every left line must come before every right line.
  const firstRight = text.indexOf('Right line 1')
  const lastLeft = text.indexOf('Left line 16')
  assert.ok(lastLeft > -1 && firstRight > -1, 'both columns are present')
  assert.ok(lastLeft < firstRight, `left column should be read first:\n${text}`)

  // Page 2: the table keeps its columns aligned.
  const tableRows = text.split('\n').filter((line) => /apples|pears|kiwi|name/.test(line))
  assert.equal(tableRows.length, 4, `four table rows expected:\n${text}`)
  const columnStarts = tableRows.map((line) => line.search(/name|apples|pears|kiwi/))
  assert.ok(columnStarts.every((start) => start === columnStarts[0]), 'first column aligns')
  const secondColumn = tableRows.map((line) => line.search(/qty|3|12|1(?:\D|$)/))
  assert.ok(secondColumn.every((start) => start > 0), 'second column is present')
})

test('reports a PDF with no text layer instead of opening an empty note', async () => {
  const path = join(DOWNLOADS, 'empty.pdf')
  // A valid page with no content stream text at all.
  await fs.writeFile(path, makePdf(['']))
  const message = await notification(() => page.locator('#file-input').setInputFiles(path))
  assert.match(message.text, /No text found|scan/i, message.text)
})

test('exports every format and writes the expected bytes', async () => {
  await setNote('# Title\n\nline one\nline two')

  const expected = {
    txt: '# Title',
    md: '# Title\n\nline one\nline two\n',
    rtf: '{\\rtf1',
    tex: '\\documentclass',
    yml: 'title: Title',
    json: '"text": "# Title',
    csv: 'line,text',
    xml: '<note',
    html: '<!DOCTYPE html>',
  }

  for (const [format, marker] of Object.entries(expected)) {
    const result = await downloadViaDialog(format)
    assert.equal(result.ok, true, `${format} should download`)
    const text = result.text
    assert.ok(text.includes(marker), `${format} should contain ${JSON.stringify(marker)}, got ${text.slice(0, 120)}`)
  }

  // Names come from the document title and carry the format's extension.
  const txt = await downloadViaDialog('txt')
  assert.equal(txt.suggestedFilename, 'Title.txt')
})

test('an exported HTML page is self contained and renders the note', async () => {
  await setNote('# Title\n\nline one with **bold**')
  const html = (await downloadViaDialog('html')).text
  assert.ok(html.startsWith('<!DOCTYPE html>'))
  assert.ok(html.includes('<style>'), 'the page CSS is inlined')
  assert.ok(!html.includes('<script'), 'no script is exported')
  assert.ok(!html.includes('id="menu"'), 'the editor chrome is not exported')
  assert.ok(html.includes('md-bold'), 'the rendered markdown is included')

  // It must render as a document in its own right.
  const viewer = await context.newPage()
  await viewer.setContent(html)
  const rendered = await viewer.locator('article').innerText()
  assert.match(rendered, /line one with/)
  assert.match(rendered, /bold/)
  assert.equal(await viewer.locator('script').count(), 0)
  await viewer.close()
})

test('writes an AES-256 encrypted ZIP that a wrong password cannot open', async () => {
  await setNote('# Secret\n\nthe launch codes')

  const result = await downloadZip({password: 'correct horse battery', formats: ['txt', 'md', 'html']})
  assert.equal(result.ok, true)
  assert.equal(result.suggestedFilename, 'Secret.zip')

  const bytes = await fs.readFile(result.path)

  // Local file header: compression method 99 is WinZip AES.
  const method = bytes.readUInt16LE(8)
  assert.equal(method, 99, `compression method should be 99 (AES), got ${method}`)

  // The 0x9901 extra field must advertise AE-2 with a strength of 3 (AES-256).
  const nameLength = bytes.readUInt16LE(26)
  const extraLength = bytes.readUInt16LE(28)
  const extra = bytes.subarray(30 + nameLength, 30 + nameLength + extraLength)

  const fields = []
  for (let at = 0; at + 4 <= extra.length; ) {
    const id = extra.readUInt16LE(at)
    const size = extra.readUInt16LE(at + 2)
    fields.push({id, data: extra.subarray(at + 4, at + 4 + size)})
    at += 4 + size
  }

  const aes = fields.find((field) => field.id === 0x9901)
  assert.ok(aes, `a 0x9901 AES extra field is present, found ${fields.map((f) => f.id.toString(16))}`)
  assert.equal(aes.data.length, 7, 'the AES field is 7 bytes')
  assert.equal(aes.data.readUInt16LE(0), 2, 'version 2 is AE-2')
  assert.equal(aes.data.subarray(2, 4).toString(), 'AE', 'vendor id is AE')
  assert.equal(aes.data[4], 3, `AES strength should be 3 (256 bit), got ${aes.data[4]}`)

  // The contents must not survive in the file. The names do: ZIP stores entry
  // names outside the encrypted stream, which is a property of the format, not
  // a leak in this implementation.
  assert.ok(!bytes.includes(Buffer.from('the launch codes')), 'the plaintext is not present')
  assert.ok(bytes.includes(Buffer.from('Secret.md')), 'entry names are in the clear, as ZIP requires')

  // And the app itself must refuse a wrong password and accept the right one.
  const withWrong = await page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
    const {readZip} = await import('/lib/zip.js')
    const files = await readZip(new Blob([bytes]), {password: 'wrong password'})
    return files.map((file) => ({name: file.name, error: file.error ?? null}))
  }, bytes.toString('base64'))

  assert.deepEqual(
    withWrong.map((file) => file.name).sort(),
    ['Secret.html', 'Secret.md', 'Secret.txt'],
  )
  assert.ok(
    withWrong.every((file) => file.error),
    'every entry fails with the wrong password',
  )

  const withRight = await page.evaluate(
    async ({base64, password}) => {
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
      const {readZip} = await import('/lib/zip.js')
      const files = await readZip(new Blob([bytes]), {password})
      return files.map((file) => ({name: file.name, text: file.text, error: file.error ?? null}))
    },
    {base64: bytes.toString('base64'), password: 'correct horse battery'},
  )

  assert.deepEqual(
    withRight.map((file) => file.name).sort(),
    ['Secret.html', 'Secret.md', 'Secret.txt'],
  )
  assert.ok(
    withRight.every((file) => !file.error),
    `every entry decrypts, got ${JSON.stringify(withRight.map((f) => f.error))}`,
  )
  assert.equal(
    withRight.find((file) => file.name === 'Secret.txt').text,
    '# Secret\n\nthe launch codes',
    'the right password gives the note back byte for byte',
  )
})

test('an archive with only the password ticked is refused', async () => {
  await setNote('# Secret\n\nthe launch codes')
  const exportPanel = await openExportPanel('zip')
  await exportPanel.locator('.dialog-button-primary').click()

  const dialog = page.locator('dialog.dialog[aria-label="Save as ZIP"]')
  await dialog.waitFor({state: 'visible'})

  // Clear every format but leave encryption on: encrypting nothing is not a thing.
  for (const box of await dialog.locator('input[type=checkbox]').all()) {
    const name = await box.getAttribute('name')
    if (name === 'encrypt') continue
    if (await box.isChecked()) await box.uncheck()
  }
  assert.equal(await dialog.locator('input[name=encrypt]').isChecked(), true)

  await dialog.locator('.dialog-button-primary').click()

  // The dialog stays open and says what is wrong.
  assert.match(await dialog.locator('.dialog-error').innerText(), /at least one format/i)
  assert.equal(await dialog.isVisible(), true)

  // Tick one, and it goes through.
  await dialog.locator('input[name=txt]').check()
  await dialog.locator('input[name=encrypt]').uncheck()

  const [download] = await Promise.all([
    page.waitForEvent('download', {timeout: 60_000}),
    dialog.locator('.dialog-button-primary').click(),
  ])
  assert.equal(download.suggestedFilename(), 'Secret.zip')
})

test('writes a plain ZIP when encryption is declined', async () => {
  await setNote('# Secret\n\nthe launch codes')
  const result = await downloadZip({password: null, formats: ['txt']})
  const bytes = await fs.readFile(result.path)
  assert.equal(bytes.readUInt16LE(8), 8, 'deflate, not AES')
  assert.ok(bytes.includes(Buffer.from('Secret.txt')))
})

test('an archive past the read limits is refused instead of decompressed', async () => {
  const outcome = await page.evaluate(async () => {
    const {readZip, writeZip} = await import('/lib/zip.js')
    const report = {}

    const attempt = async (label, run) => {
      try {
        await run()
        report[label] = 'no error'
      } catch (error) {
        report[label] = error.message
      }
    }

    // More files than the entry limit allows.
    const many = await writeZip(
      Array.from({length: 8}, (_, i) => ({name: `file-${i}.txt`, text: 'small'})),
    )
    await attempt('entries', () => readZip(many, {maxEntries: 5}))

    // A declared size past the byte limit: refused before anything expands.
    const honest = await writeZip([{name: 'big.txt', text: 'a'.repeat(2 * 1024 * 1024)}])
    await attempt('declared', () => readZip(honest, {maxBytes: 1024 * 1024}))

    // The same 2 MB entry, but with both headers claiming ten bytes. Lying
    // upward is rejected before reading; lying downward overruns the declared
    // size the moment the stream produces more, so the archive yields nothing.
    const bytes = new Uint8Array(
      await (await writeZip([{name: 'lie.txt', text: 'b'.repeat(2 * 1024 * 1024)}])).arrayBuffer(),
    )
    const findLast = (signature) => {
      outer: for (let i = bytes.length - signature.length; i >= 0; i--) {
        for (let j = 0; j < signature.length; j++) {
          if (bytes[i + j] !== signature[j]) continue outer
        }
        return i
      }
      return -1
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const eocd = findLast([0x50, 0x4b, 0x05, 0x06])
    const central = eocd === -1 ? -1 : view.getUint32(eocd + 16, true)
    const local = central === -1 ? -1 : view.getUint32(central + 42, true)
    report.signed =
      view.getUint32(central, true) === 0x02014b50 && view.getUint32(local, true) === 0x04034b50
    if (report.signed) {
      view.setUint32(central + 24, 10, true) // uncompressed size, central directory
      view.setUint32(local + 22, 10, true) // uncompressed size, local header
      const files = await readZip(new Blob([bytes]), {maxBytes: 1024 * 1024})
      report.lying = files
        .map((file) => file.error ?? `returned ${file.text.length} bytes`)
        .join(', ')
    }

    return report
  })

  assert.equal(outcome.signed, true, 'the archive layout is what the patch assumes')
  assert.match(outcome.entries, /more than 5 files/)
  assert.match(outcome.declared, /expands to more than 1 MB/)
  assert.match(
    outcome.lying,
    /Invalid uncompressed size|expands to more than 1 MB/,
    'the lie is refused one way or the other',
  )
  assert.doesNotMatch(outcome.lying, /returned \d+ bytes/, 'and no text comes back from it')
})

test('reopens an encrypted ZIP through the file input', async () => {
  await setNote('# Secret\n\nthe launch codes')
  const source = await downloadZip({password: 'archive password', formats: ['txt', 'md']})
  const copy = join(DOWNLOADS, 'sealed.zip')
  await fs.copyFile(source.path, copy)

  await page.locator('#file-input').setInputFiles(copy)

  const replace = page.locator('dialog.dialog[aria-label="Replace the current note?"]')
  await replace.waitFor({state: 'visible'})
  await replace.locator('.dialog-button-primary').click()

  // The archive is encrypted, so the password prompt must appear.
  const dialog = page.locator('dialog.dialog[aria-label="Encrypted archive"]')
  await dialog.waitFor({state: 'visible'})

  await fillDialog('Password', 'archive password')

  const message = await notification(() => dialog.locator('.dialog-button-primary').click())
  assert.match(message.text, /Opened sealed\.zip/)
  const text = await noteText()
  assert.ok(text.includes('# Secret'), 'the decrypted note is in the editor')
  assert.ok(text.includes('# Secret.txt'), 'entry names are included when there is more than one')
})

test('a wrong ZIP password is reported rather than silently emptying the note', async () => {
  const source = await downloadZip({password: 'right one', formats: ['txt']})
  const copy = join(DOWNLOADS, 'sealed-wrong.zip')
  await fs.copyFile(source.path, copy)

  await setNote('existing text')
  await page.locator('#file-input').setInputFiles(copy)

  const replace = page.locator('dialog.dialog[aria-label="Replace the current note?"]')
  await replace.waitFor({state: 'visible'})
  await replace.locator('.dialog-button-primary').click()

  const dialog = page.locator('dialog.dialog[aria-label="Encrypted archive"]')
  await dialog.waitFor({state: 'visible'})
  await fillDialog('Password', 'wrong one')

  const message = await notification(async () => {
    await dialog.locator('.dialog-button-primary').click()
    // If the dialog is still up then the click never reached the app, and the
    // notification being waited for will never arrive. Saying so here beats a
    // fifteen minute timeout that explains nothing. This has happened
    // intermittently and the state has never been captured, so dump it.
    try {
      await dialog.waitFor({state: 'hidden', timeout: 15_000})
    } catch {
      console.log(
        'DIAG',
        JSON.stringify(
          await page.evaluate(() => ({
            seq: document.querySelector('#notification').dataset.sequence ?? null,
            cls: document.querySelector('#notification').className,
            text: document.querySelector('#notification').textContent,
            note: document.querySelector('article').textContent.slice(0, 40),
            dialogs: [...document.querySelectorAll('dialog.dialog')].map((d) => ({
              label: d.getAttribute('aria-label'),
              open: d.open,
              inputs: [...d.querySelectorAll('input')].map((i) => i.type + '=' + JSON.stringify(i.value)),
            })),
          })),
        ),
      )
      throw new Error('the password dialog never closed')
    }
  })
  assert.equal(message.isError, true)
  assert.match(message.text, /Wrong password|Could not read/i)
  assert.equal(await noteText(), 'existing text', 'the editor is left alone')
})

test('an encrypted link round trips through a reload', async () => {
  await setNote('# Locked note\n\nsecret text')

  await encryptionAction('Encrypted link')

  let dialog = page.locator('dialog.dialog')
  await dialog.waitFor({state: 'visible'})
  await fillDialog('Password', 'link password')
  await fillDialog('Repeat the password', 'link password')

  await notification(() => dialog.locator('.dialog-button-primary').click())

  const hash = await page.evaluate(() => location.hash)
  assert.ok(hash.startsWith('#!'), `the hash should be marked encrypted, got ${hash.slice(0, 8)}`)
  // The plaintext here is 30 characters. Salt, IV and the GCM tag add 44 bytes on
  // top of the ciphertext, so the hash cannot be shorter than that overhead.
  assert.ok(hash.length > 100, `the hash carries the encryption overhead, got ${hash.length} chars`)
  assert.ok(!hash.includes('secret'), 'no plaintext in the URL')

  // The menu row says so before it is opened: an open padlock and a label.
  await openMenu()
  assert.match(await page.locator('#menu-encryption-label').textContent(), /Encryption: on/)
  assert.match(
    await page.locator('#menu-encryption use').getAttribute('xlink:href'),
    /#icon-unlock/,
  )
  await page.keyboard.press('Escape')
  await page.locator('#menu').waitFor({state: 'hidden'})

  // Reloading must ask for the password.
  const second = await context.newPage()
  await second.goto(server.origin + '/' + hash)
  await second.waitForFunction(() => Boolean(globalThis.textarea))

  const secondDialog = second.locator('dialog.dialog')
  await secondDialog.waitFor({state: 'visible'})
  assert.match(await secondDialog.textContent(), /encrypted/i)

  // A wrong password is refused, then the right one works.
  await secondDialog.locator('input[type=password]').first().fill('nope')
  await secondDialog.locator('.dialog-button-primary').click()
  await second.waitForFunction(() =>
    document.querySelector('#notification')?.textContent?.includes('Wrong password'),
  )
  await secondDialog.locator('input[type=password]').first().fill('link password')
  await secondDialog.locator('.dialog-button-primary').click()

  await second.waitForFunction(() => document.querySelector('article')?.textContent?.includes('secret text'))
  assert.match(await second.locator('article').textContent(), /# Locked note/)
  await second.close()

  // The editor still shows the note, and the hash is untouched by typing.
  assert.match(await noteText(), /secret text/)
  await setNote('# Locked note\n\nsecret text edited')
  // The save runs - now, rather than after its debounce - and still must not
  // touch the hash: waiting a fixed interval only proved nothing happened
  // within it, this proves the save itself left the link alone.
  await saveNow()
  assert.equal(await page.evaluate(() => location.hash), hash, 'autosave stays off while encrypted')
})

test('an encrypted note is never autosaved into a plaintext hash', async () => {
  await setNote('# Locked note\n\noriginal content')

  // Put the note behind a password first; otherwise there is nothing to protect.
  await encryptionAction('Encrypted link')
  let dialog = page.locator('dialog.dialog')
  await dialog.waitFor({state: 'visible'})
  await fillDialog('Password', 'link password')
  await fillDialog('Repeat the password', 'link password')
  await notification(() => dialog.locator('.dialog-button-primary').click())

  const encrypted = await page.evaluate(() => location.hash)
  assert.ok(encrypted.startsWith('#!'), 'the hash starts out encrypted')

  await setNote('# Locked note\n\ncompletely different content')
  // Same again, with the save actually run: the debounce is not what protects
  // the link, the encryption is.
  await saveNow()

  const after = await page.evaluate(() => location.hash)
  assert.equal(after, encrypted, 'autosave stays off while encrypted')
  assert.ok(!after.includes('TXE1') || after.startsWith('#!'), 'the plaintext codec was not used')
})

test('removing encryption rewrites the link in the clear', async () => {
  await setNote('# Locked note\n\ncompletely different content')

  await encryptionAction('Encrypted link')

  let dialog = page.locator('dialog.dialog')
  await dialog.waitFor({state: 'visible'})
  await fillDialog('Password', 'link password')
  await fillDialog('Repeat the password', 'link password')
  await notification(() => dialog.locator('.dialog-button-primary').click())

  assert.ok((await page.evaluate(() => location.hash)).startsWith('#!'), 'it starts out encrypted')

  // Only now does the panel offer to take the encryption off again.
  await openMenu()
  await page.locator('#menu-encryption').click()
  dialog = page.locator('dialog.dialog[aria-label="Encryption"]')
  await dialog.waitFor({state: 'visible'})
  assert.equal(await dialog.getByRole('button', {name: 'Remove encryption'}).isEnabled(), true)
  await dialog.getByRole('button', {name: 'Remove encryption'}).click()
  await dialog.waitFor({state: 'detached'})

  dialog = page.locator('dialog.dialog')
  await dialog.waitFor({state: 'visible'})
  await notification(() => dialog.locator('.dialog-button-danger').click())

  const hash = await page.evaluate(() => location.hash)
  assert.ok(!hash.startsWith('#!'), 'the link is plain again')
  assert.ok((await decodeHash(hash.slice(1))).includes('completely different content'))

  // And there is nothing left to remove, so the panel says so by disabling it.
  await openMenu()
  await page.locator('#menu-encryption').click()
  const panel = page.locator('dialog.dialog[aria-label="Encryption"]')
  await panel.waitFor({state: 'visible'})
  assert.equal(await panel.getByRole('button', {name: 'Remove encryption'}).isDisabled(), true)
  assert.equal(await panel.getByRole('button', {name: 'Encrypted link', exact: true}).count(), 1)
  assert.match(await page.locator('#menu-encryption-label').textContent(), /^Encryption$/)
  await panel.getByRole('button', {name: 'Cancel'}).click()
  await panel.waitFor({state: 'detached'})
})

/* ------------------------------------------------------------- the new panels */

test('the Export panel offers four destinations and names the button for each', async () => {
  await openMenu()
  await page.locator('#menu-export').click()

  const dialog = page.locator('dialog.dialog[aria-label="Export"]')
  await dialog.waitFor({state: 'visible'})

  assert.deepEqual(
    await dialog.locator('input[name=destination]').evaluateAll((boxes) =>
      boxes.map((box) => box.value),
    ),
    ['file', 'copy', 'qr', 'zip'],
  )

  // The format list applies to a file and a clipboard, and to nothing else.
  const formatField = dialog.locator('.dialog-field').nth(1)
  assert.equal(await formatField.isVisible(), true)
  assert.equal(await dialog.locator('input[name=format]').count(), 9)

  // The list belongs to a file and a clipboard. A QR code carries the link and an
  // archive picks its own formats, so neither of them has one to choose.
  for (const [destination, submit, hasFormats] of [
    ['file', 'Save', true],
    ['copy', 'Copy', true],
    ['qr', 'Show', false],
    ['zip', 'Save', false],
  ]) {
    await dialog.locator(`input[name=destination][value=${destination}]`).check()
    assert.equal(await dialog.locator('.dialog-button-primary').textContent(), submit, destination)
    assert.equal(await formatField.isVisible(), hasFormats, `${destination} and its format list`)
  }

  await dialog.locator('.dialog-button-primary').click()
  await dialog.waitFor({state: 'detached'})
})

chromiumOnly('Copy puts the converted note on the clipboard in one click', async () => {
  // A context of its own: the main one has no clipboard permission on purpose,
  // because another test asserts what happens when the browser refuses.
  const owned = await clipboardContext()
  try {
    await owned.page.evaluate(() => {
      globalThis.textarea.editor.replace('# Copied\n\nline one\nline two')
    })
    await owned.page.waitForFunction(() => location.hash.length > 1)

    await owned.page.locator('#button').click()
    await owned.page.locator('#menu').waitFor({state: 'visible'})
    await owned.page.locator('#menu-export').click()

    const dialog = owned.page.locator('dialog.dialog[aria-label="Export"]')
    await dialog.waitFor({state: 'visible'})
    await dialog.locator('input[name=destination][value=copy]').check()
    await dialog.locator('input[name=format][value=md]').check()
    await dialog.locator('.dialog-button-primary').click()
    await dialog.waitFor({state: 'detached'})

    await owned.page.waitForFunction(
      () => document.querySelector('#notification').classList.contains('visible'),
    )

    // Read the real clipboard back: byte for byte what a download would have
    // written, which is the point of sharing one converter.
    assert.equal(await owned.page.evaluate(() => navigator.clipboard.readText()), '# Copied\n\nline one\nline two\n')
    assert.match(
      await owned.page.locator('#notification').textContent(),
      /Copied Markdown, \d+ characters/,
    )
  } finally {
    await owned.context.close()
  }
})

test('the QR panel draws the note link and saves it as a vector file', async () => {
  await setNote('# Scannable\n\nthe link should open this note')

  const dialog = await openExportPanel('qr')
  await dialog.locator('.dialog-button-primary').click()

  const panel = page.locator('dialog.dialog-qr')
  await panel.waitFor({state: 'visible'})

  // The encoder is loaded on demand, so the symbol is not there the instant the
  // dialog opens.
  const symbol = panel.locator('.qr-figure svg')
  await symbol.waitFor({state: 'attached', timeout: 30_000})
  assert.match(await symbol.getAttribute('aria-label'), /QR code/)

  // A light quiet zone, because a scanner cannot read the dark theme.
  assert.equal(await panel.locator('.qr-figure rect').getAttribute('fill'), '#ffffff')

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    panel.getByRole('button', {name: 'Download SVG'}).click(),
  ])
  assert.equal(download.suggestedFilename(), 'Scannable-qr.svg')
  await download.saveAs(join(DOWNLOADS, download.suggestedFilename()))

  const svg = await fs.readFile(join(DOWNLOADS, 'Scannable-qr.svg'), 'utf8')
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/)
  assert.match(svg, /viewBox="0 0 \d+ \d+"/)
  assert.ok(svg.includes('<path'), 'the symbol is one path, not a rectangle per module')
})

test('a note too long for a QR code says so and still offers the link', async () => {
  // 2,331 bytes is the largest symbol there is. The text has to be
  // incompressible: a note of one repeated character deflates to a few dozen
  // bytes and produces a perfectly valid short QR, which is not the case under
  // test here.
  const noise = Array.from({length: 3000}, () =>
    String.fromCharCode(33 + Math.floor(Math.random() * 90)),
  ).join('')
  await setNote(noise)
  await until(() => location.hash.length > 3200, {
    what: 'a link longer than the largest QR symbol can carry',
  })

  const dialog = await openExportPanel('qr')
  await dialog.locator('.dialog-button-primary').click()

  const panel = page.locator('dialog.dialog-qr')
  await panel.waitFor({state: 'visible'})

  const error = panel.locator('.dialog-error')
  await error.waitFor({state: 'visible', timeout: 30_000})
  assert.match(await error.textContent(), /too long for a QR code/i)
  assert.equal(await panel.getByRole('button', {name: 'Download SVG'}).isDisabled(), true)

  await panel.locator('.dialog-button').first().click()
  await panel.waitFor({state: 'detached'})
})

test('startup: panels rarely opened are fetched when their entry is used', async () => {
  // The panels behind menu entries a reader opens once a month are not part of
  // the boot: the entry fetches them. A fresh load is the honest place to
  // count, since resource timing resets with the navigation.
  await freshEditor()

  const names = () =>
    page.evaluate(() => performance.getEntriesByType('resource').map((entry) => entry.name))
  const boot = await names()
  for (const file of [
    'library-panel.js',
    'export-panel.js',
    'qr-panel.js',
    'encryption-panel.js',
    'qr.js',
    'file-links.js',
    'settings-panel.js',
    'settings-rows.js',
    'backlinks-panel.js',
    'backlinks.js',
    'switcher.js',
    'tasks-panel.js',
    'writing-tools.js',
    'gemma.js',
    'organise.js',
    'board-panel.js',
    'sticky.js',
    // Reading files, writing them, and mirroring to a folder: none of it is
    // part of a session that only types.
    'open.js',
    'pdf.js',
    'pdf-layout.js',
    'zip.js',
    'export.js',
    'formats.js',
    'save.js',
    'folder-sync.js',
  ]) {
    assert.ok(!boot.some((name) => name.endsWith(file)), `${file} is not part of the boot`)
  }
  // vendor/README.md promises that nothing in that directory is loaded on the
  // initial page load: pdf.js and its worker (1.7 MB together), the QR encoder
  // and the glass module arrive with the feature that needs them. This is the
  // boot that promise is made about.
  assert.ok(
    !boot.some((name) => name.includes('/vendor/')),
    'nothing from vendor/ is part of the boot',
  )

  // The entry still works - the panel arrives on the click that needs it,
  // which is what makes the missing fetch a saving rather than a gap.
  await openMenu()
  await page.locator('#menu-documents').click()
  const panel = page.locator('dialog.dialog-library')
  await panel.waitFor({state: 'visible'})
  assert.ok(
    (await names()).some((name) => name.endsWith('library-panel.js')),
    'the documents panel was fetched by the entry that opens it',
  )

  await page.keyboard.press('Escape')
  await panel.waitFor({state: 'detached'})
})

test('every icon the menu and panels use resolves to a drawing', async () => {
  // A <use> pointing at a symbol that is not there draws nothing at all, and the
  // gap is invisible until someone opens the menu.
  const ids = await page.evaluate(() =>
    [...document.querySelectorAll('use')].map((use) =>
      (use.getAttribute('href') ?? use.getAttribute('xlink:href') ?? '').slice(1),
    ),
  )
  assert.ok(ids.length > 0, 'the page should have icons')

  const missing = await page.evaluate((wanted) => {
    const defined = new Set([...document.querySelectorAll('symbol')].map((s) => s.id))
    return [...new Set(wanted)].filter((id) => id && !defined.has(id))
  }, ids)
  assert.deepEqual(missing, [], `symbols with no drawing: ${missing.join(', ')}`)

  // The ones the new features rely on. icon-save is in the list because it is
  // the newest symbol and the only one added after the menu was first wired: a
  // <use> naming a symbol nobody defined draws nothing, and the gap is invisible
  // until someone opens the panel that uses it.
  const wanted = ['icon-qr', 'icon-copy', 'icon-download', 'icon-save', 'icon-list', 'icon-info', 'icon-close', 'icon-delete']
  for (const id of wanted) {
    const drawn = await page.evaluate((name) => {
      const symbol = document.querySelector(`symbol#${name}`)
      return Boolean(symbol) && Boolean(symbol.querySelector('path'))
    }, id)
    assert.equal(drawn, true, `${id} should have a path`)
  }
})

/* ---------------------------------------------------------- the statistics panel */

test('the statistics panel counts the note and follows along as it changes', async () => {
  await setNote('')
  const panel = page.locator('#stats-panel')
  assert.equal(await panel.isVisible(), false)

  await openMenu()
  await page.locator('#menu-stats').click()

  await panel.waitFor({state: 'visible'})
  assert.equal(await page.locator('#menu-stats').getAttribute('aria-checked'), 'true')

  await setNote('# Shopping\n\nmilk\nbread and butter\ntea')
  // The panel updates on the same debounce as the autosave.
  await panel.locator('dd[data-key="words"]').filter({hasText: '7'}).waitFor({state: 'visible'})

  const read = async (key) => panel.locator(`dd[data-key="${key}"]`).textContent()
  assert.equal(await read('words'), '7')
  assert.equal(await read('characters'), '37')
  assert.equal(await read('charactersTight'), '30')
  assert.equal(await read('lines'), '5')
  assert.equal(await read('sentences'), '4')
  assert.equal(await read('speaking'), '3 sec')
  assert.equal(await read('reading'), '2 sec')

  // It is not announced: a live region would narrate every keystroke.
  assert.equal(await panel.getAttribute('role'), 'group')
  assert.equal(await panel.getAttribute('aria-live'), null)
  assert.equal(await panel.getAttribute('aria-label'), 'Note statistics')

  // The same menu entry closes it, and the choice is remembered.
  await openMenu()
  await page.locator('#menu-stats').click()
  await panel.waitFor({state: 'hidden'})
  assert.equal(await page.locator('#menu-stats').getAttribute('aria-checked'), 'false')
  assert.equal(await page.evaluate(() => localStorage.getItem('textarea:stats')), 'off')
})

test('the statistics panel survives a reload when it was left open', async () => {
  await openMenu()
  await page.locator('#menu-stats').click()
  await page.locator('#stats-panel').waitFor({state: 'visible'})

  await freshEditor()
  await page.locator('#stats-panel').waitFor({state: 'visible'})
  assert.equal(await page.locator('#menu-stats').getAttribute('aria-checked'), 'true')

  // Its own close button puts the preference back, so a reload does not bring it
  // back after being told to go away.
  await page.locator('.stats-close').click()
  await page.locator('#stats-panel').waitFor({state: 'hidden'})
  assert.equal(await page.evaluate(() => localStorage.getItem('textarea:stats')), 'off')
})

/* ---------------------------------------------------------- the document library */

test('a note is kept in the library as it is typed, and reopens after a reload', async () => {
  await setNote('# Kept\n\nthe library should hold this')

  await until(async () => {
    const library = await import('/lib/library.js')
    const entries = await library.listDocuments()
    return entries.some((entry) => entry.title === 'Kept' && entry.text.includes('should hold this'))
  }, {what: 'the note to reach the library'})

  const entry = await page.evaluate(async () => {
    const library = await import('/lib/library.js')
    const [first] = await library.listDocuments()
    return {id: first.id, words: first.words}
  })
  assert.equal(entry.words, 7)

  // The identity is stable, so a reload continues the same row rather than
  // making a second copy of the same note.
  const before = await page.evaluate(() => globalThis.textarea.documentId)
  await page.reload()
  await page.waitForFunction(() => Boolean(globalThis.textarea))
  await page.waitForFunction(() => document.querySelector('article').textContent.includes('should hold this'))
  assert.equal(await page.evaluate(() => globalThis.textarea.documentId), before)

  assert.equal(
    await page.evaluate(async () => (await (await import('/lib/library.js')).listDocuments()).length),
    1,
    'a reload should not have made a second copy of the same note',
  )
})

test('the documents panel opens a stored note and deletes another', async () => {
  await setNote('# First note\n\nalpha')
  await until(async () => (await (await import('/lib/library.js')).listDocuments()).length === 1, {
    what: 'the first note to be stored',
  })

  // A second note, made by starting a new one rather than editing the first.
  await openMenu()
  await page.locator('#menu-documents').click()
  const panel = page.locator('dialog.dialog-library')
  await panel.waitFor({state: 'visible'})
  await panel.locator('.document-title').first().waitFor()
  await panel.getByRole('button', {name: 'New note'}).click()
  await page.locator('dialog.dialog[aria-label="Start a new note?"]').waitFor({state: 'visible'})
  await page.locator('.dialog-button-primary').click()
  await setNote('# Second note\n\nbeta')
  await until(async () => (await (await import('/lib/library.js')).listDocuments()).length === 2, {
    what: 'the second note to be stored',
  })

  // Both are listed, newest first.
  await openMenu()
  await page.locator('#menu-documents').click()
  await panel.waitFor({state: 'visible'})
  // The dialog opens first and fills in when the library read comes back.
  await panel.locator('.document-row:not(.document-row-empty)').first().waitFor()
  assert.deepEqual(await panel.locator('.document-title').allTextContents(), ['Second note', 'First note'])

  // The panel is a board of cards rather than a list of rows: what it is for
  // is recognising a note at a glance, and one line of text per note does not
  // give anyone enough to recognise. Each card is the note's own yellow
  // square, and square because a sticky note is square.
  assert.equal(
    await panel.locator('.document-list').evaluate((list) => getComputedStyle(list).display),
    'grid',
    'the notes should be laid out as a grid of cards',
  )
  const cards = await panel.locator('.document-open').evaluateAll((buttons) =>
    buttons.map((button) => {
      const style = getComputedStyle(button)
      const rect = button.getBoundingClientRect()
      const [red, green, blue] = style.backgroundColor.match(/\d+/g).map(Number)
      return {ratio: rect.width / rect.height, paper: red > 200 && green > 170 && blue < 200}
    }),
  )
  assert.ok(cards.every((card) => card.paper), 'every card should read as a yellow note')
  assert.ok(
    cards.every((card) => Math.abs(card.ratio - 1) < 0.02),
    `every card should be square, got ${cards.map((card) => card.ratio.toFixed(2)).join(', ')}`,
  )

  // The card for the note on screen is marked. The ring and the badge are both
  // drawn from the attribute, so the attribute is what there is to assert on.
  assert.deepEqual(
    await panel
      .locator('.document-row[data-current="true"] .document-title')
      .evaluateAll((titles) => titles.map((title) => title.firstChild.textContent)),
    ['Second note'],
  )

  // Deleting asks first.
  await panel.locator('.document-row').first().locator('.document-delete').click()
  const confirm = page.locator('dialog.dialog-confirm')
  await confirm.waitFor({state: 'visible'})
  assert.match(await confirm.locator('.dialog-title').textContent(), /Delete “Second note”\?/)
  await confirm.getByRole('button', {name: 'Delete'}).click()
  await confirm.waitFor({state: 'detached'})

  await until(() => document.querySelectorAll('.dialog-library .document-title').length === 1, {
    what: 'the deleted note to leave the list',
  })
  assert.deepEqual(await panel.locator('.document-title').allTextContents(), ['First note'])

  // And opening what is left asks first, because the editor still holds the note
  // that was just deleted.
  await panel.locator('.document-open').first().click()
  await panel.waitFor({state: 'detached'})

  const replace = page.locator('dialog.dialog[aria-label="Replace the current note?"]')
  await replace.waitFor({state: 'visible'})
  assert.match(await replace.textContent(), /Opening First note/)
  await replace.locator('.dialog-button-primary').click()

  await until(() => document.querySelector('article').textContent === '# First note\n\nalpha', {
    what: 'the first note to be back in the editor',
  })
  assert.equal(await noteText(), '# First note\n\nalpha')
})

test('the documents panel searches titles and text', async () => {
  await setNote('# Recipes\n\npasta and pesto')
  // The row is written now rather than after the save's debounce: every wait
  // below is about the panel, and none of them should be paying for a timer.
  await saveNow()
  await until(async () => (await (await import('/lib/library.js')).listDocuments()).length === 1, {
    what: 'the recipe to be stored',
  })

  await openMenu()
  await page.locator('#menu-documents').click()
  const panel = page.locator('dialog.dialog-library')
  await panel.waitFor({state: 'visible'})
  await panel.locator('.document-row:not(.document-row-empty)').first().waitFor()

  await panel.locator('.dialog-search').fill('pesto')
  await panel.locator('.document-title').filter({hasText: 'Recipes'}).waitFor()

  await panel.locator('.dialog-search').fill('nothing here at all')
  await panel.locator('.document-row-empty').waitFor()
  assert.match(await panel.locator('.document-row-empty').innerText(), /Nothing matches/)

  // The search covers the body, not just the title.
  await panel.locator('.dialog-search').fill('PASTA')
  await panel.locator('.document-title').filter({hasText: 'Recipes'}).waitFor()

  await panel.locator('.dialog-button-primary').click()
  await panel.waitFor({state: 'detached'})
})

test('a note opened from a link is in the library without being typed', async () => {
  const note = '# Shared\n\ncame in through the address bar'
  const hash = '#' + (await (await import('../../lib/share.js')).encodeHash(note))

  // The rows already in the library are reset's business, not this test's:
  // what opening the link has to add is exactly this note, with no typing.
  const before = await page.evaluate(async () =>
    (await (await import('/lib/library.js')).listDocuments()).map((entry) => entry.hash),
  )

  await page.goto(server.origin + '/' + hash)
  await page.waitForFunction(() => document.querySelector('article').textContent.includes('address bar'))

  await until(async () => {
    const library = await import('/lib/library.js')
    const entries = await library.listDocuments()
    return entries.some((entry) => entry.title === 'Shared')
  }, {what: 'the linked note to reach the library'})

  const entries = await page.evaluate(async () =>
    (await (await import('/lib/library.js')).listDocuments()).map((entry) => entry.hash),
  )
  // Stored without the '#', which is what the hash codec produces.
  assert.deepEqual(
    [...entries].sort(),
    [...before, hash.slice(1)].sort(),
    'opening the link adds the note to the library and nothing else',
  )
})

test('a shared link cannot smuggle a style that covers the interface', async () => {
  // What a hostile link carries: a benign colour, plus an overlay and a
  // tracker, all in the style half of the payload.
  const content =
    'note text\x00color: red; position: fixed; inset: 0; z-index: 9999; ' +
    'background-image: url(https://tracker.example/pixel)'
  const hash = '#' + (await (await import('../../lib/share.js')).encodeHash(content))

  await page.goto(server.origin + '/' + hash)
  await page.waitForFunction(() => document.querySelector('article').textContent.includes('note text'))

  const style = await page.locator('article').getAttribute('style')
  assert.match(style, /color: red/, 'the decorative declaration survives')
  assert.doesNotMatch(
    style ?? '',
    /position|inset|z-index|url\(/,
    'overlay and tracking declarations are gone',
  )

  // The allowlist itself: shorthands reduce to their safe longhands, and a
  // value the CSSOM refuses to parse is dropped whole.
  const probe = await page.evaluate(async () => {
    const {sanitizeStyle} = await import('/lib/style.js')
    return {
      shorthand: sanitizeStyle('background: url(https://tracker.example/pixel) red; font: 16px Georgia'),
      invalid: sanitizeStyle('color: expression(alert(1))'),
      empty: sanitizeStyle('position: fixed'),
      absent: sanitizeStyle(null),
    }
  })
  assert.match(probe.shorthand, /background-color: red/)
  assert.match(probe.shorthand, /font-size: 16px/)
  assert.doesNotMatch(probe.shorthand ?? '', /url\(|background:|font:/)
  assert.equal(probe.invalid, null)
  assert.equal(probe.empty, null)
  assert.equal(probe.absent, null)

  // Leave the editor as the next test expects to find it.
  await page.evaluate(() => document.querySelector('article').removeAttribute('style'))
})

test('drag and drop shows the overlay and opens the file', async () => {
  await setNote('')
  const overlay = page.locator('#drop-overlay')
  assert.equal(await overlay.isVisible(), false)

  // A DataTransfer carrying a file, built in the page.
  await page.evaluate(() => {
    const transfer = new DataTransfer()
    transfer.items.add(new File(['# Dropped\n\nvia drag and drop'], 'dropped.md', {type: 'text/markdown'}))
    for (const type of ['dragenter', 'dragover']) {
      const event = new DragEvent(type, {dataTransfer: transfer, bubbles: true, cancelable: true})
      Object.defineProperty(event, 'dataTransfer', {value: transfer})
      dispatchEvent(event)
    }
  })
  await overlay.waitFor({state: 'visible', timeout: 5000})

  await notification(() =>
    page.evaluate(() => {
      const transfer = new DataTransfer()
      transfer.items.add(new File(['# Dropped\n\nvia drag and drop'], 'dropped.md', {type: 'text/markdown'}))
      const event = new Event('drop', {bubbles: true, cancelable: true})
      Object.defineProperty(event, 'dataTransfer', {value: transfer})
      dispatchEvent(event)
    }),
  )
  assert.equal(await noteText(), '# Dropped\n\nvia drag and drop')
})

test('a text drag inside the editor is not hijacked by the file handler', async () => {
  const handled = await page.evaluate(() => {
    const transfer = new DataTransfer()
    transfer.setData('text/plain', 'just text')
    const event = new Event('dragover', {bubbles: true, cancelable: true})
    Object.defineProperty(event, 'dataTransfer', {value: transfer})
    dispatchEvent(event)
    return event.defaultPrevented
  })
  assert.equal(handled, false, 'a plain text drag must reach the editor')
})

test('the two column toggle flips and persists', async () => {
  await openMenu()
  await notification(() => page.locator('#menu-columns').click())
  assert.equal(
    await page.evaluate(() => localStorage.getItem('textarea:two-columns')),
    'off',
  )
  assert.match(await page.locator('#menu-columns-label').textContent(), /off/)

  await openMenu()
  await notification(() => page.locator('#menu-columns').click())
  assert.equal(
    await page.evaluate(() => localStorage.getItem('textarea:two-columns')),
    'on',
  )
})

test('a label on glass still reads 4.5:1 with the note’s own ink behind it', async () => {
  // axe cannot judge text over a gradient or a backdrop: it reports those as
  // incomplete, which the scan below does not fail on. So the worst case is
  // worked out here instead - the thinnest part of the fill, with nothing
  // behind the label but the page, and then nothing but the note's own ink.
  try {
    for (const scheme of ['light', 'dark']) {
      await page.emulateMedia({colorScheme: scheme})
      const glass = await page.evaluate(() => {
        const probe = document.createElement('span')
        document.body.append(probe)
        const rgb = (value) => {
          probe.style.color = value
          return getComputedStyle(probe).color.match(/[\d.]+/g).slice(0, 3).map(Number)
        }
        const root = getComputedStyle(document.documentElement)
        const alpha = parseFloat(root.getPropertyValue('--glass-thin')) / 100
        const fill = rgb('var(--elevated)')
        const ink = rgb('var(--text)')
        const paper = rgb(root.backgroundColor)
        probe.remove()

        const luminance = (colour) => {
          const [r, g, b] = colour.map((c) => (c / 255 <= 0.03928 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4))
          return 0.2126 * r + 0.7152 * g + 0.0722 * b
        }
        const contrast = (a, b) => {
          const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x)
          return (high + 0.05) / (low + 0.05)
        }
        const over = (behind) => fill.map((c, i) => c * alpha + behind[i] * (1 - alpha))
        return {
          isGlass: document.documentElement.classList.contains('glass'),
          alpha,
          onPaper: contrast(ink, over(paper)),
          onInk: contrast(ink, over(ink)),
        }
      })
      assert.ok(glass.isGlass, 'glass is on from the boot, for the button')
      assert.ok(glass.alpha > 0 && glass.alpha < 1, `${scheme}: the fill is translucent`)
      assert.ok(glass.onPaper >= 4.5, `${scheme}: ${glass.onPaper.toFixed(2)}:1 over the page`)
      assert.ok(glass.onInk >= 4.5, `${scheme}: ${glass.onInk.toFixed(2)}:1 over the note's ink`)
    }
  } finally {
    await page.emulateMedia({colorScheme: null})
  }
})

chromiumOnly('the glass row switches the refraction on the floating panels', async () => {
  const filters = () =>
    page.evaluate(() => document.querySelectorAll('filter[id^="lg-filter"]').length)
  const menuAlpha = () =>
    page.evaluate(() => {
      const parts = getComputedStyle(document.getElementById('menu')).backgroundColor.match(
        /[\d.]+/g,
      )
      return parts && parts.length === 4 ? Number(parts[3]) : 1
    })

  // On by default: the row says so, the root carries the class the translucent
  // background hangs off, and the menu's plain blur has been replaced by the
  // module's own inline backdrop-filter. Headless Chromium refracts through
  // url(#lg-filter-…); a browser that cannot use an SVG filter as a backdrop
  // gets the module's frosted blur in the same inline style, so either way the
  // value is non-empty — and either way it is the module's, not the
  // stylesheet's.
  await openMenu()
  assert.equal(await page.locator('#menu-glass-label').textContent(), 'Glass: on')
  assert.equal(await page.locator('#menu-glass').getAttribute('aria-checked'), 'true')
  await page.waitForFunction(() => document.getElementById('menu').style.backdropFilter !== '')
  assert.ok(
    await page.evaluate(() => document.documentElement.classList.contains('glass')),
    'the root should carry the glass class',
  )
  assert.ok((await menuAlpha()) < 1, 'the menu should be translucent while the effect is on')

  // The material that makes a translucent box read as glass: a bevel on the
  // panel, and on the round button too - which is glass from the boot by
  // stylesheet, and bends the page once the module has arrived with the menu.
  const bevel = (id) => page.evaluate((el) => getComputedStyle(document.getElementById(el)).boxShadow, id)
  assert.match(await bevel('menu'), /inset/, 'the menu should carry the bevel')
  assert.match(await bevel('button'), /inset/, 'the button should carry the bevel')
  await page.waitForFunction(() => document.getElementById('button').style.backdropFilter !== '')

  // The row takes all of it away again: inline style, filter definitions, root
  // class, translucent background — the opaque box it was before the feature.
  await page.locator('#menu-glass').click()
  await page.waitForFunction(() => document.getElementById('menu').style.backdropFilter === '')
  assert.equal(await page.locator('#menu-glass-label').textContent(), 'Glass: off')
  assert.equal(await page.evaluate(() => localStorage.getItem('textarea:glass')), 'off')
  assert.equal(await filters(), 0, 'the filter definitions should go with the effect')
  assert.equal(await menuAlpha(), 1, 'the menu should be opaque again')
  assert.equal(await page.evaluate(() => document.getElementById('button').style.backdropFilter), '')
  assert.doesNotMatch(await bevel('button'), /inset/, 'the button should be the flat one it was')

  // A dialog opened while it is off stays plain.
  await openMenu()
  await page.locator('#menu-export').click()
  assert.equal(await page.locator('dialog.dialog').evaluate((el) => el.style.backdropFilter), '')
  await page.keyboard.press('Escape')
  await page.locator('dialog.dialog').waitFor({state: 'detached'})

  // The choice survives a reload.
  await freshEditor()
  await openMenu()
  assert.equal(await page.locator('#menu-glass-label').textContent(), 'Glass: off')
  assert.equal(await page.evaluate(() => document.getElementById('menu').style.backdropFilter), '')

  // And back on without a reload: surfaces registered before the switch was
  // thrown pick the effect up again on their own.
  await page.locator('#menu-glass').click()
  await page.waitForFunction(() => document.getElementById('menu').style.backdropFilter !== '')
  assert.equal(await page.evaluate(() => localStorage.getItem('textarea:glass')), 'on')

  // A dialog opened while it is on gets a filter of its own, and takes that
  // filter definition away when it closes.
  await openMenu()
  await page.locator('#menu-export').click()
  // The dialog has to exist as well as carry the style: the panel behind this
  // entry is fetched on the click now, and a predicate of
  // `querySelector(...)?.style.x !== ''` reads the absence as a change.
  await page.waitForFunction(() => {
    const dialog = document.querySelector('dialog.dialog')
    return Boolean(dialog && dialog.style.backdropFilter !== '')
  })
  const withDialog = await filters()
  assert.ok(withDialog >= 2, `the menu and the dialog should each have a filter: ${withDialog}`)
  await page.keyboard.press('Escape')
  await page.locator('dialog.dialog').waitFor({state: 'detached'})
  assert.equal(await filters(), withDialog - 1, 'the dialog takes its filter definition with it')

  // A reader who asks for reduced transparency gets the opaque app back and is
  // not offered a row for the effect — even with the preference stored on.
  // Playwright's emulateMedia does not know this media feature, so it is asked
  // for over the DevTools protocol.
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [{name: 'prefers-reduced-transparency', value: 'reduce'}],
  })
  await freshEditor()
  await openMenu()
  assert.ok(await page.locator('#menu-glass').isHidden(), 'the row should not be offered')
  assert.equal(await page.evaluate(() => document.getElementById('menu').style.backdropFilter), '')
  assert.equal(
    await page.evaluate(() => document.documentElement.classList.contains('glass')),
    false,
  )
  assert.equal(await menuAlpha(), 1, 'the panels stay opaque under reduced transparency')

  await cdp.send('Emulation.setEmulatedMedia', {features: []})
  await freshEditor()
  await openMenu()
  assert.ok(await page.locator('#menu-glass').isVisible(), 'the row comes back with the setting')
  assert.equal(await page.locator('#menu-glass-label').textContent(), 'Glass: on')

  // Leave the menu closed and the preference at its default for what follows.
  await page.keyboard.press('Escape')
  await page.locator('#menu').waitFor({state: 'hidden'})
})

chromiumOnly("the settings panel carries the menu's switches and writes the same preferences", async () => {
  // The panel is the whole picture of what the menu carries, so it starts
  // from the shipped default rather than whatever the last test left.
  await page.evaluate(() => localStorage.removeItem('textarea:file-links'))

  await openMenu()
  await page.locator('#menu-settings').click()
  const panel = page.locator('dialog.dialog-settings')
  await panel.waitFor({state: 'visible'})

  for (const id of ['setting-glass', 'setting-stats', 'setting-columns', 'setting-filelinks']) {
    assert.equal(await panel.locator('#' + id).count(), 1, `${id} should be in the panel`)
  }

  // Flipping it here flips it everywhere: the same preference the menu row
  // reads, and the same row it drives.
  assert.equal(await panel.locator('#setting-filelinks').isChecked(), true)
  await panel.locator('#setting-filelinks').uncheck()
  assert.equal(await page.evaluate(() => localStorage.getItem('textarea:file-links')), 'off')

  await page.keyboard.press('Escape')
  await panel.waitFor({state: 'detached'})
  await openMenu()
  assert.equal(await page.locator('#menu-filelinks').getAttribute('aria-checked'), 'false')
  assert.match(await page.locator('#menu-filelinks-label').textContent(), /File links: off/)
  assert.equal(await page.locator('#menu-filelink').isVisible(), false)

  // Reopening the panel finds the switch where the menu left it.
  await page.keyboard.press('Escape')
  await page.locator('#menu').waitFor({state: 'hidden'})
  await openMenu()
  await page.locator('#menu-settings').click()
  await panel.waitFor({state: 'visible'})
  assert.equal(await panel.locator('#setting-filelinks').isChecked(), false)

  // Put back the way the test found it: the default, not a stored "on".
  await panel.locator('#setting-filelinks').check()
  assert.notEqual(await page.evaluate(() => localStorage.getItem('textarea:file-links')), 'off')
  await page.keyboard.press('Escape')
  await panel.waitFor({state: 'detached'})
  await page.evaluate(() => localStorage.removeItem('textarea:file-links'))
})

test('the appearance choices reach the stylesheet and survive a reload', async () => {
  await openMenu()
  await page.locator('#menu-settings').click()
  const panel = page.locator('dialog.dialog-settings')
  await panel.waitFor({state: 'visible'})

  // The accent is a switch and a colour: the colour input has no way to say
  // "none", so the switch is thrown first.
  await panel.locator('#setting-accent-custom').check()
  await panel.locator('#setting-accent').evaluate((input) => {
    input.value = '#ff0000'
    input.dispatchEvent(new Event('input', {bubbles: true}))
  })
  await panel.locator('#setting-font').selectOption('serif')
  await panel.locator('#setting-size').evaluate((input) => {
    input.value = '26'
    input.dispatchEvent(new Event('input', {bubbles: true}))
  })
  await panel.locator('#setting-leading').evaluate((input) => {
    input.value = '2'
    input.dispatchEvent(new Event('input', {bubbles: true}))
  })

  const applied = () =>
    page.evaluate(() => {
      const root = document.documentElement.style
      return {
        outline: root.getPropertyValue('--outline'),
        link: root.getPropertyValue('--link'),
        font: root.getPropertyValue('--note-font'),
        size: root.getPropertyValue('--note-size'),
        leading: root.getPropertyValue('--note-leading'),
        rendered: getComputedStyle(document.querySelector('article')).fontSize,
      }
    })

  assert.deepEqual(await applied(), {
    outline: '#ff0000',
    link: '#ff0000',
    font: 'serif',
    size: '26px',
    leading: '2',
    rendered: '26px',
  })

  // A preference, not a preview: the boot picks it up after a reload.
  await page.keyboard.press('Escape')
  await panel.waitFor({state: 'detached'})
  await freshEditor()
  const afterReload = await applied()
  assert.equal(afterReload.outline, '#ff0000')
  assert.equal(afterReload.size, '26px')
  assert.equal(afterReload.rendered, '26px')

  // Reset takes every override back off - the inline properties and the
  // stored keys together - so the note is the shipped 18px again.
  await openMenu()
  await page.locator('#menu-settings').click()
  await panel.waitFor({state: 'visible'})
  await panel.locator('#setting-reset').click()
  assert.deepEqual(await applied(), {
    outline: '',
    link: '',
    font: '',
    size: '',
    leading: '',
    rendered: '18px',
  })
  assert.equal(
    await page.evaluate(() =>
      ['textarea:accent', 'textarea:font', 'textarea:note-size', 'textarea:note-leading'].every(
        (key) => localStorage.getItem(key) === null,
      ),
    ),
    true,
    'the stored choices should be gone too',
  )

  await page.keyboard.press('Escape')
  await panel.waitFor({state: 'detached'})
})

test('a custom font file joins the note fonts, applies, survives a reload, and comes off', async () => {
  // The shelf starts empty and the switch starts on, whatever the tests
  // around this one left behind.
  await page.evaluate(async () => {
    const fonts = await import('/lib/fonts.js')
    for (const record of await fonts.listFonts()) await fonts.removeFont(record.id)
    localStorage.removeItem('textarea:font')
    localStorage.removeItem('textarea:custom-fonts')
  })

  await openMenu()
  await page.locator('#menu-settings').click()
  const panel = page.locator('dialog.dialog-settings')
  await panel.waitFor({state: 'visible'})

  assert.equal(await panel.locator('#setting-custom-fonts').isChecked(), true, 'the shelf ships on')
  assert.equal(
    await panel.locator('#setting-font option').count(),
    3,
    'only the three system stacks, before anything is uploaded',
  )

  // A file that only claims to be a font: refused with a message, and the
  // shelf stays empty. The judge is the browser itself - sniffing would
  // stop this one earlier, and does - but the promise is that nothing
  // unusable is ever stored.
  const broken = join(DOWNLOADS, 'broken.ttf')
  await fs.writeFile(broken, 'this is not a font')
  const refused = await notification(() =>
    panel.locator('#setting-font-file').setInputFiles(broken),
  )
  assert.equal(refused.isError, true, 'the refusal is an error message')
  assert.match(refused.text, /not a font/i)
  assert.equal(await panel.locator('#setting-font option[value^="custom-"]').count(), 0)

  // The real thing, uploaded under a name that will be its family.
  const fixture = join(DOWNLOADS, 'fixture.ttf')
  await fs.writeFile(fixture, await fs.readFile(new URL('../fixtures/Silkscreen-Regular.ttf', import.meta.url)))
  const added = await notification(() => panel.locator('#setting-font-file').setInputFiles(fixture))
  assert.equal(added.isError, false, 'a real font is accepted')
  assert.match(added.text, /Added/)
  assert.match(added.text, /fixture/)

  assert.equal(
    await panel.locator('#setting-font option[value="custom-fixture"]').count(),
    1,
    'the shelf offers it beside the system stacks',
  )
  const applied = () =>
    page.evaluate(() => document.documentElement.style.getPropertyValue('--note-font'))

  await panel.locator('#setting-font').selectOption('custom-fixture')
  assert.equal(await applied(), '"fixture", system-ui', 'the note takes the family, quoted')
  assert.equal(
    await page.evaluate(() => localStorage.getItem('textarea:font')),
    'custom-fixture',
    'and remembers it like any other choice',
  )

  // Switching the feature off does more than hide the rows: the note falls
  // back to a system stack, so the screen agrees with the switch.
  await panel.locator('#setting-custom-fonts').uncheck()
  assert.equal(await page.evaluate(() => localStorage.getItem('textarea:custom-fonts')), 'off')
  assert.equal(await applied(), 'system-ui', 'the note falls back while the feature is off')
  await panel
    .locator('#setting-font option[value^="custom-"]')
    .waitFor({state: 'detached', timeout: 10_000})
  assert.equal(await panel.locator('#setting-font').inputValue(), 'system')
  assert.equal(
    await panel.locator('#setting-font-file').isVisible(),
    false,
    'the shelf is hidden behind its switch',
  )

  // Back on: the font files were never deleted, only not applied.
  await panel.locator('#setting-custom-fonts').check()
  await panel.locator('#setting-font option[value="custom-fixture"]').waitFor({state: 'attached'})
  await panel.locator('#setting-font').selectOption('custom-fixture')
  assert.equal(await applied(), '"fixture", system-ui')

  // A preference, not a preview: the boot reads the shelf again after a
  // reload and re-registers the face.
  await page.keyboard.press('Escape')
  await panel.waitFor({state: 'detached'})
  await freshEditor()
  await page.waitForFunction(
    () => document.documentElement.style.getPropertyValue('--note-font') === '"fixture", system-ui',
  )
  await page.waitForFunction(() => [...document.fonts].some((face) => face.family === 'fixture'))

  // A font left on the shelf by an earlier session, with the note on a
  // system stack: the boot loads no face, so picking it in Settings has to.
  const registered = () =>
    page.evaluate(() => [...document.fonts].some((face) => face.family === 'fixture'))
  await page.evaluate(() => localStorage.setItem('textarea:font', 'system'))
  await freshEditor()
  assert.equal(await registered(), false, 'a font the note does not use is not loaded at boot')
  await openMenu()
  await page.locator('#menu-settings').click()
  await panel.waitFor({state: 'visible'})
  await panel.locator('#setting-font').selectOption('custom-fixture')
  await page.waitForFunction(() => [...document.fonts].some((face) => face.family === 'fixture'))
  assert.equal(await applied(), '"fixture", system-ui')

  // Picking it again does not register a second face.
  await panel.locator('#setting-font').selectOption('system')
  await panel.locator('#setting-font').selectOption('custom-fixture')
  await page.waitForFunction(
    () => document.documentElement.style.getPropertyValue('--note-font') === '"fixture", system-ui',
  )
  assert.equal(
    await page.evaluate(() => [...document.fonts].filter((face) => face.family === 'fixture').length),
    1,
  )

  // Removing it takes the choice back to the default in the same breath -
  // a family with no shelf behind it must not stay the stored preference.
  assert.equal(await panel.locator('#setting-font').inputValue(), 'custom-fixture')
  const removed = await notification(() =>
    panel.getByRole('button', {name: 'Remove fixture'}).click(),
  )
  assert.match(removed.text, /Removed/)
  assert.equal(await panel.locator('#setting-font').inputValue(), 'system')
  assert.equal(await applied(), 'system-ui')
  assert.equal(await panel.locator('#setting-font option[value^="custom-"]').count(), 0)
  assert.equal(await registered(), false, 'the face leaves the document with the font')

  await page.keyboard.press('Escape')
  await panel.waitFor({state: 'detached'})
  await page.evaluate(() => localStorage.removeItem('textarea:font'))
})

notWebkit('a font can be imported from a public GitHub link, and only from GitHub', async () => {
  // The shelf starts empty, as the upload test left it.
  await page.evaluate(async () => {
    const fonts = await import('/lib/fonts.js')
    for (const record of await fonts.listFonts()) await fonts.removeFont(record.id)
    localStorage.removeItem('textarea:font')
    localStorage.removeItem('textarea:custom-fonts')
  })

  const fixture = await fs.readFile(new URL('../fixtures/Silkscreen-Regular.ttf', import.meta.url))
  const requested = []
  await page.route('https://raw.githubusercontent.com/**', async (route) => {
    requested.push(route.request().url())
    await route.fulfill({
      status: 200,
      headers: {'content-type': 'font/ttf', 'access-control-allow-origin': '*'},
      body: fixture,
    })
  })

  try {
    await openMenu()
    await page.locator('#menu-settings').click()
    const panel = page.locator('dialog.dialog-settings')
    await panel.waitFor({state: 'visible'})

    // A link GitHub does not serve is turned down by the checker with the
    // message that says which rule refused it - and nothing was asked for
    // first: the policy allows one host, and this is the function that
    // keeps the promise the policy makes.
    const refused = await notification(async () => {
      await panel.locator('#setting-font-url').fill('https://example.com/fonts/Good.ttf')
      await panel.locator('#setting-font-import').click()
    })
    assert.equal(refused.isError, true, 'a wrong host is an error')
    assert.match(refused.text, /not a link/)
    assert.deepEqual(requested, [], 'a refused link is never asked for')

    // The blob page and the raw file are the same file: the rewrite
    // happens before the fetch, so the one request the policy allows is
    // the one that comes back with bytes.
    const added = await notification(async () => {
      await panel
        .locator('#setting-font-url')
        .fill('https://github.com/google/fonts/blob/main/ofl/silkscreen/Silkscreen-Regular.ttf')
      await panel.locator('#setting-font-import').click()
    })
    assert.equal(added.isError, false, 'the real link is accepted')
    assert.match(added.text, /Silkscreen-Regular/)
    assert.deepEqual(requested, [
      'https://raw.githubusercontent.com/google/fonts/main/ofl/silkscreen/Silkscreen-Regular.ttf',
    ])
    assert.equal(
      await panel.locator('#setting-font option[value="custom-silkscreen-regular"]').count(),
      1,
      'the shelf offers the imported family beside the system stacks',
    )
    assert.equal(
      await panel.locator('#setting-font-url').inputValue(),
      '',
      'the field is ready for the next link',
    )

    await page.keyboard.press('Escape')
    await panel.waitFor({state: 'detached'})
  } finally {
    await page.unroute('https://raw.githubusercontent.com/**')
    await page.evaluate(async () => {
      const fonts = await import('/lib/fonts.js')
      for (const record of await fonts.listFonts()) await fonts.removeFont(record.id)
      localStorage.removeItem('textarea:font')
      localStorage.removeItem('textarea:custom-fonts')
    })
  }
})

test('a settings option can be a line of text, written once and read back', async () => {
  // No shipped feature carries free text yet - the writing tools'
  // custom instructions will be the first - so the panel is opened with a
  // fake feature to prove the kind on its own: the sentence goes in, the
  // setter sees exactly what was typed, and what the setter then said it
  // stored is what the field shows again, the way every other kind behaves.
  await page.evaluate(async () => {
    const {showSettingsPanel} = await import('/lib/settings-panel.js')
    window.__textOption = {raw: null, stored: 'brushed up prose'}
    showSettingsPanel({
      features: [
        {
          id: 'fake-text',
          label: 'Sentence feature',
          get: () => true,
          set: () => {},
          options: [
            {
              id: 'sentence',
              label: 'How to write',
              kind: 'text',
              placeholder: 'e.g. keep it short',
              get: () => window.__textOption.stored,
              set: (value) => {
                window.__textOption.raw = value
                window.__textOption.stored = value.trim()
              },
            },
          ],
        },
      ],
    })
  })

  const dialog = page.locator('dialog.dialog-settings')
  await dialog.waitFor({state: 'visible'})
  const field = dialog.locator('#setting-fake-text-sentence')
  assert.equal(await field.getAttribute('placeholder'), 'e.g. keep it short')
  assert.equal(await field.inputValue(), 'brushed up prose', 'the stored sentence starts in the field')

  // Typed, then left - the change event is what writes, not every keystroke.
  await field.fill('  short and plain  ')
  assert.equal(
    await page.evaluate(() => window.__textOption.raw),
    null,
    'typing alone must not write the preference',
  )
  await page.keyboard.press('Tab')

  const written = await page.evaluate(() => window.__textOption)
  assert.equal(written.raw, '  short and plain  ', 'the setter sees what was typed, unedited')
  assert.equal(
    await field.inputValue(),
    'short and plain',
    'the field shows what the setter stored, not what was typed',
  )

  await page.keyboard.press('Escape')
  await dialog.waitFor({state: 'detached'})
  await page.evaluate(() => delete window.__textOption)
})

test('a wikilink opens the note its title names, and stays text while it is switched off', async () => {
  // textarea-plus ships the switch on, so this starts it off on purpose: what
  // is under test is the switch and what it changes.
  await page.evaluate(() => {
    localStorage.setItem('textarea:wikilinks', 'off')
    localStorage.removeItem('textarea:wikilink-create')
  })

  const stored = (needle) =>
    page.evaluate(async (want) => {
      const library = await import('/lib/library.js')
      const entries = await library.listDocuments()
      return entries.some((entry) => entry.title === want)
    }, needle)
  const settings = page.locator('dialog.dialog-settings')
  const openSettings = async () => {
    await openMenu()
    await page.locator('#menu-settings').click()
    await settings.waitFor({state: 'visible'})
  }
  const closeSettings = async () => {
    await page.keyboard.press('Escape')
    await settings.waitFor({state: 'detached'})
  }
  const openFromLibrary = async (name) => {
    await openMenu()
    await page.locator('#menu-documents').click()
    const library = page.locator('dialog.dialog-library')
    await library.waitFor({state: 'visible'})
    await library.getByRole('button', {name}).click()
    await page.locator('dialog.dialog[aria-label="Replace the current note?"]').waitFor({
      state: 'visible',
    })
    await page.locator('.dialog-button-primary').click()
  }

  // Two notes: Beta is on screen holding the links, Alpha is one of the
  // titles they name. The link is typed in the other case on purpose: a
  // title match is case insensitive, the way the documents panel is.
  await setNote('# Beta\n\nSee [[alpha]] and [[Ghost]].')
  await until(
    async () => {
      const library = await import('/lib/library.js')
      const entries = await library.listDocuments()
      return entries.some((entry) => entry.title === 'Beta')
    },
    {what: 'Beta to be stored'},
  )

  await openMenu()
  await page.locator('#menu-documents').click()
  const panel = page.locator('dialog.dialog-library')
  await panel.waitFor({state: 'visible'})
  await panel.getByRole('button', {name: 'New note'}).click()
  await page.locator('dialog.dialog[aria-label="Start a new note?"]').waitFor({state: 'visible'})
  await page.locator('.dialog-button-primary').click()
  await setNote('# Alpha\n\nThe target.')
  await until(
    async () => {
      const library = await import('/lib/library.js')
      const entries = await library.listDocuments()
      return entries.some((entry) => entry.title === 'Alpha')
    },
    {what: 'Alpha to be stored'},
  )

  await openFromLibrary(/Open Beta/)
  await until(
    () => document.querySelector('article').textContent.includes('[[alpha]]'),
    {what: 'Beta to be back on screen'},
  )

  // Off: the brackets are only brackets.
  assert.equal(await page.locator('.md-wiki').count(), 0, 'the switch starts off')

  // The switch and its choice live in the settings panel, and the choice is
  // not offered while the switch it belongs to is off.
  await openSettings()
  assert.equal(await settings.locator('#setting-wikilinks').isChecked(), false)
  assert.equal(await settings.locator('#setting-wikilinks-create').isVisible(), false)
  await settings.locator('#setting-wikilinks').check()
  assert.equal(await settings.locator('#setting-wikilinks-create').isVisible(), true)
  await closeSettings()

  // Now both tokens are links. textarea-plus: following one lands on the note
  // its title names without a question, since the note on screen is kept.
  assert.equal(await page.locator('.md-wiki').count(), 2)
  await page.locator('.md-wiki', {hasText: 'alpha'}).click()
  await until(
    () => document.querySelector('article').textContent.includes('The target.'),
    {what: 'Alpha to open from the link'},
  )
  assert.equal(await page.locator('dialog.dialog').count(), 0, 'opened without asking')

  // Back to Beta for the other half: what a title that matches nothing does
  // is the reader's choice under the switch.
  await openFromLibrary(/Open Beta/)
  await until(
    () => document.querySelector('article').textContent.includes('[[Ghost]]'),
    {what: 'Beta to be back on screen'},
  )

  await openSettings()
  await settings.locator('#setting-wikilinks-create').uncheck()
  await closeSettings()
  const refused = await notification(() => page.locator('.md-wiki', {hasText: 'Ghost'}).click())
  assert.match(refused.text, /No note is titled/)
  assert.equal(await stored('Ghost'), false, 'a refused click writes nothing')

  await openSettings()
  await settings.locator('#setting-wikilinks-create').check()
  await closeSettings()
  await page.locator('.md-wiki', {hasText: 'Ghost'}).click()
  await until(
    () => document.querySelector('article').textContent === '# Ghost',
    {what: 'the new note to carry its heading'},
  )
  await until(
    async () => {
      const library = await import('/lib/library.js')
      const entries = await library.listDocuments()
      return entries.some((entry) => entry.title === 'Ghost')
    },
    {what: 'the created note to reach the library'},
  )

  // Leave the switches at what ships.
  await page.evaluate(() => {
    localStorage.removeItem('textarea:wikilinks')
    localStorage.removeItem('textarea:wikilink-create')
  })
})

test('a backlinks panel counts the notes that reach this one, and only while it is on', async () => {
  // Both preferences start from the shipped default, whatever an interrupted
  // run left behind.
  await page.evaluate(() => {
    localStorage.removeItem('textarea:backlinks')
    localStorage.removeItem('textarea:backlink-mentions')
  })

  const pref = (key) => page.evaluate((k) => localStorage.getItem(k), key)
  // Node side, so the title can travel as an argument: `until` runs its
  // predicate inside the page, where a closed-over variable does not exist.
  const stored = (needle) =>
    page.evaluate(async (want) => {
      const library = await import('/lib/library.js')
      const entries = await library.listDocuments()
      return entries.some((entry) => entry.title === want)
    }, needle)
  const hasTitle = async (title) => {
    const deadline = Date.now() + 30_000
    while (!(await stored(title))) {
      if (Date.now() > deadline) throw new Error(`${title} never reached the library`)
      await page.waitForTimeout(40)
    }
  }
  const backlinks = page.locator('#backlinks-panel')
  const menuRow = page.locator('#menu-backlinks')
  const settings = page.locator('dialog.dialog-settings')
  const openSettings = async () => {
    await openMenu()
    await page.locator('#menu-settings').click()
    await settings.waitFor({state: 'visible'})
  }
  const closeSettings = async () => {
    await page.keyboard.press('Escape')
    await settings.waitFor({state: 'detached'})
  }
  const openFromLibrary = async (name) => {
    await openMenu()
    await page.locator('#menu-documents').click()
    const library = page.locator('dialog.dialog-library')
    await library.waitFor({state: 'visible'})
    await library.getByRole('button', {name}).click()
    await page.locator('dialog.dialog[aria-label="Replace the current note?"]').waitFor({
      state: 'visible',
    })
    await page.locator('.dialog-button-primary').click()
  }
  const newNote = async (text) => {
    await openMenu()
    await page.locator('#menu-documents').click()
    const library = page.locator('dialog.dialog-library')
    await library.waitFor({state: 'visible'})
    await library.getByRole('button', {name: 'New note'}).click()
    await page.locator('dialog.dialog[aria-label="Start a new note?"]').waitFor({
      state: 'visible',
    })
    await page.locator('.dialog-button-primary').click()
    await setNote(text)
  }

  // Three notes: Alpha on screen is the title being asked about, Beta links
  // to it, and Gamma only says its name in passing.
  await setNote('# Alpha\n\nThe note being linked to.')
  await hasTitle('Alpha')
  await newNote('# Beta\n\nLinks back with [[alpha]].')
  await hasTitle('Beta')
  await newNote('# Gamma\n\nMentions Alpha in passing.')
  await hasTitle('Gamma')

  await openFromLibrary(/Open Alpha/)
  await until(
    () => document.querySelector('article').textContent.includes('The note being linked to.'),
    {what: 'Alpha to be back on screen'},
  )

  // The panel has never been wanted, so it has never even been built - and
  // the switch in the settings panel reads that absence without minding.
  assert.equal(await backlinks.count(), 0, 'the panel is not built until it is wanted')
  assert.equal(await menuRow.getAttribute('aria-checked'), 'false', 'the row starts off')
  await openSettings()
  assert.equal(
    await settings.locator('#setting-backlinks').isChecked(),
    false,
    'the switch reads the panel rather than a preference',
  )
  assert.equal(
    await settings.locator('#setting-backlinks-mentions').isVisible(),
    false,
    'no behaviour is offered while the panel is off',
  )
  await closeSettings()

  // The menu row builds it and opens it.
  await openMenu()
  await menuRow.click()
  await backlinks.waitFor({state: 'visible'})
  await until(() => document.querySelectorAll('.backlink-row').length === 1, {
    what: 'Beta to be listed',
  })
  assert.equal(await backlinks.locator('.backlink-name').textContent(), 'Beta')
  assert.equal(
    await backlinks.locator('.backlink-kind').count(),
    0,
    'a link is not labelled a mention',
  )
  assert.equal(await menuRow.getAttribute('aria-checked'), 'true')
  assert.equal(await pref('textarea:backlinks'), 'on', 'the row remembers itself')

  // The switch in the settings panel is the same switch as the row, and the
  // behaviour underneath it is offered now that it is on.
  await openSettings()
  assert.equal(await settings.locator('#setting-backlinks').isChecked(), true)
  await settings.locator('#setting-backlinks-mentions').check()
  await closeSettings()

  // Gamma's plain prose joins the list, labelled for what it is.
  await until(() => document.querySelectorAll('.backlink-row').length === 2, {
    what: 'the mention to be counted',
  })
  assert.equal(await backlinks.locator('.backlink-kind').count(), 1, 'exactly one mention')
  assert.equal(
    await backlinks.locator('.backlink-kind').textContent(),
    'mention',
    'a mention never passes for a link',
  )
  assert.equal(await pref('textarea:backlink-mentions'), 'on')

  // Following a backlink opens the note, and the panel answers for the note
  // that is on screen rather than keeping its old answer.
  await backlinks.locator('.backlink-open', {hasText: 'Beta'}).click()
  await page.locator('dialog.dialog[aria-label="Replace the current note?"]').waitFor({
    state: 'visible',
  })
  await page.locator('.dialog-button-primary').click()
  await until(
    () => document.querySelector('article').textContent.includes('Links back with [[alpha]]'),
    {what: 'Beta to open from the backlink'},
  )
  await until(
    () => {
      const empty = document.querySelector('#backlinks-panel .backlinks-empty')
      return Boolean(empty) && !empty.hidden && empty.textContent.includes('Nothing links')
    },
    {what: 'Beta to answer with nothing'},
  )

  // The row closes the panel again and gives the preference back the same way.
  await openMenu()
  await menuRow.click()
  await backlinks.waitFor({state: 'hidden'})
  assert.equal(await menuRow.getAttribute('aria-checked'), 'false')
  assert.equal(await pref('textarea:backlinks'), 'off', 'the row remembers closed too')

  // Leave the switches as they were found: off, and not counting mentions.
  await page.evaluate(() => {
    localStorage.removeItem('textarea:backlinks')
    localStorage.removeItem('textarea:backlink-mentions')
  })
})

test('the quick switcher jumps to a note from the keyboard and can be switched off', async () => {
  // The shipped defaults, whatever an interrupted run left behind.
  await page.evaluate(() => {
    localStorage.removeItem('textarea:switcher')
    localStorage.removeItem('textarea:switcher-scope')
    localStorage.removeItem('textarea:switcher-shortcut')
  })

  const pref = (key) => page.evaluate((k) => localStorage.getItem(k), key)
  // Node side, so the title can travel as an argument: `until` runs its
  // predicate inside the page, where a closed-over variable does not exist.
  const hasTitle = async (title) => {
    const deadline = Date.now() + 30_000
    for (;;) {
      const stored = await page.evaluate(async (want) => {
        const library = await import('/lib/library.js')
        const entries = await library.listDocuments()
        return entries.some((entry) => entry.title === want)
      }, title)
      if (stored) return
      if (Date.now() > deadline) throw new Error(`${title} never reached the library`)
      await page.waitForTimeout(40)
    }
  }
  const palette = page.locator('dialog.dialog-switcher')
  const settings = page.locator('dialog.dialog-settings')
  const openSettings = async () => {
    await openMenu()
    await page.locator('#menu-settings').click()
    await settings.waitFor({state: 'visible'})
  }
  const closeSettings = async () => {
    await page.keyboard.press('Escape')
    await settings.waitFor({state: 'detached'})
  }
  const openFromLibrary = async (name) => {
    await openMenu()
    await page.locator('#menu-documents').click()
    const library = page.locator('dialog.dialog-library')
    await library.waitFor({state: 'visible'})
    await library.getByRole('button', {name}).click()
    await page.locator('dialog.dialog[aria-label="Replace the current note?"]').waitFor({
      state: 'visible',
    })
    await page.locator('.dialog-button-primary').click()
  }
  const newNote = async (text) => {
    await openMenu()
    await page.locator('#menu-documents').click()
    const library = page.locator('dialog.dialog-library')
    await library.waitFor({state: 'visible'})
    await library.getByRole('button', {name: 'New note'}).click()
    await page.locator('dialog.dialog[aria-label="Start a new note?"]').waitFor({
      state: 'visible',
    })
    await page.locator('.dialog-button-primary').click()
    await setNote(text)
  }
  const jump = async (key) => {
    await page.keyboard.press(key)
    await palette.waitFor({state: 'visible'})
  }
  // textarea-plus: the note on screen is already in the library, so the
  // switcher opens the next one without asking, the way the sidebar and the
  // tabs do. Checked once the note has opened, when a question would be up.
  const askedNothing = async () => {
    assert.equal(
      await page.locator('dialog.dialog[aria-label="Replace the current note?"]').count(),
      0,
      'opened without asking',
    )
  }

  // Two notes to jump between; Beta's text carries a phrase its title does
  // not, which is what the scope choice is for.
  await setNote('# Alpha\n\nThe quiet one.')
  await hasTitle('Alpha')
  await newNote('# Beta\n\nHolds xylophone in the text.')
  await hasTitle('Beta')
  await openFromLibrary(/Open Alpha/)
  await until(
    () => document.querySelector('article').textContent.includes('The quiet one.'),
    {what: 'Alpha to be on screen'},
  )

  // The chord lands with the caret already in the filter.
  await jump('Control+k')
  assert.equal(
    await page.evaluate(
      () => document.activeElement === document.querySelector('dialog.dialog-switcher input'),
    ),
    true,
    'the caret starts in the filter',
  )

  // A few letters, one match, already active - Enter opens it, after the
  // same confirm the documents panel asks before replacing the screen.
  await page.keyboard.type('bet')
  await until(
    () => document.querySelectorAll('dialog.dialog-switcher [role="option"]').length === 1,
    {what: 'one match'},
  )
  assert.equal(await palette.locator('.switcher-name').textContent(), 'Beta')
  assert.equal(
    await palette.locator('[role="option"]').getAttribute('aria-selected'),
    'true',
    'the only match is already the active one',
  )
  await page.keyboard.press('Enter')
  await until(
    () => document.querySelector('article').textContent.includes('Holds xylophone'),
    {what: 'Beta to open from the palette'},
  )
  await askedNothing()

  // Escape puts it away without opening anything.
  await jump('Control+k')
  await page.keyboard.press('Escape')
  await palette.waitFor({state: 'hidden'})

  // Back to Alpha for the scope half: titles only is the default, so a
  // phrase that lives only in Beta's text finds nothing.
  await openFromLibrary(/Open Alpha/)
  await until(
    () => document.querySelector('article').textContent.includes('The quiet one.'),
    {what: 'Alpha again'},
  )
  await jump('Control+k')
  await page.keyboard.type('xylophone')
  await until(
    () => {
      const empty = document.querySelector('dialog.dialog-switcher .switcher-empty')
      return Boolean(empty) && !empty.hidden
    },
    {what: 'the empty state for a text-only phrase'},
  )
  assert.equal(await palette.locator('[role="option"]').count(), 0, 'titles only finds no text')
  await page.keyboard.press('Escape')
  await palette.waitFor({state: 'hidden'})

  // The switch and its two choices live in settings, all offered while it
  // is on - and on by default, since the feature costs nothing until its
  // key is pressed.
  await openSettings()
  assert.equal(await settings.locator('#setting-switcher').isChecked(), true, 'on by default')
  assert.equal(await settings.locator('#setting-switcher-scope').isVisible(), true)
  assert.equal(await settings.locator('#setting-switcher-shortcut').isVisible(), true)
  await settings.locator('#setting-switcher-scope').selectOption('all')
  await closeSettings()

  // The wider scope finds Beta through its text, and shows the line it
  // hit so the reader can see why.
  await jump('Control+k')
  await page.keyboard.type('xylophone')
  await until(
    () => document.querySelectorAll('dialog.dialog-switcher [role="option"]').length === 1,
    {what: 'the text match to be listed'},
  )
  assert.match(await palette.locator('.switcher-hint').textContent(), /xylophone/)
  await page.keyboard.press('Enter')
  await until(
    () => document.querySelector('article').textContent.includes('Holds xylophone'),
    {what: 'Beta to open from the text match'},
  )
  await askedNothing()

  // Which chord carries it is a choice too: E instead of K, and the old
  // key stops being listened for the moment the choice moves.
  await openSettings()
  await settings.locator('#setting-switcher-shortcut').selectOption('e')
  await closeSettings()
  await page.keyboard.press('Control+k')
  assert.equal(await palette.isVisible(), false, 'the old chord opens nothing')
  await jump('Control+e')
  await page.keyboard.press('Escape')
  await palette.waitFor({state: 'hidden'})

  // And the whole feature leaves with one switch: no chord answers.
  await openSettings()
  await settings.locator('#setting-switcher').uncheck()
  await closeSettings()
  await page.keyboard.press('Control+e')
  assert.equal(await palette.isVisible(), false, 'a switched-off feature answers nothing')
  assert.equal(await pref('textarea:switcher'), 'off')

  // Leave the settings as they were found: on, titles, and K.
  await page.evaluate(() => {
    localStorage.removeItem('textarea:switcher')
    localStorage.removeItem('textarea:switcher-scope')
    localStorage.removeItem('textarea:switcher-shortcut')
  })
})

test('find claims Ctrl+F, walks the matches, and replaces one or all', async () => {
  // The shipped defaults, whatever an interrupted run left behind.
  await page.evaluate(() => {
    localStorage.removeItem('textarea:find')
    localStorage.removeItem('textarea:find-case')
    localStorage.removeItem('textarea:find-words')
  })

  const bar = page.locator('dialog.dialog-find')
  // Where in the note the selection sits, read off the app's own
  // editor.selection() - the same coordinates the bar walks with. Offsets,
  // not the selected text: every match here is the string "fox", and
  // Chromium reports the query box's own selection through getSelection
  // too, so comparing text would pass with the note's caret parked
  // anywhere. Offsets cannot be faked by the box, and they tell one match
  // from the next.
  const noteSelection = () =>
    page.evaluate(() => {
      const {start, end} = globalThis.textarea.editor.selection()
      return {start, end}
    })

  // Three foxes at 4, 16 and 26. The offsets are what makes the walk
  // checkable: match 1 and match 2 are both "fox", but they are not both
  // offset 4.
  await setNote('the fox and the fox and a foxhole')
  await saveNow()

  await page.keyboard.press('Control+f')
  await bar.waitFor({state: 'visible'})
  assert.equal(
    await page.evaluate(() => document.activeElement?.id),
    'find-query',
    'the query box has the caret',
  )

  await bar.locator('#find-query').fill('fox')
  assert.equal(await bar.locator('#find-count').textContent(), '1 of 3')
  assert.deepEqual(
    await noteSelection(),
    {start: 4, end: 7},
    'the first match is lit up in the note behind the bar',
  )

  await bar.locator('#find-query').press('Enter')
  assert.equal(await bar.locator('#find-count').textContent(), '2 of 3')
  assert.deepEqual(
    await noteSelection(),
    {start: 16, end: 19},
    'and the second one after Enter - a different fox, not the same one',
  )

  await bar.locator('#find-next').click()
  assert.equal(await bar.locator('#find-count').textContent(), '3 of 3')
  assert.deepEqual(await noteSelection(), {start: 26, end: 29}, 'the third match')
  await bar.locator('#find-next').click()
  assert.equal(await bar.locator('#find-count').textContent(), '1 of 3', 'the walk wraps')
  assert.deepEqual(await noteSelection(), {start: 4, end: 7}, 'back to the first match')
  await bar.locator('#find-prev').click()
  assert.equal(await bar.locator('#find-count').textContent(), '3 of 3', 'and wraps the other way')
  assert.deepEqual(await noteSelection(), {start: 26, end: 29})

  // Back to the first match, and replace just it.
  await bar.locator('#find-query').press('Enter')
  assert.equal(await bar.locator('#find-count').textContent(), '1 of 3')
  assert.deepEqual(await noteSelection(), {start: 4, end: 7})
  await bar.locator('#find-replace').fill('cat')
  await bar.locator('#find-replace-one').click()
  assert.equal(
    await page.evaluate(() => document.querySelector('article').textContent),
    'the cat and the fox and a foxhole',
  )
  assert.equal(await bar.locator('#find-count').textContent(), '1 of 2', 'the list follows the note')

  // And replace the rest in one step, which the bubble counts.
  const done = await notification(() => bar.locator('#find-replace-all').click())
  assert.equal(done.isError, false)
  assert.match(done.text, /Replaced 2 matches/)
  assert.equal(
    await page.evaluate(() => document.querySelector('article').textContent),
    'the cat and the cat and a cathole',
  )
  assert.equal(await bar.locator('#find-count').textContent(), 'No matches')
  assert.equal(await bar.locator('#find-replace-all').isDisabled(), true, 'nothing left to act on')

  await page.keyboard.press('Escape')
  // Hidden, not detached: the bar is built once and reused, so closing only
  // drops the open attribute - unlike the panels dialog.js builds, which
  // remove themselves and are waited for as detached.
  await bar.waitFor({state: 'hidden'})

  await page.evaluate(() => {
    localStorage.removeItem('textarea:find')
    localStorage.removeItem('textarea:find-case')
    localStorage.removeItem('textarea:find-words')
  })
})

test('the find switch and its two defaults are the reader’s, and persist', async () => {
  await page.evaluate(() => {
    localStorage.removeItem('textarea:find')
    localStorage.removeItem('textarea:find-case')
    localStorage.removeItem('textarea:find-words')
  })

  const pref = (key) => page.evaluate((k) => localStorage.getItem(k), key)
  const bar = page.locator('dialog.dialog-find')
  const settings = page.locator('dialog.dialog-settings')
  const openSettings = async () => {
    await openMenu()
    await page.locator('#menu-settings').click()
    await settings.waitFor({state: 'visible'})
  }
  const closeSettings = async () => {
    await page.keyboard.press('Escape')
    await settings.waitFor({state: 'detached'})
  }

  await setNote('A needle in a haystack')

  // The checkboxes in the bar write the preference…
  await page.keyboard.press('Control+f')
  await bar.waitFor({state: 'visible'})
  await bar.locator('#find-case').check()
  assert.equal(await pref('textarea:find-case'), 'on')
  await page.keyboard.press('Escape')
  await bar.waitFor({state: 'hidden'})

  // …which the bar reads again when it reopens…
  await page.keyboard.press('Control+f')
  await bar.waitFor({state: 'visible'})
  assert.equal(await bar.locator('#find-case').isChecked(), true, 'the bar remembers')
  await page.keyboard.press('Escape')
  await bar.waitFor({state: 'hidden'})

  // …and Settings points at the very same value, both ways.
  await openSettings()
  assert.equal(await settings.locator('#setting-find').isChecked(), true, 'the switch ships on')
  assert.equal(
    await settings.locator('#setting-find-case').isChecked(),
    true,
    'Settings reads what the bar wrote',
  )
  await settings.locator('#setting-find-case').uncheck()
  await closeSettings()
  await page.keyboard.press('Control+f')
  await bar.waitFor({state: 'visible'})
  assert.equal(await bar.locator('#find-case').isChecked(), false, 'Settings moved the bar')
  await page.keyboard.press('Escape')
  await bar.waitFor({state: 'hidden'})

  // Off goes the whole feature, chord and all: the browser keeps Ctrl+F.
  await openSettings()
  await settings.locator('#setting-find').uncheck()
  assert.equal(await pref('textarea:find'), 'off')
  await closeSettings()
  await page.keyboard.press('Control+f')
  assert.equal(await bar.isVisible(), false, 'a switched-off feature answers nothing')

  // Leave the settings as they were found.
  await page.evaluate(() => {
    localStorage.removeItem('textarea:find')
    localStorage.removeItem('textarea:find-case')
    localStorage.removeItem('textarea:find-words')
  })
})

test('the Backup row writes every note into one archive, front-mattered', async () => {
  await setNote('# Alpha\n\nfirst body')
  await until(
    async () => {
      const entries = await (await import('/lib/library.js')).listDocuments()
      return entries.length === 1 && entries.some((entry) => entry.text.includes('first body'))
    },
    {what: 'the first note to be stored'},
  )

  // A second note, made the way a reader makes one.
  await openMenu()
  await page.locator('#menu-documents').click()
  const panel = page.locator('dialog.dialog-library')
  await panel.waitFor({state: 'visible'})
  await panel.locator('.document-title').first().waitFor()
  await panel.getByRole('button', {name: 'New note'}).click()
  await page.locator('dialog.dialog[aria-label="Start a new note?"]').waitFor({state: 'visible'})
  await page.locator('.dialog-button-primary').click()
  await setNote('# Beta\n\nsecond body')
  // Waiting for the text rather than the row count: the row exists before the
  // 500ms save lands, and a snapshot taken then would hold the previous text.
  // The text arriving also means the debounce has fired, so no second save is
  // pending to move the timestamps after the archive is written.
  await until(
    async () => {
      const entries = await (await import('/lib/library.js')).listDocuments()
      return entries.length === 2 && entries.some((entry) => entry.text.includes('second body'))
    },
    {what: 'the second note to be stored'},
  )

  const before = await page.evaluate(async () =>
    (await (await import('/lib/library.js')).listDocuments()).map((entry) => ({
      id: entry.id,
      text: entry.text,
      updated: entry.updated,
    })),
  )

  await openMenu()
  let path = null
  const message = await notification(async () => {
    const [download] = await Promise.all([
      page.waitForEvent('download', {timeout: 60_000}),
      page.locator('#menu-backup').click(),
    ])
    path = join(DOWNLOADS, download.suggestedFilename())
    await download.saveAs(path)
  })
  assert.match(message.text, /Saved 2 notes in an archive/)

  // The handler saves before it archives, and that save stamps the note anew,
  // so the archive legitimately holds a moment later than any snapshot taken
  // before the click. The library read now is the same write the archive read:
  // the text-stable wait above means nothing else can have saved in between.
  const after = await page.evaluate(async () =>
    (await (await import('/lib/library.js')).listDocuments()).map((entry) => ({
      id: entry.id,
      text: entry.text,
      updated: entry.updated,
    })),
  )

  const files = await page.evaluate(
    async (base64) => {
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
      const {readZip} = await import('/lib/zip.js')
      const {parseNote} = await import('/lib/front-matter.js')
      const entries = await readZip(new Blob([bytes]))
      return entries.map((file) => {
        const parsed = parseNote(file.text)
        return {
          name: file.name,
          id: parsed.data?.id ?? null,
          updated: parsed.data?.updated ?? null,
          text: parsed.text,
        }
      })
    },
    (await fs.readFile(path)).toString('base64'),
  )

  assert.equal(files.length, 2, 'both notes are in the archive')
  assert.deepEqual(
    files.map((file) => file.name).sort(),
    ['Alpha.md', 'Beta.md'],
    'named by title, the way folder sync names them',
  )

  // Each file carries the block that makes it restorable: the id that says
  // which note it is, the text verbatim, and the timestamp the library holds
  // for it - compared against the read after the write, since the backup's
  // own save re-stamped the note a moment before the archive was built.
  for (const file of files) {
    const source = before.find((entry) => entry.id === file.id)
    assert.ok(source, `the block names a note that exists, got ${file.id}`)
    assert.equal(file.text, source.text, `${file.name} holds the text verbatim`)
    const current = after.find((entry) => entry.id === file.id)
    assert.ok(current, `the note is still in the library, got ${file.id}`)
    assert.equal(Number(file.updated), current.updated, `${file.name} carries the updated time`)
    assert.ok(
      Number(file.updated) >= Number(source.updated),
      `${file.name} is not stamped older than the note it came from`,
    )
  }

  await page.evaluate(() => localStorage.removeItem('textarea:backup'))
})

test('the Backup switch and its options are the reader’s, and the switch gates the row', async () => {
  const pref = (key) => page.evaluate((k) => localStorage.getItem(k), key)
  const settings = page.locator('dialog.dialog-settings')
  const openSettings = async () => {
    await openMenu()
    await page.locator('#menu-settings').click()
    await settings.waitFor({state: 'visible'})
  }
  const closeSettings = async () => {
    await page.keyboard.press('Escape')
    await settings.waitFor({state: 'detached'})
  }
  await page.evaluate(() => localStorage.removeItem('textarea:backup'))

  await setNote('# A note\n\nwith words to count')

  // The row is there by default, and Settings reads the switch on.
  await openMenu()
  assert.equal(await page.locator('#menu-backup').isVisible(), true, 'the row ships visible')
  await page.keyboard.press('Escape')
  await openSettings()
  assert.equal(await settings.locator('#setting-backup').isChecked(), true, 'the switch ships on')
  assert.equal(await settings.locator('#setting-backup-metadata').isChecked(), true, 'metadata ships on')
  assert.equal(await settings.locator('#setting-backup-encrypt').isChecked(), false, 'encrypt ships off')

  // The options are ordinary preferences: they write, and they persist.
  await settings.locator('#setting-backup-metadata').uncheck()
  await settings.locator('#setting-backup-encrypt').check()
  assert.equal(await pref('textarea:backup-metadata'), 'off', 'metadata wrote its own key')
  assert.equal(await pref('textarea:backup-encrypt'), 'on', 'encrypt wrote its own key')
  await closeSettings()

  // They read back the same way on a reopen, which is what persisting means.
  await openSettings()
  assert.equal(await settings.locator('#setting-backup-metadata').isChecked(), false, 'metadata stays off')
  assert.equal(await settings.locator('#setting-backup-encrypt').isChecked(), true, 'encrypt stays on')

  // The switch and the row travel together: off, the menu loses the row.
  await settings.locator('#setting-backup').uncheck()
  assert.equal(await pref('textarea:backup'), 'off')
  await closeSettings()
  await openMenu()
  assert.equal(await page.locator('#menu-backup').isVisible(), false, 'a switched-off row is gone')
  await page.keyboard.press('Escape')

  await openSettings()
  await settings.locator('#setting-backup').check()
  assert.equal(await pref('textarea:backup'), 'on')
  await closeSettings()
  await openMenu()
  assert.equal(await page.locator('#menu-backup').isVisible(), true, 'and back when asked for')
  await page.keyboard.press('Escape')

  // Leave the settings as they were found.
  await page.evaluate(() => {
    localStorage.removeItem('textarea:backup')
    localStorage.removeItem('textarea:backup-metadata')
    localStorage.removeItem('textarea:backup-encrypt')
  })
})

test('a Backup with metadata off writes bare text, and a password seals it', async () => {
  await setNote('# Bare\n\nno block wanted here')
  // The row exists before the 500ms save lands, so waiting on the count alone
  // would snapshot the empty note reset() left behind. Waiting for the text
  // means the save has happened - and that no second save is pending.
  await until(
    async () => {
      const entries = await (await import('/lib/library.js')).listDocuments()
      return entries.some((entry) => entry.text.includes('no block wanted here'))
    },
    {what: 'the note to be stored'},
  )
  const source = await page.evaluate(async () => {
    const [entry] = await (await import('/lib/library.js')).listDocuments()
    return {text: entry.text}
  })

  // Metadata off: the file is the note's text, nothing around it.
  await page.evaluate(() => {
    localStorage.setItem('textarea:backup-metadata', 'off')
    localStorage.setItem('textarea:backup-encrypt', 'off')
  })
  await openMenu()
  const [plain] = await Promise.all([
    page.waitForEvent('download', {timeout: 60_000}),
    page.locator('#menu-backup').click(),
  ])
  const plainPath = join(DOWNLOADS, plain.suggestedFilename())
  await plain.saveAs(plainPath)
  const plainFiles = await page.evaluate(
    async (base64) => {
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
      const {readZip} = await import('/lib/zip.js')
      return (await readZip(new Blob([bytes]))).map((file) => ({name: file.name, text: file.text}))
    },
    (await fs.readFile(plainPath)).toString('base64'),
  )
  assert.equal(plainFiles.length, 1)
  assert.equal(plainFiles[0].name, 'Bare.md', 'named the same either way')
  assert.equal(plainFiles[0].text, source.text, 'the bare text, verbatim')
  assert.ok(!plainFiles[0].text.startsWith('---'), 'and no front matter block')

  // Encrypt on: the row asks for a password, and what lands needs it.
  await page.evaluate(() => localStorage.setItem('textarea:backup-encrypt', 'on'))
  await openMenu()
  const pending = page.waitForEvent('download', {timeout: 60_000})
  await page.locator('#menu-backup').click()
  const prompt = page.locator('dialog.dialog[aria-label="Encrypt the archive"]')
  await prompt.waitFor({state: 'visible'})
  await fillDialog('Password', 'correct horse battery')
  await fillDialog('Repeat the password', 'correct horse battery')
  await prompt.locator('.dialog-button-primary').click()
  const sealed = await pending
  const sealedPath = join(DOWNLOADS, sealed.suggestedFilename())
  await sealed.saveAs(sealedPath)
  const bytes = await fs.readFile(sealedPath)
  assert.equal(bytes.readUInt16LE(8), 99, 'the same WinZip AES archive Export writes')
  const opened = await page.evaluate(
    async ({base64, password}) => {
      const raw = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
      const {readZip} = await import('/lib/zip.js')
      const files = await readZip(new Blob([raw]), {password})
      return files.map((file) => ({name: file.name, text: file.text ?? null, error: file.error ?? null}))
    },
    {base64: bytes.toString('base64'), password: 'correct horse battery'},
  )
  assert.equal(opened[0].error, null, 'the right password opens it')
  assert.equal(opened[0].text, source.text, 'and the note comes back whole')

  // Leave the settings as they were found.
  await page.evaluate(() => {
    localStorage.removeItem('textarea:backup-metadata')
    localStorage.removeItem('textarea:backup-encrypt')
  })
})

test('a deleted note waits in the trash and comes back whole', async () => {
  await setNote('# Hasty note\n\nwritten in a rush')
  // The text arriving means the 500ms save has fired, so no timer is left to
  // re-create the row behind the delete.
  await until(
    async () => {
      const entries = await (await import('/lib/library.js')).listDocuments()
      return entries.length === 1 && entries[0].text.includes('written in a rush')
    },
    {what: 'the note to be stored'},
  )
  const [original] = await page.evaluate(async () =>
    (await (await import('/lib/library.js')).listDocuments()).map((entry) => ({
      id: entry.id,
      text: entry.text,
    })),
  )

  // Delete it the way a reader does: panel, corner button, confirm.
  await openMenu()
  await page.locator('#menu-documents').click()
  const panel = page.locator('dialog.dialog-library[aria-label="My documents"]')
  await panel.waitFor({state: 'visible'})
  await panel.locator('.document-row:not(.document-row-empty)').first().waitFor()
  const message = await notification(async () => {
    await panel.locator('.document-delete').click()
    const confirm = page.locator('dialog.dialog-confirm')
    await confirm.waitFor({state: 'visible'})
    await confirm.getByRole('button', {name: 'Delete'}).click()
    await confirm.waitFor({state: 'detached'})
    await until(
      () =>
        document.querySelector('dialog[aria-label="My documents"] .document-title')?.textContent ===
        'No notes yet.',
      {what: 'the note to leave the documents list'},
    )
  })
  assert.match(message.text, /Moved Hasty note to the trash/)
  await page.keyboard.press('Escape')
  await panel.waitFor({state: 'detached'})

  // The row is offered, and the note is where the panel says it is.
  await openMenu()
  assert.equal(await page.locator('#menu-trash').isVisible(), true, 'the trash row is offered')
  await page.locator('#menu-trash').click()
  const trash = page.locator('dialog.dialog-library[aria-label="Trash"]')
  await trash.waitFor({state: 'visible'})
  await trash.locator('.document-row:not(.document-row-empty)').first().waitFor()
  assert.deepEqual(await trash.locator('.document-title').allTextContents(), ['Hasty note'])

  // The whole card puts it back.
  const restored = await notification(async () => {
    await trash.locator('.document-open').click()
    await until(
      () =>
        document.querySelectorAll('dialog[aria-label="Trash"] .document-row:not(.document-row-empty)')
          .length === 0,
      {what: 'the restored note to leave the trash'},
    )
  })
  assert.match(restored.text, /Restored Hasty note/)
  await trash.locator('.document-title', {hasText: 'The trash is empty.'}).waitFor()
  await page.keyboard.press('Escape')
  await trash.waitFor({state: 'detached'})

  // Back in the library as itself: same id, same text - so links and folder
  // sync find the note they knew, not a stranger wearing its words.
  await openMenu()
  await page.locator('#menu-documents').click()
  await panel.waitFor({state: 'visible'})
  await panel.locator('.document-row:not(.document-row-empty)').first().waitFor()
  assert.deepEqual(await panel.locator('.document-title').allTextContents(), ['Hasty note'])
  const after = await page.evaluate(async () =>
    (await (await import('/lib/library.js')).listDocuments()).map((entry) => ({
      id: entry.id,
      text: entry.text,
    })),
  )
  assert.equal(after.length, 1)
  assert.equal(after[0].id, original.id, 'the same note, id included')
  assert.equal(after[0].text, original.text, 'the same text')
})

test('the trash switch and its keep days are the reader’s, and the row follows the switch', async () => {
  const pref = (key) => page.evaluate((k) => localStorage.getItem(k), key)
  const settings = page.locator('dialog.dialog-settings')
  const openSettings = async () => {
    await openMenu()
    await page.locator('#menu-settings').click()
    await settings.waitFor({state: 'visible'})
  }
  const closeSettings = async () => {
    await page.keyboard.press('Escape')
    await settings.waitFor({state: 'detached'})
  }
  await page.evaluate(() => {
    localStorage.removeItem('textarea:trash')
    localStorage.removeItem('textarea:trash-keep')
  })

  await setNote('# Anything\n\nwords to count')

  // The row is there by default, and Settings reads the switch on.
  await openMenu()
  assert.equal(await page.locator('#menu-trash').isVisible(), true, 'the row ships visible')
  await page.keyboard.press('Escape')
  await openSettings()
  assert.equal(await settings.locator('#setting-trash').isChecked(), true, 'the switch ships on')
  assert.equal(await settings.locator('#setting-trash-keep').inputValue(), '30', 'the keep ships at 30 days')

  // The keep is a preference like any other: written, read back, kept.
  await settings.locator('#setting-trash-keep').selectOption('7')
  assert.equal(await pref('textarea:trash-keep'), '7', 'the keep wrote its own key')
  await closeSettings()
  await openSettings()
  assert.equal(await settings.locator('#setting-trash-keep').inputValue(), '7', 'the keep stays')

  // The switch and the row travel together.
  await settings.locator('#setting-trash').uncheck()
  assert.equal(await pref('textarea:trash'), 'off')
  await closeSettings()
  await openMenu()
  assert.equal(await page.locator('#menu-trash').isVisible(), false, 'a switched-off row is gone')
  await page.keyboard.press('Escape')

  await openSettings()
  await settings.locator('#setting-trash').check()
  assert.equal(await pref('textarea:trash'), 'on')
  await closeSettings()
  await openMenu()
  assert.equal(await page.locator('#menu-trash').isVisible(), true, 'and back when asked for')
  await page.keyboard.press('Escape')

  // Leave the settings as they were found.
  await page.evaluate(() => {
    localStorage.removeItem('textarea:trash')
    localStorage.removeItem('textarea:trash-keep')
  })
})

test('a note past its keep days is gone for good, and the switch off deletes outright', async () => {
  await setNote('# Old stuff\n\nwritten long ago')
  await until(
    async () => {
      const entries = await (await import('/lib/library.js')).listDocuments()
      return entries.length === 1 && entries[0].text.includes('written long ago')
    },
    {what: 'the note to be stored'},
  )

  // Into the trash it goes, then its deletion is wound back past the keep
  // days. The record itself is edited rather than a clock waited on: the
  // panel reads deletedAt, so that is the whole of its age.
  await page.evaluate(async () => {
    const library = await import('/lib/library.js')
    const [entry] = await library.listDocuments()
    await library.moveToTrash(entry.id)

    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('textarea')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    await new Promise((resolve, reject) => {
      const transaction = db.transaction('trash', 'readwrite')
      const store = transaction.objectStore('trash')
      const get = store.get(entry.id)
      get.onsuccess = () => {
        const record = get.result
        record.deletedAt = Date.now() - 40 * 86_400_000
        store.put(record)
      }
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
    })
    db.close()
  })

  // Opening the trash takes the expired note with it: 30 days is the ship,
  // 40 is over.
  await openMenu()
  await page.locator('#menu-trash').click()
  const trash = page.locator('dialog.dialog-library[aria-label="Trash"]')
  await trash.waitFor({state: 'visible'})
  await trash.locator('.document-title', {hasText: 'The trash is empty.'}).waitFor()
  assert.equal(
    await page.evaluate(async () => (await (await import('/lib/library.js')).listTrash()).length),
    0,
    'the expired note is gone for good',
  )
  await page.keyboard.press('Escape')
  await trash.waitFor({state: 'detached'})

  // Switch off, and a delete is a delete: no row, no recovery.
  await page.evaluate(() => localStorage.setItem('textarea:trash', 'off'))
  await setNote('# Doomed\n\nno second chance')
  await until(
    async () => {
      const entries = await (await import('/lib/library.js')).listDocuments()
      return entries.length === 1 && entries[0].text.includes('no second chance')
    },
    {what: 'the doomed note to be stored'},
  )

  await openMenu()
  assert.equal(await page.locator('#menu-trash').isVisible(), false, 'the row is gone while off')
  await page.locator('#menu-documents').click()
  const panel = page.locator('dialog.dialog-library[aria-label="My documents"]')
  await panel.waitFor({state: 'visible'})
  await panel.locator('.document-row:not(.document-row-empty)').first().waitFor()
  const message = await notification(async () => {
    await panel.locator('.document-delete').click()
    const confirm = page.locator('dialog.dialog-confirm')
    await confirm.waitFor({state: 'visible'})
    await confirm.getByRole('button', {name: 'Delete'}).click()
    await confirm.waitFor({state: 'detached'})
  })
  assert.match(message.text, /Deleted Doomed/)
  assert.equal(
    await page.evaluate(async () => (await (await import('/lib/library.js')).listTrash()).length),
    0,
    'nothing was kept',
  )
  assert.equal(
    await page.evaluate(async () => (await (await import('/lib/library.js')).listDocuments()).length),
    0,
    'and the note is gone',
  )
  await page.keyboard.press('Escape')
  await panel.waitFor({state: 'detached'})

  // Leave the settings as they were found.
  await page.evaluate(() => localStorage.removeItem('textarea:trash'))
})

test('the writing tools panel runs a tool through an injected model and hands the result back', async () => {
  // The panel is driven through the seam it is built around: a fake engine
  // answers `ensureModel`, so what is under test is everything the engine is
  // a stranger to - which tools the settings put on the shelf, what the
  // prompt carries, where the progress and the answer land, and what the
  // result button does with it. The real engine arrives through the same
  // door and gets its own test where it lives.
  await page.evaluate(async () => {
    const {createWritingTools} = await import('/lib/writing-tools.js')

    const state = {
      note: 'Old sentence.',
      toolList: ['improve', 'summarize'],
      progress: [],
      replaced: null,
      prompts: null,
      finish: null,
    }
    state.release = new Promise((resolve) => {
      state.finish = resolve
    })

    const panel = createWritingTools({
      ensureModel: async (onProgress) => {
        onProgress('Fetching model… 100 MB of 241 MB')
        state.progress.push('entered')
        return {
          run: async (messages) => {
            state.prompts = messages
            await state.release
            return 'A polished sentence.'
          },
        }
      },
      getText: () => state.note,
      getTools: () => state.toolList,
      getInstructions: () => 'Use British English.',
      onReplace: (text) => {
        state.replaced = text
      },
    })

    window.__writing = state
    window.__writingPanel = panel
    document.body.append(panel.element)
    panel.open()
  })

  const panelEl = page.locator('#writing-panel')
  await panelEl.waitFor({state: 'visible'})

  // Settings decide the shelf: two tools on, three off - only the two on
  // are drawn, and the first one offered starts pressed.
  const tools = panelEl.locator('.writing-tool')
  assert.equal(await tools.count(), 2)
  assert.equal(await tools.nth(0).getAttribute('data-tool'), 'improve')
  assert.equal(await tools.nth(0).getAttribute('aria-pressed'), 'true')
  assert.equal(await tools.nth(1).getAttribute('data-tool'), 'summarize')
  assert.equal(await tools.nth(1).getAttribute('aria-pressed'), 'false')

  // The reader's extra instructions are visible before anything runs, so
  // nothing is applied to a note without their say being on screen.
  const extra = panelEl.locator('.writing-extra')
  assert.equal(await extra.isVisible(), true)
  assert.ok((await extra.textContent()).includes('Use British English.'))

  // Picking a tool moves the pressed state with it.
  await tools.nth(1).click()
  assert.equal(await tools.nth(0).getAttribute('aria-pressed'), 'false')
  assert.equal(await tools.nth(1).getAttribute('aria-pressed'), 'true')

  // Run enters the engine, its progress lands in the status line - and
  // stays there, because the fake does not finish until it is released.
  // That hold is what makes the working phase assertable at all.
  await panelEl.locator('.writing-run').click()
  await until(() => window.__writing.progress.length === 1, {what: 'the engine to be entered'})
  assert.equal(
    (await panelEl.locator('.writing-status').textContent()).trim(),
    'Fetching model… 100 MB of 241 MB',
  )

  // What reached the engine is the note, the chosen tool's job and the
  // instructions, in the order buildPrompt promises.
  const prompts = await page.evaluate(() => window.__writing.prompts)
  assert.deepEqual(
    prompts.map((message) => message.role),
    ['system', 'user'],
  )
  assert.match(prompts[0].content, /Summarize the text/)
  assert.ok(prompts[1].content.includes('Old sentence.'))
  assert.ok(prompts[1].content.includes('Extra instructions: Use British English.'))

  await page.evaluate(() => window.__writing.finish())
  await until(() => document.querySelector('.writing-output').textContent === 'A polished sentence.', {
    what: 'the answer to land',
  })
  assert.equal((await panelEl.locator('.writing-status').textContent()).trim(), '')
  assert.equal(await panelEl.locator('.writing-result').isVisible(), true)

  // Replace hands the answer to the app through the injected callback and
  // takes the result off the panel: the note is the place it lives now.
  await panelEl.locator('.writing-replace').click()
  assert.equal(await page.evaluate(() => window.__writing.replaced), 'A polished sentence.')
  assert.equal(await panelEl.locator('.writing-result').isVisible(), false)

  // An empty note is a dead end the panel says out loud, and the engine is
  // never entered for it. The click explains; the app's next push of the
  // note - which is what the refresh call here stands in for - is what
  // takes the button out of action, because the panel never hears about
  // keystrokes on its own.
  await page.evaluate(() => {
    window.__writing.note = ''
  })
  await panelEl.locator('.writing-run').click()
  assert.equal(
    (await panelEl.locator('.writing-status').textContent()).trim(),
    'There is nothing on screen to work on.',
  )
  assert.equal(
    await page.evaluate(() => window.__writing.progress.length),
    1,
    'the engine is not entered for a note with nothing in it',
  )
  await page.evaluate(() => window.__writingPanel.refresh())
  assert.equal(await panelEl.locator('.writing-run').isDisabled(), true)

  // Settings changed while the panel was closed: reopening redraws the
  // shelf from what the settings say now, active tool or not.
  await page.evaluate(() => {
    window.__writing.toolList = ['shorten']
    window.__writingPanel.close()
  })
  assert.equal(await panelEl.isVisible(), false)
  await page.evaluate(() => window.__writingPanel.open())
  assert.equal(await tools.count(), 1)
  assert.equal(await tools.nth(0).getAttribute('data-tool'), 'shorten')
  assert.equal(await tools.nth(0).getAttribute('aria-pressed'), 'true')

  // The X takes it away - the app listens to the same click to remember
  // that the reader closed it.
  await panelEl.locator('.writing-close').click()
  assert.equal(await panelEl.isVisible(), false)

  await page.evaluate(() => {
    window.__writingPanel.element.remove()
    delete window.__writing
    delete window.__writingPanel
  })
})

test('the writing tools offer image tools only with the vision model, and send the chosen picture', async () => {
  await page.evaluate(async () => {
    const {createWritingTools} = await import('/lib/writing-tools.js')
    const state = {model: null, asked: null, prompts: null, replaced: null}
    const panel = createWritingTools({
      ensureModel: async (onProgress, signal, model) => {
        state.asked = model
        return {
          run: async (messages) => {
            state.prompts = messages
            return 'A red square.'
          },
        }
      },
      getModel: () => state.model,
      setModel: (id) => {
        state.model = id
      },
      getText: () => 'The note.',
      getSelection: () => ({start: 4, end: 4, text: ''}),
      getTools: () => ['improve', 'describe', 'ocr'],
      getInstructions: () => '',
      onReplace: (text, selection) => {
        state.replaced = {text, selection}
      },
    })
    window.__vision = state
    window.__visionPanel = panel
    document.body.append(panel.element)
    panel.open()
  })

  const panelEl = page.locator('#writing-panel')
  const tools = panelEl.locator('.writing-tool')
  const shelf = async () => tools.evaluateAll((buttons) => buttons.map((button) => button.dataset.tool))

  // Gemma first: no image tools, no image row.
  assert.equal(await panelEl.locator('.writing-model select').inputValue(), 'gemma')
  assert.deepEqual(await shelf(), ['improve'])
  assert.equal(await panelEl.locator('.writing-image').isVisible(), false)

  // The vision model puts them on the shelf and remembers the choice.
  await panelEl.locator('.writing-model select').selectOption('minicpm-v')
  assert.equal(await page.evaluate(() => window.__vision.model), 'minicpm-v')
  assert.deepEqual(await shelf(), ['improve', 'describe', 'ocr'])

  // An image tool with no image says so and keeps Run out of action.
  await panelEl.locator('.writing-tool[data-tool="describe"]').click()
  assert.equal(await panelEl.locator('.writing-image').isVisible(), true)
  assert.equal((await panelEl.locator('.writing-status').textContent()).trim(), 'Choose an image to work on.')
  assert.equal(await panelEl.locator('.writing-run').isDisabled(), true)

  // A 1x1 PNG: re-encoded as JPEG for the model, shown in the panel.
  await panelEl.locator('.writing-image input[type="file"]').setInputFiles({
    name: 'dot.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    ),
  })
  await until(() => !document.querySelector('.writing-preview').hidden, {what: 'the preview'})
  assert.equal(await panelEl.locator('.writing-run').isDisabled(), false)

  await panelEl.locator('.writing-run').click()
  await until(() => document.querySelector('.writing-output').textContent === 'A red square.', {what: 'the answer'})
  const sent = await page.evaluate(() => ({
    model: window.__vision.asked,
    parts: window.__vision.prompts[1].content.map((part) => ({
      type: part.type,
      jpeg: part.type === 'image' ? new Uint8Array(part.data)[0] === 0xff && new Uint8Array(part.data)[1] === 0xd8 : null,
    })),
  }))
  assert.equal(sent.model, 'minicpm-v')
  assert.deepEqual(sent.parts, [{type: 'image', jpeg: true}, {type: 'text', jpeg: null}])

  // With no selection, the answer goes in at the cursor.
  assert.equal((await panelEl.locator('.writing-replace').textContent()).trim(), 'Insert at the cursor')
  await panelEl.locator('.writing-replace').click()
  assert.deepEqual(await page.evaluate(() => window.__vision.replaced), {
    text: 'A red square.',
    selection: {start: 4, end: 4},
  })

  await page.evaluate(() => {
    window.__visionPanel.element.remove()
    delete window.__vision
    delete window.__visionPanel
  })
})

test('the writing tools act on the selection when the reader asks for it, and only then', async () => {
  // Selection-awareness is two seams and everything that follows from
  // them: what is selected, and whether the reader asked for it. The
  // prompt takes one text or the other, the result button names which of
  // the two the answer is for, and Replace hands the answer back with the
  // offsets that were run on - all provable without a model near the gate.
  await page.evaluate(async () => {
    const {createWritingTools} = await import('/lib/writing-tools.js')

    const state = {
      note: 'First half SECOND half.',
      selection: {start: 11, end: 17, text: 'SECOND'},
      aware: false,
      runs: 0,
      prompts: null,
      replaced: null,
      replacedTarget: null,
    }

    const panel = createWritingTools({
      ensureModel: async () => ({
        run: async (messages) => {
          state.runs++
          state.prompts = messages
          return `ANSWER ${state.runs}`
        },
      }),
      getText: () => state.note,
      getSelection: () => state.selection,
      selectionAware: () => state.aware,
      getTools: () => ['improve'],
      getInstructions: () => '',
      onReplace: (text, target) => {
        state.replaced = text
        state.replacedTarget = target
      },
    })

    window.__target = state
    document.body.append(panel.element)
    panel.open()
  })

  const panelEl = page.locator('#writing-panel')
  await panelEl.waitFor({state: 'visible'})
  // `until` serializes the predicate into the page, where a closure over n
  // does not come along - so the expected answer travels on the state.
  const answerLanded = async (n) => {
    await page.evaluate((value) => {
      window.__target.expect = value
    }, `ANSWER ${n}`)
    await until(() => document.querySelector('.writing-output').textContent === window.__target.expect, {
      what: `answer ${n} to land`,
    })
  }
  const promptText = async () => (await page.evaluate(() => window.__target.prompts))[1].content

  // The ship: a selection is there and the Run does not see it - the
  // prompt carries the whole note, and the button says which half of the
  // app the answer belongs to.
  await panelEl.locator('.writing-run').click()
  await answerLanded(1)
  assert.ok((await promptText()).includes('First half SECOND half.'), 'the whole note went in')
  assert.equal(
    await panelEl.locator('.writing-replace').textContent(),
    'Replace the note',
    'off, the result belongs to the note',
  )
  await panelEl.locator('.writing-replace').click()
  assert.equal(await page.evaluate(() => window.__target.replaced), 'ANSWER 1')
  assert.equal(
    await page.evaluate(() => window.__target.replacedTarget),
    null,
    'and Replace hands back nothing to put it in',
  )

  // Asked for, the same selection narrows the prompt to just itself - the
  // rest of the note never reaches the model - and the button turns with
  // it, carrying the offsets the Run saw back to Replace.
  await page.evaluate(() => {
    window.__target.aware = true
  })
  await panelEl.locator('.writing-run').click()
  await answerLanded(2)
  const selected = await promptText()
  assert.ok(selected.includes('SECOND'), 'the selection went in')
  assert.ok(!selected.includes('First half'), 'and the rest of the note did not')
  assert.equal(
    await panelEl.locator('.writing-replace').textContent(),
    'Replace the selection',
    'on, the result belongs to the selection',
  )
  await panelEl.locator('.writing-replace').click()
  assert.equal(await page.evaluate(() => window.__target.replaced), 'ANSWER 2')
  assert.deepEqual(
    await page.evaluate(() => window.__target.replacedTarget),
    {start: 11, end: 17},
    'with the offsets the Run saw, so the answer lands where it looked',
  )

  // Asked for with nothing worth taking selected is the note again: a
  // stray drag across one space is not half a note, and the panel asks
  // for the whole one.
  await page.evaluate(() => {
    window.__target.selection = {start: 5, end: 6, text: ' '}
  })
  await panelEl.locator('.writing-run').click()
  await answerLanded(3)
  assert.ok((await promptText()).includes('First half SECOND half.'), 'the note went back in')
  assert.equal(await panelEl.locator('.writing-replace').textContent(), 'Replace the note')
  await panelEl.locator('.writing-replace').click()
  assert.equal(await page.evaluate(() => window.__target.replacedTarget), null)

  await page.evaluate(() => {
    document.querySelector('#writing-panel').remove()
    delete window.__target
  })
})

test('the writing panel leaves the reader’s selection where it was put', async () => {
  // Selection-aware tools read the selection from the editor when Run is
  // pressed - after the click has already happened, with focus sitting in
  // the panel - so both the opening of the panel and a click in it have to
  // leave the selection alone. Run would be the model, so a tool button
  // stands in for it: the same panel, the same kind of click, no weights
  // fetched.
  await setNote('First half SECOND half.')
  await page.evaluate(() => globalThis.textarea.editor.select(11, 17))

  const selection = () =>
    page.evaluate(() => {
      const {start, end, text} = globalThis.textarea.editor.selection()
      return {start, end, text}
    })
  assert.deepEqual(
    await selection(),
    {start: 11, end: 17, text: 'SECOND'},
    'the note is open with a selection in it',
  )

  await openMenu()
  await page.locator('#menu-writing').click()
  const panel = page.locator('#writing-panel')
  await panel.waitFor({state: 'visible'})
  assert.deepEqual(
    await selection(),
    {start: 11, end: 17, text: 'SECOND'},
    'opening the panel left it where the reader put it',
  )

  await panel.locator('.writing-tool').first().click()
  assert.deepEqual(
    await selection(),
    {start: 11, end: 17, text: 'SECOND'},
    'and so did the click in it',
  )

  await panel.locator('.writing-close').click()
  assert.equal(await panel.isVisible(), false)
})

test('the writing tools row, shelf, instructions and selection switch are the reader’s to change', async () => {
  // The app side of the seam. The panel opens from its menu row without
  // fetching a byte of the model - the engine is two lazy imports deeper
  // than this - and no test ever presses Run, because a real Run would be
  // a real 241 MB download in a gate. Everything the switches decide is
  // checked against the panel that draws itself from those same switches.
  const pref = (key) => page.evaluate((k) => localStorage.getItem(k), key)
  const resources = () =>
    page.evaluate(() => performance.getEntriesByType('resource').map((entry) => entry.name))

  await openMenu()
  const row = page.locator('#menu-writing')
  assert.equal(await row.getAttribute('aria-checked'), 'false', 'the panel starts closed')

  await row.click()
  const panel = page.locator('#writing-panel')
  await panel.waitFor({state: 'visible'})
  assert.equal(await row.getAttribute('aria-checked'), 'true', 'the row follows the panel')
  assert.equal(await pref('textarea:writing'), 'on', 'and the opening is remembered')

  const opened = await resources()
  assert.ok(
    opened.some((name) => name.endsWith('/lib/writing-tools.js')),
    'the panel module arrives on the click that opens it',
  )
  assert.ok(
    !opened.some(
      (name) => name.includes('/models/') || name.includes('wllama') || name.endsWith('/lib/gemma.js'),
    ),
    'no engine of any kind before anyone asks for a run',
  )

  // Settings carries the panel's switch and the shelf beneath it, from the
  // panel module's own list of tools.
  await openMenu()
  await page.locator('#menu-settings').click()
  const settings = page.locator('dialog.dialog-settings')
  await settings.waitFor({state: 'visible'})
  assert.equal(await settings.locator('#setting-writing').isChecked(), true)
  const toolSwitch = settings.locator('#setting-writing-improve')
  assert.equal(await toolSwitch.isChecked(), true, 'a tool is on until it is switched off')

  await toolSwitch.uncheck()
  assert.equal(await pref('textarea:writing-tool-improve'), 'off')

  // The open panel took the news as it arrived - asserted before anything
  // else in this test has had a chance to redraw it, because the shelf
  // answering its own switch is the claim being made.
  const tools = panel.locator('.writing-tool')
  assert.equal(await tools.count(), 4, 'the shelf redraws without the switched-off tool')
  assert.ok(
    !(await tools.allTextContents()).includes('Improve wording'),
    'the one switched off is the one gone',
  )

  // A sentence goes in the text option; change is what writes it, and the
  // panel shows it before anything runs - not discovered after.
  const instructions = settings.locator('#setting-writing-instructions')
  await instructions.fill('Use British English.')
  await instructions.press('Tab')
  assert.equal(await pref('textarea:writing-instructions'), 'Use British English.')
  const extra = panel.locator('.writing-extra')
  assert.equal(await extra.isVisible(), true)
  assert.ok((await extra.textContent()).includes('Use British English.'))

  // The selection switch is thrown like every other: off until the reader
  // throws it, written to its own key, and read back when the dialog
  // comes round again.
  const selectionSwitch = settings.locator('#setting-writing-selection')
  assert.equal(await selectionSwitch.isChecked(), false, 'selection-aware tools ship off')
  await selectionSwitch.check()
  assert.equal(await pref('textarea:writing-selection'), 'on', 'the switch writes its own key')
  await page.keyboard.press('Escape')
  await settings.waitFor({state: 'detached'})
  await openMenu()
  await page.locator('#menu-settings').click()
  await settings.waitFor({state: 'visible'})
  assert.equal(
    await settings.locator('#setting-writing-selection').isChecked(),
    true,
    'and the dialog reads it back where it was left',
  )

  await page.keyboard.press('Escape')
  await settings.waitFor({state: 'detached'})

  // The Run button is pushed, not polled: it changes when the note changes
  // because save() hands the panel the news, in both directions.
  await page.evaluate(async () => {
    globalThis.textarea.editor.replace('Words to work on.')
    await globalThis.textarea.save()
  })
  await until(() => document.querySelector('.writing-run').disabled === false, {
    what: 'the Run button to come back with a note on screen',
  })
  await page.evaluate(async () => {
    globalThis.textarea.editor.replace('')
    await globalThis.textarea.save()
  })
  await until(() => document.querySelector('.writing-run').disabled === true, {
    what: 'the Run button to be taken out of action by an empty note',
  })
  assert.match(
    await panel.locator('.writing-status').textContent(),
    /nothing on screen/,
    'and the reason is on screen',
  )

  // The X closes it and says so in the same switch the row reads.
  await panel.locator('.writing-close').click()
  assert.equal(await panel.isVisible(), false)
  assert.equal(await pref('textarea:writing'), 'off')
  assert.equal(await row.getAttribute('aria-checked'), 'false')

  // Still nothing fetched for the model at any point of the way.
  assert.ok(
    !(await resources()).some(
      (name) => name.includes('/models/') || name.includes('wllama') || name.endsWith('/lib/gemma.js'),
    ),
    'the whole trip happened without touching the model',
  )

  // Leave the preferences as they were found: no tool switched off, no
  // sentence appended, no selection-aware run asked for. (The panel's own
  // switch was closed by its own X.)
  await page.evaluate(() => {
    localStorage.removeItem('textarea:writing-tool-improve')
    localStorage.removeItem('textarea:writing-instructions')
    localStorage.removeItem('textarea:writing-selection')
  })
})

test('a task in the note draws as a checkbox and ticks off in place', async () => {
  // The whole feature sits behind one switch. textarea-plus ships it on, so it
  // is thrown off here: a note written without it renders exactly as it always
  // did. Throwing it
  // draws the checkbox over the bracket the reader typed without a
  // keystroke, and a click on the box writes the one character the task
  // is made of - through the editor, so it lands on the undo stack and
  // reaches the library like any other edit.
  const pref = (key) => page.evaluate((k) => localStorage.getItem(k), key)
  await page.evaluate(() => localStorage.setItem('textarea:tasks', 'off'))

  // Off: the Settings row says so, and the note below stays
  // a plain list - no checkbox anywhere, text untouched.
  await openMenu()
  await page.locator('#menu-settings').click()
  const settings = page.locator('dialog.dialog-settings')
  await settings.waitFor({state: 'visible'})
  assert.equal(await settings.locator('#setting-tasks').isChecked(), false, 'tasks are off')
  await page.keyboard.press('Escape')
  await settings.waitFor({state: 'detached'})

  await setNote('- [ ] water\n- [x] done')
  assert.equal(
    await page.locator('article .md-task').count(),
    0,
    'the bracket is only text until the reader asks',
  )
  assert.equal(await noteText(), '- [ ] water\n- [x] done')

  // The switch throws like every other: it writes its own key, and the
  // checkboxes draw over the brackets at once - no re-typing to make the
  // note catch up.
  await openMenu()
  await page.locator('#menu-settings').click()
  await settings.waitFor({state: 'visible'})
  await settings.locator('#setting-tasks').check()
  assert.equal(await pref('textarea:tasks'), 'on', 'the switch writes its own key')
  await page.keyboard.press('Escape')
  await settings.waitFor({state: 'detached'})

  await page.waitForFunction(() => document.querySelectorAll('article .md-task').length === 2)
  assert.equal(await page.locator('article .md-task-done').count(), 1, '[x] is the ticked state')
  assert.equal(
    await noteText(),
    '- [ ] water\n- [x] done',
    'the text under the box is the note as typed',
  )

  // The click is the keystroke the reader would have typed: one character
  // flips, the box follows, and the save carries it to the library.
  await page.locator('article .md-task').first().click()
  await page.waitForFunction(
    () => document.querySelector('article').textContent === '- [x] water\n- [x] done',
  )
  assert.equal(await page.locator('article .md-task-done').count(), 2, 'both boxes now ticked')
  await until(
    async () => {
      const [entry] = await (await import('/lib/library.js')).listDocuments()
      return Boolean(entry?.text?.includes('- [x] water'))
    },
    {what: 'the tick to reach the library'},
  )

  // A second click, then one undo: only the click just made comes off.
  // Each click is one keystroke with both ends on the stack, so the
  // clicks come back one at a time rather than all at once.
  await page.locator('article .md-task').nth(1).click()
  await page.waitForFunction(
    () => document.querySelector('article').textContent === '- [x] water\n- [ ] done',
  )
  await page.keyboard.press('Control+z')
  await page.waitForFunction(
    () => document.querySelector('article').textContent === '- [x] water\n- [x] done',
  )
  assert.equal(
    await page.locator('article .md-task-done').count(),
    2,
    'and only the last box unticks with it',
  )

  // Switched off again, the checkbox leaves and the note stays: nothing
  // is drawn that the switch cannot take back out.
  await openMenu()
  await page.locator('#menu-settings').click()
  await settings.waitFor({state: 'visible'})
  await settings.locator('#setting-tasks').uncheck()
  await page.keyboard.press('Escape')
  await settings.waitFor({state: 'detached'})
  await page.waitForFunction(() => document.querySelectorAll('article .md-task').length === 0)
  assert.equal(await noteText(), '- [x] water\n- [x] done', 'and the text never moved')

  // Two notes swapped in over this one leave both ends of each swap on
  // the stack, so a single undo brings the previous note back - the same
  // bargain insert() keeps above.
  await setNote('- [ ] a different note')
  await setNote('- [ ] yet another note')
  await page.locator('article').focus()
  await page.keyboard.press('Control+z')
  await page.waitForFunction(
    () => document.querySelector('article').textContent === '- [ ] a different note',
  )

  await page.evaluate(() => localStorage.removeItem('textarea:tasks'))
})

test('a dash is not a bullet, and two dashes and a space make a task', async () => {
  await page.evaluate(() => localStorage.setItem('textarea:tasks', 'off'))
  await setNote('')
  await page.locator('article').focus()

  // One dash and a space is a sentence that starts with a dash.
  await page.keyboard.type('- plain')
  await page.keyboard.press('Enter')
  // Two dashes wait for their space: until it comes they are only dashes.
  await page.keyboard.type('--')
  await settleHistory()
  assert.equal(await noteText(), '- plain\n--')
  assert.equal(await page.locator('article .md-li').count(), 0, 'no bullet for a dash')

  // The space is what asks: the text becomes the task every other reader
  // knows, and the switch is thrown because a box was asked for.
  await page.keyboard.type(' ')
  await page.waitForFunction(() => document.querySelector('article').textContent === '- plain\n- [ ] ')
  await page.waitForFunction(() => document.querySelectorAll('article .md-task').length === 1)
  assert.equal(await page.evaluate(() => localStorage.getItem('textarea:tasks')), 'on')
  assert.equal(
    await page.evaluate(() => getComputedStyle(document.querySelector('article .md-li'), '::before').content),
    'none',
    'the box stands alone, with no bullet beside it',
  )

  // The caret is after the box, so the task's words follow straight on.
  await page.keyboard.type('water')
  await page.waitForFunction(() => document.querySelector('article').textContent === '- plain\n- [ ] water')
  await page.locator('article .md-task').click()
  await page.waitForFunction(() => document.querySelector('article').textContent === '- plain\n- [x] water')

  // Indented, and with the switch already on: the indent stays, and one
  // undo gives the two dashes back.
  await setNote('')
  await page.locator('article').focus()
  await page.keyboard.type('  -- ')
  await page.waitForFunction(() => document.querySelector('article').textContent === '  - [ ] ')
  await settleHistory()
  await page.keyboard.press('Control+z')
  await page.waitForFunction(() => document.querySelector('article').textContent === '  -- ')

  await page.evaluate(() => localStorage.removeItem('textarea:tasks'))
})

test('the tasks panel gathers every open task in the library and opens its note', async () => {
  // Tasks off and finished ones hidden, whatever an interrupted run left behind.
  await page.evaluate(() => {
    localStorage.setItem('textarea:tasks', 'off')
    localStorage.removeItem('textarea:tasks-done')
  })
  const pref = (key) => page.evaluate((k) => localStorage.getItem(k), key)

  // Two notes in the library, one of them holding a task that is already
  // done. The notes are seeded directly: this test is about the panel's
  // question, not about how a note gets written.
  await page.evaluate(async () => {
    const library = await import('/lib/library.js')
    await library.putDocument({title: 'Alpha', text: '# Alpha\n\n- [ ] alpha task\n- [x] baked'})
    await library.putDocument({title: 'Beta', text: '# Beta\n\n- [ ] bravo task'})
  })

  // The row is a switch-gated action like Backup's: with the feature off
  // there is no row to click, and the settings entry offers no option.
  await openMenu()
  assert.equal(await page.locator('#menu-tasks').isVisible(), false, 'the row is hidden while off')
  await page.locator('#menu-settings').click()
  const settings = page.locator('dialog.dialog-settings')
  await settings.waitFor({state: 'visible'})
  assert.equal(await settings.locator('#setting-tasks').isChecked(), false, 'tasks are off')
  assert.equal(
    await settings.locator('#setting-tasks-done').isVisible(),
    false,
    'no option is offered while the feature is off',
  )

  // Throwing the switch writes its own key, and its option arrives under it.
  await settings.locator('#setting-tasks').check()
  assert.equal(await pref('textarea:tasks'), 'on', 'the switch writes its own key')
  assert.equal(
    await settings.locator('#setting-tasks-done').isVisible(),
    true,
    'the option arrives with the feature',
  )
  await page.keyboard.press('Escape')
  await settings.waitFor({state: 'detached'})

  await openMenu()
  assert.equal(await page.locator('#menu-tasks').isVisible(), true, 'the row arrives with its switch')
  await page.locator('#menu-tasks').click()
  const panel = page.locator('#tasks-panel')
  await panel.waitFor({state: 'visible'})
  await until(() => document.querySelectorAll('.task-row').length === 2, {
    what: 'the two open tasks to be listed',
  })
  const listed = (await panel.locator('.task-row').allTextContents()).join('\n')
  assert.ok(listed.includes('alpha task') && listed.includes('bravo task'), 'the words are the notes')
  assert.ok(listed.includes('Alpha') && listed.includes('Beta'), 'each row names the note it is from')
  assert.ok(!listed.includes('baked'), 'a task already ticked is not an open task')

  // The option brings the finished work in, and the panel answers without
  // being reopened - the option pushes the news itself.
  await openMenu()
  await page.locator('#menu-settings').click()
  await settings.waitFor({state: 'visible'})
  assert.equal(
    await settings.locator('#setting-tasks-done').isChecked(),
    false,
    'completed tasks ship hidden',
  )
  await settings.locator('#setting-tasks-done').check()
  assert.equal(await pref('textarea:tasks-done'), 'on')
  await page.keyboard.press('Escape')
  await settings.waitFor({state: 'detached'})
  await until(() => document.querySelectorAll('.task-row').length === 3, {
    what: 'the ticked task to join the list',
  })
  assert.equal(await panel.locator('.task-row-done').count(), 1, 'and it is labelled for what it is')

  // Following a row opens the note it came from - the editor was empty,
  // so no question stands in the way of the swap.
  await panel.locator('.task-open', {hasText: 'bravo task'}).click()
  await until(() => document.querySelector('article').textContent.includes('bravo task'), {
    what: 'Beta to open from the tasks panel',
  })

  // Switched off again, the row and the panel go with the feature.
  await openMenu()
  await page.locator('#menu-settings').click()
  await settings.waitFor({state: 'visible'})
  await settings.locator('#setting-tasks').uncheck()
  await page.keyboard.press('Escape')
  await settings.waitFor({state: 'detached'})
  assert.equal(await page.locator('#menu-tasks').isVisible(), false, 'the row hides with its switch')
  assert.equal(await panel.isVisible(), false, 'and the panel goes with it')

  // Leave the preferences as they were found: neither switch thrown.
  await page.evaluate(() => {
    localStorage.removeItem('textarea:tasks')
    localStorage.removeItem('textarea:tasks-done')
  })
})

test('the service worker registers and precaches the shell', async () => {
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, {timeout: 20_000})
  const cached = await page.evaluate(async () => {
    const names = await caches.keys()
    const shell = names.find((name) => name.startsWith('textarea-shell'))
    const cache = await caches.open(shell)
    return (await cache.keys()).map((request) => new URL(request.url).pathname)
  })
  assert.ok(cached.includes('/app.js'), `app.js should be precached: ${cached}`)
  assert.ok(cached.includes('/lib/share.js'))
  assert.ok(
    !cached.some((path) => path.startsWith('/vendor/')),
    'the vendor libraries must not be precached',
  )
  assert.ok(
    !cached.some((path) => path.startsWith('/models/')),
    'the model must not be precached - 241 MB in an install event',
  )
})

test('pdf.js is fetched on demand and cached, not precached', async () => {
  const vendor = await page.evaluate(async () => {
    const names = await caches.keys()
    const cache = await caches.open(names.find((name) => name.startsWith('textarea-vendor')))
    return (await cache.keys()).map((request) => new URL(request.url).pathname)
  })
  assert.ok(
    vendor.some((path) => path.endsWith('pdf.min.mjs')),
    `pdf.js should be runtime cached after the PDF test: ${vendor}`,
  )
})

test('the model is fetched on demand and cached, never precached', async () => {
  // Without a controller the fetch would bypass the worker and nothing
  // would be cached at all - the same wait the shell test makes.
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, {timeout: 20_000})

  // The install event leaves the model alone - asserted above for the
  // shell cache, and here for the cache it does belong in: empty until a
  // load asks for something, which is what makes the first Load model a
  // paid once and the second one an offline read.
  const paths = async (name) =>
    page.evaluate(async (cacheName) => {
      const cache = await caches.open(cacheName)
      return (await cache.keys()).map((request) => new URL(request.url).pathname)
    }, name)

  assert.deepEqual(await paths('textarea-models'), [], 'nothing under /models/ before anything asks')

  // The manifest is what Load model reads first, so it stands in for the
  // whole flow: one GET, answered from the network and kept.
  const manifest = await page.evaluate(async () => {
    const response = await fetch('/models/manifest.json')
    return response.text()
  })
  assert.match(manifest, /gemma-3-270M-it-Q4_K_M\.gguf/, 'the manifest is the one that ships')

  // `until` runs inside the page, where this test's own helpers do not
  // exist - the predicate is written out for the browser to answer.
  await until(
    async () => {
      const cache = await caches.open('textarea-models')
      return (await cache.keys()).length === 1
    },
    {what: 'the manifest to land in the model cache'},
  )
  assert.deepEqual(await paths('textarea-models'), ['/models/manifest.json'])

  // And it never leaked into the shell: the shell cache is still just the
  // app, however big the model cache grows beside it.
  const shell = await page.evaluate(async () => {
    const names = await caches.keys()
    const cache = await caches.open(names.find((name) => name.startsWith('textarea-shell')))
    return (await cache.keys()).map((request) => new URL(request.url).pathname)
  })
  assert.ok(!shell.some((path) => path.startsWith('/models/')))
})

chromiumOnly('uses the File System Access API when the browser offers it', async () => {
  const stubbed = await context.newPage()
  await stubbed.addInitScript(() => {
    // Stand in for the picker: record what was asked for and what was written.
    window.__picked = []
    window.showSaveFilePicker = async (options) => {
      window.__picked.push(options)
      return {
        createWritable: async () => ({
          write: async (blob) => {
            window.__written = {size: blob.size, type: blob.type, text: await blob.text()}
          },
          close: async () => {
            window.__closed = true
          },
        }),
      }
    }
  })
  await stubbed.goto(server.origin + '/')
  await stubbed.waitForFunction(() => Boolean(globalThis.textarea))
  await stubbed.evaluate(() => globalThis.textarea.editor.replace('# Chosen name\n\nbody text'))

  await stubbed.locator('#button').click()
  await stubbed.locator('#menu').waitFor({state: 'visible'})
  await stubbed.locator('#menu-export').click()

  const dialog = stubbed.locator('dialog.dialog[aria-label="Export"]')
  await dialog.waitFor({state: 'visible'})
  await dialog.locator('input[name=destination][value=file]').check()
  await dialog.locator('input[name=format][value=md]').check()
  await dialog.locator('.dialog-button-primary').click()
  await dialog.waitFor({state: 'detached'})

  const picked = await stubbed.evaluate(() => window.__picked)
  assert.equal(picked.length, 1, 'the picker should have been used once')
  assert.equal(picked[0].suggestedName, 'Chosen name.md')

  // The accept map is what makes the OS filter show only markdown.
  assert.deepEqual(picked[0].types[0].accept, {'text/markdown': ['.md']})

  // The dialog closes as soon as the choice is made; the write happens after.
  await stubbed.waitForFunction(() => Boolean(window.__written && window.__closed))
  const written = await stubbed.evaluate(() => window.__written)
  assert.equal(written.type, 'text/markdown')
  assert.equal(written.text, '# Chosen name\n\nbody text\n')

  await stubbed.close()
})

test('the server sends the security headers', async () => {
  const response = await page.request.get(server.origin + '/index.html')
  assert.equal(response.status(), 200)
  const headers = response.headers()

  assert.equal(headers['x-content-type-options'], 'nosniff')
  assert.equal(headers['x-frame-options'], 'DENY')
  assert.equal(headers['referrer-policy'], 'strict-origin-when-cross-origin')
  assert.equal(headers['cross-origin-opener-policy'], 'same-origin')

  const csp = headers['content-security-policy']
  assert.ok(csp, 'a Content-Security-Policy is set')
  // The same bargain as the unit test: the wasm grant the model compiles
  // under is required, and then removed again so what remains must hold no
  // unsafe-eval and no inline scripts at all.
  assert.match(csp, /script-src 'self' 'wasm-unsafe-eval'/)
  assert.match(csp, /frame-ancestors 'none'/)
  const scripts = /script-src[^;]*/.exec(csp)[0].replaceAll("'wasm-unsafe-eval'", '')
  assert.ok(!scripts.includes('unsafe-eval'), 'scripts are not loosened')
  assert.ok(!scripts.includes('unsafe-inline'), 'scripts are not loosened')
})

test('an unhandled rejection in a page reaches the error gate', async () => {
  // The gate proves itself: a rejection nobody catches must land in the same
  // list as a thrown error, or the checks below only ever judge console
  // noise. The probe's own entry is taken back out afterwards so the gate at
  // the end judges what shipped, not this test on purpose.
  const marker = 'unhandled-rejection-probe'
  await page.evaluate((text) => {
    Promise.reject(new Error(text))
  }, marker)

  const deadline = Date.now() + 5000
  let caught = false
  while (!caught && Date.now() < deadline) {
    caught = consoleErrors.some((entry) => entry.includes(marker))
    if (!caught) await new Promise((resolve) => setTimeout(resolve, 50))
  }
  for (let index = consoleErrors.length - 1; index >= 0; index--) {
    if (consoleErrors[index].includes(marker)) consoleErrors.splice(index, 1)
  }
  assert.ok(caught, 'an unhandled rejection is a logged error like any other')
})

/* ------------------------------------------------------------------ helpers */

/**
 * Open the Export panel and choose where the note is going.
 *
 * @param {'file'|'copy'|'qr'|'zip'} destination
 */
async function openExportPanel(destination) {
  await openMenu()
  await page.locator('#menu-export').click()

  const dialog = page.locator('dialog.dialog[aria-label="Export"]')
  await dialog.waitFor({state: 'visible'})
  await dialog.locator(`input[name=destination][value=${destination}]`).check()
  return dialog
}

/**
 * Open the Encryption panel and press one of its two buttons.
 *
 * @param {'Encrypted link'|'Encrypted link: on'|'Remove encryption'} label
 */
async function encryptionAction(label) {
  await openMenu()
  await page.locator('#menu-encryption').click()

  const dialog = page.locator('dialog.dialog[aria-label="Encryption"]')
  await dialog.waitFor({state: 'visible'})
  await dialog.getByRole('button', {name: label, exact: true}).click()
  await dialog.waitFor({state: 'detached'})
}

/** Open Export, save as one format, and capture the download. */
async function downloadViaDialog(format) {
  const dialog = await openExportPanel('file')
  await dialog.locator(`input[name=format][value=${format}]`).check()

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    dialog.locator('.dialog-button-primary').click(),
  ])
  await dialog.waitFor({state: 'detached'})

  const path = join(DOWNLOADS, download.suggestedFilename())
  await download.saveAs(path)
  const text = await fs.readFile(path, 'utf8')
  return {text, ok: true, suggestedFilename: download.suggestedFilename(), path}
}

/** Open Export, pick the archive, tick formats, set or skip the password, capture the download. */
async function downloadZip({password, formats}) {
  let dialog = await openExportPanel('zip')
  await dialog.locator('.dialog-button-primary').click()

  dialog = page.locator('dialog.dialog[aria-label="Save as ZIP"]')
  await dialog.waitFor({state: 'visible'})

  // Start from a clean sheet.
  for (const box of await dialog.locator('input[type=checkbox]').all()) {
    if (await box.isChecked()) await box.uncheck()
  }
  for (const format of formats) await dialog.locator(`input[name=${format}]`).check()
  if (password) await dialog.locator('input[name=encrypt]').check()

  await dialog.locator('.dialog-button-primary').click()

  if (password) {
    dialog = page.locator('dialog.dialog[aria-label="Encrypt the archive"]')
    await dialog.waitFor({state: 'visible'})
    await fillDialog('Password', password)
    await fillDialog('Repeat the password', password)

    const [download] = await Promise.all([
      page.waitForEvent('download', {timeout: 60_000}),
      dialog.locator('.dialog-button-primary').click(),
    ])
    const path = join(DOWNLOADS, download.suggestedFilename())
    await download.saveAs(path)
    return {ok: true, suggestedFilename: download.suggestedFilename(), path}
  }

  const download = await page.waitForEvent('download', {timeout: 60_000})
  const path = join(DOWNLOADS, download.suggestedFilename())
  await download.saveAs(path)
  return {ok: true, suggestedFilename: download.suggestedFilename(), path}
}

/**
 * A page in a context of its own, with clipboard permission.
 *
 * The main context deliberately has none, because one test asserts what the app
 * does when the browser refuses. Granting the permission here rather than
 * globally keeps both true at once, and it means the copy tests read the real
 * clipboard back rather than asserting against a stub that might be stubbed
 * wrong.
 */
async function clipboardContext() {
  const owned = await browser.newContext({
    acceptDownloads: true,
    permissions: ['clipboard-read', 'clipboard-write'],
  })
  // The real file picker opens a native dialog no automation can dismiss.
  await owned.addInitScript(() => {
    Reflect.deleteProperty(window, 'showSaveFilePicker')
  })
  const clipPage = await owned.newPage()
  await clipPage.goto(server.origin + '/')
  await clipPage.waitForFunction(() => Boolean(globalThis.textarea))
  return {context: owned, page: clipPage}
}

/* ------------------------------------------------------------ folder sync */

/**
 * The folder-sync rig: an OPFS directory driven entirely inside the page.
 *
 * The real File System Access API opens a native dialog no automation can
 * dismiss, so these tests reach connectToDirectory() with an OPFS directory
 * instead: the same FileSystemDirectoryHandle interface, the same gather /
 * plan / execute path, only the picker is skipped. Everything stays inside
 * the page because a handle is not something evaluate() should move around.
 */
async function syncRig() {
  await page.evaluate(() => {
    if (globalThis.__sync) return

    const names = async (dir) => {
      const out = []
      for await (const child of dir.values()) out.push(child.name)
      return out
    }

    globalThis.__sync = {
      dir: null,
      dir2: null,
      async open() {
        const root = await navigator.storage.getDirectory()
        const dir = await root.getDirectoryHandle('sync-test', {create: true})
        for (const child of await names(dir)) await dir.removeEntry(child)
        this.dir = dir
        return names(dir)
      },
      // A second folder for the test that points the sync somewhere else
      // mid-pass: the two have to stay separable, or "the old folder's plan
      // did not commit" has nothing to distinguish it from "they matched".
      async open2() {
        const root = await navigator.storage.getDirectory()
        const dir = await root.getDirectoryHandle('sync-test-2', {create: true})
        for (const child of await names(dir)) await dir.removeEntry(child)
        this.dir2 = dir
        return names(dir)
      },
      async write(name, text) {
        const file = await this.dir.getFileHandle(name, {create: true})
        const writable = await file.createWritable()
        await writable.write(text)
        await writable.close()
      },
      async read(name) {
        return (await (await this.dir.getFileHandle(name)).getFile()).text()
      },
      names() {
        return names(this.dir)
      },
      names2() {
        return names(this.dir2)
      },
      remove(name) {
        return this.dir.removeEntry(name)
      },
      connect() {
        return globalThis.textarea.folderSync.connect(this.dir)
      },
      connect2() {
        return globalThis.textarea.folderSync.connect(this.dir2)
      },
      sync() {
        return globalThis.textarea.folderSync.sync()
      },
      disconnect() {
        return globalThis.textarea.folderSync.disconnect()
      },
    }
  })
  return {
    open: () => page.evaluate(() => globalThis.__sync.open()),
    open2: () => page.evaluate(() => globalThis.__sync.open2()),
    write: (name, text) => page.evaluate(([n, t]) => globalThis.__sync.write(n, t), [name, text]),
    read: (name) => page.evaluate((n) => globalThis.__sync.read(n), name),
    names: () => page.evaluate(() => globalThis.__sync.names()),
    names2: () => page.evaluate(() => globalThis.__sync.names2()),
    remove: (name) => page.evaluate((n) => globalThis.__sync.remove(n), name),
    connect: () => page.evaluate(() => globalThis.__sync.connect()),
    connect2: () => page.evaluate(() => globalThis.__sync.connect2()),
    sync: () => page.evaluate(() => globalThis.__sync.sync()),
    disconnect: () => page.evaluate(() => globalThis.__sync.disconnect()),
  }
}

/** The current note must be a library row before the first pass sees it. */
async function currentNoteStored() {
  await until(
    async () => (await (await import('/lib/library.js')).listDocuments()).length >= 1,
    {what: 'the current note to be stored'},
  )
}

/** The manifest as the sync holds it: what the last pass committed. */
async function syncManifest() {
  return page.evaluate(() => import('/lib/folder-sync.js').then((m) => m.folderSyncManifest()))
}

/** Whether a pause is armed: the timer that would run a pass on its own. */
async function syncPending() {
  return page.evaluate(() => import('/lib/folder-sync.js').then((m) => m.folderSyncPending()))
}

/**
 * Hold the next pass at the gate - after its plan, before its commit - which
 * is the window the two races live in and the one no test can reach from
 * outside, because it opens and shuts inside a single awaited pass.
 */
async function holdNextPass() {
  await page.evaluate(async () => {
    const {setFolderSyncGate} = await import('/lib/folder-sync.js')
    globalThis.__gateArrived = false
    globalThis.__gateRelease = new Promise((resolve) => {
      globalThis.__openGate = resolve
    })
    setFolderSyncGate(async () => {
      globalThis.__gateArrived = true
      await globalThis.__gateRelease
    })
  })
}

/** Stop holding anything, then let the held pass continue. */
async function releaseGate() {
  await page.evaluate(async () => {
    const {setFolderSyncGate} = await import('/lib/folder-sync.js')
    setFolderSyncGate(null)
    globalThis.__openGate()
  })
}

chromiumOnly('folder sync: connecting adopts the folder and writes the notes into it', async () => {
  const rig = await syncRig()
  await rig.open()

  // One file with a block, one without: both have to come out as notes, and
  // the plain one has to gain the block that keeps it this app's file.
  await rig.write(
    'Adopted.md',
    '---\nid: adopted-1\ncreated: 100\nupdated: 200\n---\n# Adopted\n\nfrom disk',
  )
  await rig.write('Plain.md', '# Plain note\n\nno block here')
  await currentNoteStored()

  const result = await rig.connect()
  assert.equal(result.name, 'sync-test')
  assert.ok(
    result.counts && result.counts.imported >= 2,
    `both waiting files become notes: ${JSON.stringify(result.counts)}`,
  )

  const titles = await page.evaluate(async () => {
    const lib = await import('/lib/library.js')
    return (await lib.listDocuments()).map((entry) => entry.title)
  })
  assert.ok(titles.includes('Adopted'), 'the file with a block keeps its id and title')
  assert.ok(titles.includes('Plain note'), 'plain markdown is adopted whole')

  assert.match(await rig.read('Plain.md'), /^---\nid: /, 'the adopted file gets its block back')

  const onDisk = await rig.names()
  assert.ok(onDisk.includes('Adopted.md'), 'an adopted file stays where it was')
  assert.ok(onDisk.includes('Textarea.md'), 'the note on screen has its file now, named after its title')
  assert.ok(onDisk.length >= 3, `nothing in the folder was removed: ${onDisk.join(', ')}`)
})

chromiumOnly('folder sync: an edit in the app lands in the file, an edit in the file lands in the note', async () => {
  const rig = await syncRig()
  await rig.open()
  await currentNoteStored()
  await rig.connect()

  // App -> folder: the debounced save and then the sync pass follow typing.
  await setNote('# Synced\n\nwritten in the app')
  await until(async () => (await globalThis.__sync.names()).includes('Synced.md'), {
    what: 'the note to reach the folder',
  })
  // Drain the queue before touching the file from outside: a name appearing
  // is the writable opening, not the write finishing.
  await rig.sync()
  assert.match(await rig.read('Synced.md'), /written in the app/)

  // Folder -> app: edited where nothing can be told about it, with an mtime
  // past everything the library has seen. The file wins, and the open note
  // is the half of the mirror that has to follow it. The wait is on the
  // outcome rather than on one pass's counts: a focus-triggered pass is
  // welcome to be the one that gets there first.
  const edited = (await rig.read('Synced.md')).replace('written in the app', 'written in the folder')
  await rig.write('Synced.md', edited)
  await rig.sync()
  await until(
    () => document.querySelector('article').textContent === '# Synced\n\nwritten in the folder',
    {what: 'the open note to follow the file'},
  )

  // The arrival carries the way back: the file just won over whatever was on
  // screen, and the reader is told how to undo in the same breath.
  const messages = await page.evaluate(() => globalThis.__messages)
  assert.equal(
    messages[messages.length - 1].text,
    'Updated from the folder — Ctrl+Z or ⌘Z undoes it',
    'the arrival says how to take it back',
  )

  // And the winner is stable: the next pass has nothing to argue about.
  const again = await rig.sync()
  assert.deepEqual(again, {written: 0, imported: 0, removed: 0})
})

chromiumOnly('folder sync: syncing now cancels the pause that was scheduled', async () => {
  const rig = await syncRig()
  await rig.open()
  await currentNoteStored()
  await rig.connect()

  // Reset's input runs its save 500ms later, and every save arms a pause for
  // the pass to come. Wait until that pause is actually standing - it is the
  // thing a sync below is supposed to take down with it rather than leave to
  // queue a second pass over what the first one just wrote.
  await until(() => import('/lib/folder-sync.js').then((m) => Boolean(m.folderSyncPending())), {
    what: 'the save to arm its pause',
  })

  await rig.sync()

  assert.equal(
    await syncPending(),
    null,
    'the sync took the pause with it instead of leaving a second pass behind',
  )
  await rig.disconnect()
})

chromiumOnly('folder sync: the menu row says how the mirror is going', async () => {
  const rig = await syncRig()
  await rig.open()
  await currentNoteStored()
  await rig.connect()

  // Read the way a screen reader reaches it: the menu item's accessible
  // name is the row's whole label, status line included.
  const label = async () =>
    (await page.getByRole('menuitem', {name: 'Folder sync'}).textContent()).trim()
  const closeMenu = async () => {
    await page.keyboard.press('Escape')
    await page.locator('#menu').waitFor({state: 'hidden'})
  }

  // The connect's own pass has run and found the folder holding everything.
  await openMenu()
  assert.equal(await label(), 'Folder sync: sync-test · Up to date')
  await closeMenu()

  // A pause armed for a pass that has not started yet: the row says the
  // wait. The long delay is so reading the label cannot race the pause
  // firing - what is being asserted is the state, not the timer's patience.
  await page.evaluate(() => import('/lib/folder-sync.js').then((m) => m.scheduleSync(60_000)))
  await openMenu()
  assert.equal(await label(), 'Folder sync: sync-test · Waiting to sync')
  await closeMenu()

  // A pass held at the gate is on the move, and that outranks everything:
  // the sync asked for here also took the pause above with it.
  await holdNextPass()
  const held = rig.sync()
  await until(() => globalThis.__gateArrived, {what: 'the pass to reach the gate'})
  await openMenu()
  assert.equal(await label(), 'Folder sync: sync-test · Syncing…')
  await closeMenu()

  await releaseGate()
  await held
  await rig.disconnect()
})

chromiumOnly('folder sync: a pass that fails says so out loud and keeps saying so', async () => {
  const rig = await syncRig()
  await rig.open()
  await currentNoteStored()
  await rig.connect()

  // Take the folder away under the sync: the next pass cannot read it, and
  // the failure is the app's to report rather than to swallow.
  await page.evaluate(() =>
    navigator.storage
      .getDirectory()
      .then((root) => root.removeEntry('sync-test', {recursive: true})),
  )
  await rig.sync()

  // Announced while it happens - assertive, because a mirror the reader
  // cannot see failing is worse than no mirror - and in the bubble's own
  // error state rather than as an ordinary message.
  const bubble = page.locator('#notification')
  assert.equal(await bubble.getAttribute('aria-live'), 'assertive', 'a failed pass interrupts')
  assert.ok(await bubble.evaluate((el) => el.classList.contains('error')), 'the bubble shows it as an error')
  assert.ok((await bubble.textContent()).trim().length > 0, 'the failure has words')

  // And it outlasts the bubble: the row keeps the answer until a pass
  // succeeds again, so the state is still readable a minute later.
  await openMenu()
  const row = await page.getByRole('menuitem', {name: 'Folder sync'}).textContent()
  assert.equal(
    row.trim(),
    'Folder sync: sync-test · Sync problem',
    'the row keeps the verdict after the bubble moves on',
  )
  await page.keyboard.press('Escape')
  await page.locator('#menu').waitFor({state: 'hidden'})

  await rig.disconnect()
})

chromiumOnly('folder sync: the menu offers a sync now that says what it did', async () => {
  const rig = await syncRig()
  await rig.open()
  await currentNoteStored()
  await rig.connect()

  // Not there while sync is off: the row acts on a folder, so it exists only
  // when there is one.
  await rig.disconnect()
  await openMenu()
  assert.equal(
    await page.getByRole('menuitem', {name: 'Sync now'}).count(),
    0,
    'no folder, no sync row',
  )
  await page.keyboard.press('Escape')
  await page.locator('#menu').waitFor({state: 'hidden'})

  // Back on, with an edit the folder has not seen: the pass this asks for
  // has something to do, and the bubble says what it did.
  await rig.connect()
  await setNote('pressed the button')
  await saveNow()
  await openMenu()
  assert.equal(
    await page.getByRole('menuitem', {name: 'Sync now'}).count(),
    1,
    'the row appears with a folder connected',
  )
  await page.getByRole('menuitem', {name: 'Sync now'}).click()
  await page.locator('#menu').waitFor({state: 'hidden'})
  await until(
    () => /^Synced — .*1 written/.test(
      globalThis.__messages[globalThis.__messages.length - 1]?.text ?? '',
    ),
    {what: 'the sync now to report what it wrote'},
  )

  // Asked again with nothing left to do, it says so plainly.
  await openMenu()
  await page.getByRole('menuitem', {name: 'Sync now'}).click()
  await until(
    () =>
      (globalThis.__messages[globalThis.__messages.length - 1]?.text ?? '') ===
      'Nothing to sync — the folder is in step',
    {what: 'the second sync now to find nothing to do'},
  )

  await rig.disconnect()
})

chromiumOnly('folder sync: a folder remembered from the last session asks for it back', async () => {
  const rig = await syncRig()
  await rig.open()
  await currentNoteStored()
  await rig.connect()

  // The boot path, called directly: the record is read back, the permission
  // granted, and the first pass armed. The record comes from a stand-in for
  // the one table this reads, because a test that takes a real directory
  // handle out of storage takes this build's Chromium down with it - what is
  // under test here is the permission gate, not the storage.
  const restored = await page.evaluate(async () => {
    const sync = await import('/lib/folder-sync.js')
    const factory = globalThis.indexedDB
    const realOpen = factory.open
    factory.open = (name, version) => {
      if (name !== 'textarea-sync') return realOpen.call(factory, name, version)
      const request = {}
      queueMicrotask(() => {
        request.result = {
          close: () => {},
          transaction: () => ({
            objectStore: () => ({
              get: () => {
                const get = {}
                queueMicrotask(() => {
                  get.result = {
                    id: 'folder',
                    handle: {
                      name: 'sync-test',
                      queryPermission: async () => 'granted',
                      requestPermission: async () => 'granted',
                    },
                    manifest: {},
                  }
                  get.onsuccess?.()
                })
                return get
              },
            }),
          }),
        }
        request.onsuccess?.()
      })
      return request
    }
    try {
      return {name: await sync.restoreFolder(), status: sync.folderSyncStatus()}
    } finally {
      delete factory.open
    }
  })

  assert.equal(restored.name, 'sync-test', 'the remembered folder comes back by name')
  assert.equal(restored.status.active, true, 'and sync runs again')
  assert.ok(restored.status.pending, 'the first pass is armed for it')

  // Stopping is final, and this read is the real one: an empty table, the
  // same read every page load already performs.
  await rig.disconnect()
  const after = await page.evaluate(async () => {
    const sync = await import('/lib/folder-sync.js')
    return sync.restoreFolder()
  })
  assert.equal(after, null, 'a stopped folder does not come back on its own')
})

chromiumOnly('folder sync: a remembered folder that is not allowed says so and keeps its name', async () => {
  const rig = await syncRig()
  await rig.open()
  await currentNoteStored()

  // What a reload looks like when the allow was revoked between sessions:
  // the record is there, the handle asks, the browser says no. The record
  // comes from a stand-in for the one table this reads, since a refused
  // permission is not something the harness can provoke for real - and the
  // stand-in is gone again before anything else touches storage.
  const denied = await page.evaluate(async () => {
    const factory = globalThis.indexedDB
    const realOpen = factory.open
    factory.open = (name, version) => {
      if (name !== 'textarea-sync') return realOpen.call(factory, name, version)
      const request = {}
      queueMicrotask(() => {
        request.result = {
          close: () => {},
          transaction: () => ({
            objectStore: () => ({
              get: () => {
                const get = {}
                queueMicrotask(() => {
                  get.result = {
                    id: 'folder',
                    handle: {
                      name: 'sync-test',
                      queryPermission: async () => 'denied',
                      requestPermission: async () => 'denied',
                    },
                    manifest: {},
                  }
                  get.onsuccess?.()
                })
                return get
              },
            }),
          }),
        }
        request.onsuccess?.()
      })
      return request
    }
    try {
      const sync = await import('/lib/folder-sync.js')
      return {name: await sync.restoreFolder(), status: sync.folderSyncStatus()}
    } finally {
      delete factory.open
    }
  })

  assert.equal(denied.name, null, 'the refused folder does not come back as sync')
  assert.equal(denied.status.active, false, 'and sync stays off')
  assert.equal(denied.status.name, 'sync-test', 'but the folder is still remembered')

  // The reader is told what is missing and what would put it right - not as
  // an error, because one click on the row does exactly that.
  const message = await page.evaluate(
    () => globalThis.__messages[globalThis.__messages.length - 1],
  )
  assert.equal(
    message?.text,
    'Folder sync needs permission for "sync-test" again',
    'the refusal is announced with the folder named',
  )
  assert.equal(message?.isError, false, 'it is an ask, not a failure')

  // And the row still names the folder it is waiting for, so the click has
  // somewhere to go.
  await openMenu()
  assert.equal(
    (await page.getByRole('menuitem', {name: 'Folder sync'}).textContent()).trim(),
    'Folder sync: sync-test',
    'the remembered folder keeps its name while it waits',
  )
  await page.keyboard.press('Escape')
  await page.locator('#menu').waitFor({state: 'hidden'})

  await rig.disconnect()
})

chromiumOnly('folder sync: a hand-mangled front matter block still lands as a note', async () => {
  const rig = await syncRig()
  await rig.disconnect()
  await rig.open()
  await currentNoteStored()
  await rig.connect()

  // Two ways a hand edit goes wrong. A block full of noise: every line is
  // taken on its own merits, junk is skipped, and the text below the block
  // arrives clean. A block that never closes: there is no block, so the
  // whole file is the note - fences included - rather than a failure the
  // reader never asked for.
  await rig.write('Noisy.md', '---\n!!junk ][\nunclosed: :\n---\n# Noisy note\n\nbody text')
  await rig.write('Loose.md', '---\nnever closed\n# Loose note\n\nstill here')

  // A file without an id of its own gets one stamped back, which is the
  // second half of each import: 2 in, 2 written, nothing removed.
  const counts = await rig.sync()
  assert.deepEqual(
    counts,
    {written: 2, imported: 2, removed: 0},
    'both broken files land without stopping the pass',
  )

  const notes = await page.evaluate(async () => {
    const lib = await import('/lib/library.js')
    return (await lib.listDocuments()).map((entry) => ({title: entry.title, text: entry.text}))
  })
  const noisy = notes.find((note) => note.title === 'Noisy note')
  assert.ok(noisy, 'the closed block parses down to its heading')
  assert.equal(noisy.text, '# Noisy note\n\nbody text', 'the noise stayed in the block')
  const loose = notes.find((note) => note.text.startsWith('---'))
  assert.ok(loose, 'the unclosed block keeps every line of the file')

  await rig.disconnect()
})

chromiumOnly('folder sync: an emptied library takes the folder files with it', async () => {
  const rig = await syncRig()
  await rig.disconnect()
  await rig.open()
  await currentNoteStored()
  await rig.connect()

  // Every row gone without the sync being told: storage cleared behind its
  // back, another tab, a hook that crashed. The manifest still points at the
  // files, which is what makes removing them the other half of a deletion
  // rather than a folder to wipe.
  const deleted = await page.evaluate(async () => {
    const lib = await import('/lib/library.js')
    const entries = await lib.listDocuments()
    for (const entry of entries) await lib.deleteDocument(entry.id)
    return entries.length
  })
  assert.equal(deleted, 1, 'the library held exactly the note reset wrote')

  const counts = await rig.sync()
  assert.deepEqual(
    counts,
    {written: 0, imported: 0, removed: deleted},
    'every file follows the note it mirrored, and none comes back',
  )
  assert.deepEqual(await rig.names(), [], 'the folder ends empty')
  assert.deepEqual(await syncManifest(), {}, 'and the slots forget themselves too')

  await rig.disconnect()
})

chromiumOnly('folder sync: a file deleted in the Finder takes its note along', async () => {
  const rig = await syncRig()
  await rig.open()
  await currentNoteStored()
  await rig.connect()

  await setNote('# Doomed\n\nto be deleted')
  // The chain is not what this test is about - only the file's existence -
  // so save and pass directly rather than waiting the debounce out.
  await saveNow()
  await rig.sync()
  await until(async () => (await globalThis.__sync.names()).includes('Doomed.md'), {
    what: 'the note to reach the folder',
  })

  // The mirror's other direction: tracked file gone means the note goes too.
  await rig.remove('Doomed.md')
  await rig.sync()
  await until(
    async () => {
      const lib = await import('/lib/library.js')
      return !(await lib.listDocuments()).some((entry) => entry.title === 'Doomed')
    },
    {what: 'the note to follow its file'},
  )

  // Exactly that one pair went: the folder is empty, and nothing else in it
  // was touched.
  assert.deepEqual(await rig.names(), [])
})

chromiumOnly('folder sync: deleting in the panel deletes the file, and stopping keeps the files', async () => {
  const rig = await syncRig()
  await rig.open()
  await currentNoteStored()
  await rig.connect()

  // A second note, made through the panel so the delete hook is the one under
  // test rather than a direct library call. The editor is empty after reset,
  // so "New note" asks nothing and just starts the row.
  await openMenu()
  await page.locator('#menu-documents').click()
  const panel = page.locator('dialog.dialog-library')
  await panel.waitFor({state: 'visible'})
  await panel.getByRole('button', {name: 'New note'}).click()
  await panel.waitFor({state: 'detached'})
  await setNote('# Panel note\n\nbody')
  // Save and pass directly: the chain from typing to file has a test of its
  // own; here the file is just what the delete needs to exist.
  await saveNow()
  await rig.sync()
  await until(async () => (await globalThis.__sync.names()).includes('Panel note.md'), {
    what: 'the second note to reach the folder',
  })

  await openMenu()
  await page.locator('#menu-documents').click()
  await panel.waitFor({state: 'visible'})
  await panel.locator('.document-row:not(.document-row-empty)').first().waitFor()
  await panel
    .locator('.document-row')
    .filter({hasText: 'Panel note'})
    .locator('.document-delete')
    .click()
  const confirm = page.locator('dialog.dialog-confirm')
  await confirm.waitFor({state: 'visible'})
  await confirm.getByRole('button', {name: 'Delete'}).click()
  await confirm.waitFor({state: 'detached'})

  await until(async () => !(await globalThis.__sync.names()).includes('Panel note.md'), {
    what: 'the deleted note to take its file',
  })

  // Stopping is not emptying: the folder keeps everything, and further typing
  // never reaches it again.
  const before = await rig.names()
  await rig.disconnect()

  await setNote('# After stop\n\nno mirror')
  // Save, then let the queue empty. A stopped sync finishes the pass it was
  // already in, and once the queue is empty nothing more can start: the sync
  // is off, and scheduleSync returns before it sets a timer. This waits for
  // that condition instead of guessing at "debounce plus sync delay".
  await saveNow()
  await page.evaluate(() => import('/lib/folder-sync.js').then((m) => m.folderSyncIdle()))
  const after = await rig.names()
  assert.deepEqual(after.sort(), before.sort(), 'a stopped sync writes nothing')
})

chromiumOnly('folder sync: an oversized file is left untouched and the pass carries on', async () => {
  const rig = await syncRig()
  await rig.open()

  // One byte over the per-file budget, wearing a note's face: if the file
  // were ever read, its title would become a row in the library.
  await page.evaluate(async () => {
    const {MAX_SYNC_FILE_BYTES: limit} = await import('/lib/folder-sync.js')
    await globalThis.__sync.write('Huge.md', '# Huge\n\n' + 'a'.repeat(limit))
  })
  await currentNoteStored()

  const result = await rig.connect()
  assert.ok(result.counts, `the pass completed: ${JSON.stringify(result.counts)}`)
  assert.ok(result.counts.written >= 1, 'the notes still reached the folder around it')

  const untouched = await page.evaluate(async () => {
    const handle = await globalThis.__sync.dir.getFileHandle('Huge.md')
    const blob = await handle.getFile()
    return {size: blob.size, head: (await blob.slice(0, 12).text())}
  })
  assert.equal(untouched.size, MAX_SYNC_FILE_BYTES + 8, 'the file is byte for byte what it was')
  assert.equal(untouched.head, '# Huge\n\naaaa', 'and still opens with its own title')

  const titles = await page.evaluate(async () => {
    const lib = await import('/lib/library.js')
    return (await lib.listDocuments()).map((entry) => entry.title)
  })
  assert.ok(!titles.includes('Huge'), 'a file too big to read is never imported')

  const onDisk = await rig.names()
  assert.ok(onDisk.includes('Huge.md'), 'and never removed either')
  assert.ok(onDisk.some((name) => name !== 'Huge.md'), 'the rest of the folder still synced')

  // Leave no saved handle behind: a test that boots after this one must not
  // have a restored pass from this folder land in the middle of its own.
  await rig.disconnect()
})

chromiumOnly('folder sync: a deletion queued mid-pass is not resurrected by that pass', async () => {
  const rig = await syncRig()
  await rig.disconnect()
  await rig.open()
  await currentNoteStored()
  await rig.connect()

  await setNote('# Held note\n\nbody')
  // Save and pass directly: what this needs is the file on disk and an empty
  // chain - syncing cancels the pause the save armed, so no timer is left to
  // chain anything onto the pass below, which is the pass that gets held.
  await saveNow()
  await rig.sync()
  await until(async () => (await globalThis.__sync.names()).includes('Held note.md'), {
    what: 'the note to reach the folder',
  })
  const id = await page.evaluate(() => globalThis.textarea.documentId)

  await holdNextPass()
  const held = rig.sync()
  await until(() => globalThis.__gateArrived, {what: 'the pass to reach the gate'})

  // The panel's delete: the row first, then the hook. The hook has to queue
  // behind the pass in flight; run beside it, that pass's commit would put
  // the deleted note's slot back - and a slot is what authorises a removal,
  // so a later file sharing the name would then count as tracked.
  await page.evaluate(async (noteId) => {
    const lib = await import('/lib/library.js')
    const {noteDeleted} = await import('/lib/folder-sync.js')
    await lib.deleteDocument(noteId)
    globalThis.__deletion = noteDeleted(noteId)
  }, id)
  await releaseGate()

  await held
  await page.evaluate(() => globalThis.__deletion)

  // The held pass committed a plan built while the note still existed; the
  // queued deletion has to have the last word on both halves of the pair.
  assert.ok(!(await rig.names()).includes('Held note.md'), 'the deleted note took its file')
  const manifest = await syncManifest()
  assert.ok(!manifest[id], `the slot is gone too: ${JSON.stringify(manifest)}`)
})

chromiumOnly('folder sync: a pass held across a disconnect cannot commit over the new folder', async () => {
  const rig = await syncRig()
  await rig.disconnect()
  await rig.open()
  await rig.open2()
  await currentNoteStored()
  await rig.connect()

  await setNote('# Held note\n\nbody')
  // As above: the file, the empty chain, and no timer left running.
  await saveNow()
  await rig.sync()
  await until(async () => (await globalThis.__sync.names()).includes('Held note.md'), {
    what: 'the note to reach the folder',
  })
  const before = await page.evaluate(async () => {
    const lib = await import('/lib/library.js')
    return (await lib.listDocuments()).map((entry) => entry.id)
  })

  await holdNextPass()
  const held = rig.sync()
  await until(() => globalThis.__gateArrived, {what: 'the pass to reach the gate'})

  // Point the sync at a second folder while the first folder's pass is held.
  // Its plan names files that do not exist over there, so a commit would let
  // the next pass read every note as deleted in the Finder.
  await page.evaluate(async () => {
    await globalThis.__sync.disconnect()
    globalThis.__reconnect = globalThis.__sync.connect2()
  })
  await releaseGate()

  assert.equal(await held, null, 'the held pass belongs to a folder no longer connected')
  const result = await page.evaluate(() => globalThis.__reconnect)
  assert.ok(result?.counts, `the second folder synced: ${JSON.stringify(result)}`)

  const after = await page.evaluate(async () => {
    const lib = await import('/lib/library.js')
    return (await lib.listDocuments()).map((entry) => entry.id)
  })
  assert.deepEqual(after.sort(), before.sort(), `no note fell to the first folder's plan`)

  const inSecond = await rig.names2()
  assert.ok(
    inSecond.includes('Held note.md'),
    `the notes were mirrored into the second folder: ${inSecond.join(', ')}`,
  )
})

chromiumOnly('folder sync: a second tab waits for the pass already running', async () => {
  const rig = await syncRig()
  await rig.disconnect()
  await rig.open()

  // The second tab is opened and loaded before page one connects. Booting the
  // app over a live folder-sync record crashed this headless Chromium build
  // outright - the same nondeterministic fate as reading that record from the
  // test - and a tab that restored nothing is also a tab that does nothing
  // until it is asked: no timer of its own to reason about.
  const second = await context.newPage()
  try {
    await second.goto(server.origin + '/')
    await second.waitForFunction(() => Boolean(globalThis.textarea))

    await currentNoteStored()
    await rig.connect()
    assert.ok(
      await page.evaluate(() => Boolean(navigator?.locks)),
      'this browser offers the Web Locks API',
    )

    // Tab one holds a pass open: the lock is taken, the commit not reached.
    await holdNextPass()
    const held = rig.sync()
    await until(() => globalThis.__gateArrived, {what: 'the first pass to reach the gate'})

    // Tab two points at the same folder. Its first pass may not start while
    // tab one's holds the lock: passing alongside would interleave writes in
    // the folder and commit the one shared manifest over the other.
    await second.evaluate(async () => {
      const root = await navigator.storage.getDirectory()
      const dir = await root.getDirectoryHandle('sync-test', {create: true})
      globalThis.__secondConnect = globalThis.textarea.folderSync.connect(dir)
      globalThis.__secondConnect.then(
        () => {
          globalThis.__secondSettled = true
        },
        () => {
          globalThis.__secondSettled = 'failed'
        },
      )
    })

    // A fixed wait is honest for a negative claim: four hundred milliseconds
    // with the lock held is four hundred milliseconds a passing tab would
    // have used.
    await second.waitForTimeout(400)
    assert.equal(
      await second.evaluate(() => globalThis.__secondSettled ?? false),
      false,
      'the second tab waits its turn instead of passing alongside',
    )

    await releaseGate()
    await held
    await second.waitForFunction(() => globalThis.__secondSettled === true, {timeout: 30_000})
    assert.equal(
      await second.evaluate(() => globalThis.__secondSettled),
      true,
      'and goes once the lock is free',
    )

    await second.evaluate(() => globalThis.textarea.folderSync.disconnect())
  } finally {
    await second.close()
  }
})

// The console gate has to be the last thing in the file: node:test runs a
// file's tests in declaration order, so this judges every test declared above
// it and none below. It sat mid-file while sixteen folder sync tests grew
// underneath it, its comment calling it "the last test in the suite" - so new
// tests go above this, never after it.
test('an edit redraws only the part of the note it touched', async () => {
  const note = '# Title\n\n**bold** one\n\n`code` two\n\n*slanted* three\n\n~~struck~~ four'
  await setNote(note)

  const result = await page.evaluate(async (text) => {
    const {parseMarkdown} = await import('/lib/markdown.js')
    const {article, editor} = globalThis.textarea
    const rebuilt = (value) => {
      const scratch = document.createElement('article')
      parseMarkdown(scratch, {}, value)
      return scratch.innerHTML
    }
    const report = {}

    // An insertion in the middle: the nodes above and below are the very
    // same objects afterwards, not equal copies of them.
    const before = [...article.childNodes]
    const at = text.indexOf('two')
    editor.select(at, at)
    editor.insert('2 and ')
    const after = [...article.childNodes]
    report.text = article.textContent
    report.headKept = after[0] === before[0] && after[1] === before[1] && after[2] === before[2]
    report.tailKept = after.at(-1) === before.at(-1) && after.at(-2) === before.at(-2)
    report.sameAsRebuild = article.innerHTML === rebuilt(article.textContent)

    // A run of identical lines is the case a careless two-ended match gets
    // wrong: growing and shrinking it must still land on the rebuilt tree.
    report.repeats = []
    for (const value of ['**a**', '**a****a**', '**a**', '', '- x\n- x', '- x\n- x\n- x', '- x', text]) {
      editor.replace(value)
      report.repeats.push(article.textContent === value && article.innerHTML === rebuilt(value))
    }
    return report
  }, note)

  assert.equal(result.text, note.replace('two', '2 and two'))
  assert.equal(result.headKept, true, 'the nodes above the edit were left in place')
  assert.equal(result.tailKept, true, 'the nodes below the edit were left in place')
  assert.equal(result.sameAsRebuild, true, 'the patched tree is the tree a full rebuild draws')
  assert.deepEqual(result.repeats, result.repeats.map(() => true))
})

test('axe finds no WCAG A or AA failure in either theme, on the page or in its panels', async () => {
  // axe-core is a devDependency read off disk and evaluated through the
  // debugger, so it never passes the Content-Security-Policy as a script of
  // the page and never ships with it. The rule set is WCAG 2.x level A and
  // AA - contrast, names, roles, language - with nothing switched off.
  const axe = await fs.readFile(new URL('../../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8')
  const failures = []
  const scan = async (where) => {
    // Past the fades: a dialog still fading in is measured at a contrast
    // nobody ever reads it at.
    await page.waitForTimeout(350)
    const violations = await page.evaluate(async () => {
      const result = await globalThis.axe.run(document, {
        runOnly: {type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']},
        resultTypes: ['violations'],
      })
      return result.violations.map(
        (violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`,
      )
    })
    for (const violation of violations) failures.push(`${where} - ${violation}`)
  }

  for (const theme of ['light', 'dark']) {
    await page.evaluate(() => {
      for (const key of ['stats', 'backlinks', 'writing', 'wikilinks', 'tasks']) {
        localStorage.setItem(`textarea:${key}`, 'on')
      }
      // A kept search, so My documents is scanned with every kind of chip
      // it can show; the tag in the note below supplies the other kind.
      localStorage.setItem('textarea:filters', '[{"name":"Tagged","query":"#tagged"}]')
    })
    await page.goto(`${server.origin}/?theme=${theme}`)
    await page.waitForFunction(() => Boolean(globalThis.textarea))
    await setNote(
      '# Title\n\nSome **bold**, *slanted*, ~~struck~~ and `code`.\n\n' +
        'https://example.com and mail@example.com and [[Other]]\n\n' +
        '- [ ] a task\n- [x] done\n1. one\n\n```\nfence\n```\n\n#tagged\n',
    )
    await saveNow()
    await page.evaluate(axe)

    await scan(`${theme}: the note with its panels`)

    // The menu and the dialogs are measured without the side panels behind
    // them: the menu opens over the writing panel, and a target that is
    // covered on purpose is not a target that is too small.
    await page.evaluate(() => {
      for (const key of ['stats', 'backlinks', 'writing']) localStorage.removeItem(`textarea:${key}`)
    })
    await page.reload()
    await page.waitForFunction(() => Boolean(globalThis.textarea))
    await page.evaluate(axe)
    await openMenu()
    await scan(`${theme}: the menu`)
    await page.keyboard.press('Escape')

    // The speech panel has no remembered state to reload into, so it is
    // opened from its row and measured on its own, with a transcript on show.
    await openMenu()
    await page.locator('#menu-speech').click()
    await page.locator('#speech-panel').waitFor({state: 'visible'})
    await page.evaluate(() => {
      const panel = document.querySelector('#speech-panel')
      panel.querySelector('.writing-output').textContent = 'A transcript.'
      panel.querySelector('.writing-result').hidden = false
    })
    await scan(`${theme}: the speech panel`)
    await page.locator('#speech-panel .writing-close').click()

    for (const row of ['settings', 'documents', 'export', 'encryption', 'trash']) {
      await openMenu()
      await page.locator(`#menu-${row}`).click()
      await page.locator('dialog[open]').waitFor({state: 'visible'})
      await scan(`${theme}: ${row}`)
      await page.keyboard.press('Escape')
      await page.locator('dialog[open]').waitFor({state: 'detached'})
    }

    await page.keyboard.press('Control+f')
    await page.locator('.find-body').waitFor({state: 'visible'})
    await scan(`${theme}: find`)
    await page.keyboard.press('Escape')
    await page.keyboard.press('Control+k')
    await page.locator('dialog[open]').waitFor({state: 'visible'})
    await scan(`${theme}: the quick switcher`)
    await page.keyboard.press('Escape')
    await page.locator('dialog[open]').waitFor({state: 'hidden'})

    // The command palette, which is off until asked for.
    await page.evaluate(() => localStorage.setItem('textarea:palette', 'on'))
    await page.keyboard.press('Control+Shift+P')
    await page.locator('dialog[open] [role="option"]').first().waitFor()
    await scan(`${theme}: the command palette`)
    await page.keyboard.press('Escape')
    await page.locator('dialog[open]').waitFor({state: 'hidden'})
    await page.evaluate(() => localStorage.removeItem('textarea:palette'))

    // The QR panel, reached the way a reader reaches it: through Export.
    await page.keyboard.press('Control+s')
    const exporting = page.locator('dialog.dialog[aria-label="Export"]')
    await exporting.waitFor({state: 'visible'})
    await exporting.locator('input[name=destination][value=qr]').check({force: true})
    await exporting.locator('.dialog-button-primary').click()
    await page.locator('dialog.dialog-qr svg').first().waitFor({state: 'visible', timeout: 30_000})
    await scan(`${theme}: the QR panel`)
    await page.keyboard.press('Escape')
    await page.locator('dialog.dialog-qr').waitFor({state: 'detached'})
  }

  // Leave the next test the profile it expects.
  await page.evaluate(() => {
    for (const key of ['stats', 'backlinks', 'writing', 'wikilinks', 'tasks', 'filters']) {
      localStorage.removeItem(`textarea:${key}`)
    }
  })
  await page.goto(server.origin + '/')
  await page.waitForFunction(() => Boolean(globalThis.textarea))

  assert.deepEqual(failures, [])
})

test('the page says what language it is in and gives the note a landmark', async () => {
  await freshEditor()
  assert.equal(await page.evaluate(() => document.documentElement.lang), 'en')
  assert.equal(await page.locator('main > article[role="textbox"]').count(), 1)
  // The wrapper draws nothing: the article is laid out as if it were alone.
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('main')).display), 'contents')
})

test('a reader who asks for less motion gets none of the decoration', async () => {
  await page.emulateMedia({reducedMotion: 'reduce'})
  try {
    await freshEditor()
    await openMenu()
    const longest = await page.evaluate(() => {
      const seconds = (value) => Math.max(...value.split(',').map((part) => parseFloat(part) || 0))
      let worst = 0
      for (const element of document.querySelectorAll('#menu, #menu .item, #button, #notification')) {
        const style = getComputedStyle(element)
        worst = Math.max(worst, seconds(style.transitionDuration), seconds(style.animationDuration))
      }
      return worst
    })
    assert.ok(longest < 0.001, `no transition or animation runs, got ${longest}s`)
    // The menu still opens and still closes: only the motion went.
    await page.keyboard.press('Escape')
    await page.locator('#menu').waitFor({state: 'hidden'})
  } finally {
    await page.emulateMedia({reducedMotion: null})
  }
})

test('the keyboard reaches the menu from the note, and can see where it is', async () => {
  await freshEditor()
  await page.locator('article').focus()
  // Safari on macOS keeps plain Tab for form fields and gives buttons to
  // Option+Tab unless full keyboard access is on; WebKit elsewhere does not.
  await page.keyboard.press(ENGINE_NAME === 'webkit' && process.platform === 'darwin' ? 'Alt+Tab' : 'Tab')
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'button')
  const outline = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle)
  assert.notEqual(outline, 'none', 'the focused menu button shows a focus ring')
  await page.keyboard.press('Enter')
  await page.locator('#menu').waitFor({state: 'visible'})
  await page.keyboard.press('ArrowDown')
  const item = await page.evaluate(() => {
    const element = document.activeElement
    return {inMenu: Boolean(element?.closest('#menu')), outline: getComputedStyle(element).outlineStyle}
  })
  assert.equal(item.inMenu, true)
  assert.notEqual(item.outline, 'none', 'the focused menu row shows a focus ring')
  await page.keyboard.press('Escape')
})

test('the command palette is off until asked for, then lists the menu and runs a row', async () => {
  await freshEditor()
  const palette = page.locator('dialog.dialog-switcher[aria-label="Command palette"]')

  // Off as it ships: the chord is the browser's, and nothing is built.
  await page.keyboard.press('Control+Shift+P')
  await page.waitForTimeout(150)
  assert.equal(await palette.count(), 0)

  await page.evaluate(() => localStorage.setItem('textarea:palette', 'on'))
  try {
    await page.keyboard.press('Control+Shift+P')
    await palette.waitFor({state: 'visible'})
    await palette.locator('[role="option"]').first().waitFor()

    // Every visible menu row is in the list, under the label the menu shows,
    // and so are the two features that live on a chord instead of a row.
    const listed = await palette.locator('.switcher-name').allTextContents()
    const rows = await page.evaluate(() =>
      [...document.querySelectorAll('#menu .item:not([hidden])')].map((row) =>
        row.textContent.trim().replace(/\s+/g, ' '),
      ),
    )
    assert.ok(rows.length > 10, 'the menu has its rows')
    for (const row of rows) assert.ok(listed.includes(row), `${row} is offered`)
    assert.ok(listed.includes('Find and replace'))
    assert.ok(listed.includes('Jump to a note'))
    // Its ids are its own, so it can share the page with the note switcher.
    assert.equal(await palette.locator('[role="listbox"]').getAttribute('id'), 'palette-list')

    // Typing narrows it, Enter runs what is left: the Export panel opens.
    await page.keyboard.type('expor')
    assert.deepEqual(await palette.locator('.switcher-name').allTextContents(), ['Export'])
    await page.keyboard.press('Enter')
    await page.locator('dialog.dialog[aria-label="Export"]').waitFor({state: 'visible'})
    assert.equal(await palette.isVisible(), false)
    await page.keyboard.press('Escape')

    // The chord closes it as well as opens it.
    await page.keyboard.press('Control+Shift+P')
    await palette.waitFor({state: 'visible'})
    await page.keyboard.press('Control+Shift+P')
    await palette.waitFor({state: 'hidden'})
  } finally {
    await page.evaluate(() => localStorage.removeItem('textarea:palette'))
  }
})

test('the documents panel sorts by edit, by creation and by title, and remembers which', async () => {
  await page.evaluate(async () => {
    const library = await import('/lib/library.js')
    // created and updated disagree on purpose, so each order is its own.
    await library.putDocument({id: 'sort-b', title: 'banana', text: '# banana', created: 300, updated: 100})
    await library.putDocument({id: 'sort-a', title: 'Apple', text: '# Apple', created: 100, updated: 300})
    await library.putDocument({id: 'sort-c', title: 'cherry 10', text: '# cherry 10', created: 200, updated: 200})
  })
  const titles = async () => {
    const all = await page.locator('dialog.dialog-library .document-title').allTextContents()
    return all.filter((title) => /^(Apple|banana|cherry 10)$/.test(title))
  }
  try {
    await openMenu()
    await page.locator('#menu-documents').click()
    const panel = page.locator('dialog.dialog-library')
    await panel.locator('.document-title').first().waitFor()
    const order = panel.getByLabel('Sort notes by')
    assert.equal(await order.inputValue(), 'updated', 'the order it always had is the one it opens in')
    assert.deepEqual(await titles(), ['Apple', 'cherry 10', 'banana'])

    // The list is redrawn after a library read, so the new order is waited
    // for rather than read on the next line.
    const settled = async (expected) => {
      for (let tries = 0; tries < 100; tries++) {
        if ((await titles()).join() === expected.join()) break
        await page.waitForTimeout(40)
      }
      assert.deepEqual(await titles(), expected)
    }
    await order.selectOption('created')
    await settled(['banana', 'cherry 10', 'Apple'])

    await order.selectOption('title')
    await settled(['Apple', 'banana', 'cherry 10'])
    assert.equal(await page.evaluate(() => localStorage.getItem('textarea:library-sort')), 'title')

    // Closed and opened again, it is still by title.
    await page.keyboard.press('Escape')
    await panel.waitFor({state: 'detached'})
    await openMenu()
    await page.locator('#menu-documents').click()
    await panel.locator('.document-title').first().waitFor()
    assert.equal(await panel.getByLabel('Sort notes by').inputValue(), 'title')
    await page.keyboard.press('Escape')
  } finally {
    await page.evaluate(() => localStorage.removeItem('textarea:library-sort'))
  }
})

/** My documents, opened from the menu and waited for. */
async function openDocuments() {
  await openMenu()
  await page.locator('#menu-documents').click()
  const panel = page.locator('dialog.dialog-library')
  await panel.locator('.document-row').first().waitFor()
  return panel
}

/** The titles on the cards, once they are the ones expected. */
async function cardTitles(panel, expected) {
  const titles = () => panel.locator('.document-row:not(.document-row-empty) .document-title').allTextContents()
  for (let tries = 0; tries < 100; tries++) {
    if ((await titles()).join() === expected.join()) break
    await page.waitForTimeout(40)
  }
  assert.deepEqual(await titles(), expected)
}

test('a tag is drawn in the note, counted in My documents, and filters the list', async () => {
  const note = '# Groceries\n\nmilk #home and item #1'
  await setNote(note)
  await saveNow()
  try {
    // Drawn, and only the tag: the text of the note is what was typed.
    assert.deepEqual(await page.locator('article .md-tag').allTextContents(), ['#home'])
    assert.equal(await noteText(), note)

    await page.evaluate(async () => {
      const library = await import('/lib/library.js')
      await library.putDocument({id: 'tag-plain', title: 'Plain', text: '# Plain\n\nno tag', updated: 100})
      await library.putDocument({id: 'tag-nested', title: 'Chores', text: '# Chores\n\n#home/garden', updated: 50})
    })
    const panel = await openDocuments()
    await cardTitles(panel, ['Groceries', 'Plain', 'Chores'])

    // The chip counts the notes that carry the tag itself; the filter it
    // writes also finds the tags nested under it.
    const chip = panel.locator('.library-chip', {hasText: /^#home 1$/})
    assert.equal(await chip.getAttribute('aria-pressed'), 'false')
    await chip.click()
    await cardTitles(panel, ['Groceries', 'Chores'])
    assert.equal(await panel.locator('.dialog-search').inputValue(), '#home')
    assert.equal(await panel.locator('.library-chip', {hasText: /^#home 1$/}).getAttribute('aria-pressed'), 'true')

    // The same chip takes the filter back out.
    await panel.locator('.library-chip', {hasText: /^#home 1$/}).click()
    await cardTitles(panel, ['Groceries', 'Plain', 'Chores'])
    await page.keyboard.press('Escape')
    await panel.waitFor({state: 'detached'})

    // The switch is only how a note draws its tags.
    await page.evaluate(() => localStorage.setItem('textarea:tags', 'off'))
    await setNote(note + ' ')
    assert.equal(await page.locator('article .md-tag').count(), 0)
  } finally {
    await page.evaluate(() => localStorage.removeItem('textarea:tags'))
  }
})

test('a pinned note leads the list and stays pinned while it is typed in', async () => {
  await setNote('# Pinned one')
  await saveNow()
  await page.evaluate(async () => {
    const library = await import('/lib/library.js')
    const far = Date.now() + 60_000
    await library.putDocument({id: 'pin-a', title: 'Apple', text: '# Apple', updated: far + 2})
    await library.putDocument({id: 'pin-b', title: 'banana', text: '# banana', updated: far + 1})
  })
  const row = () =>
    page.evaluate(async () => (await import('/lib/library.js')).getDocument(globalThis.textarea.documentId))

  const panel = await openDocuments()
  await cardTitles(panel, ['Apple', 'banana', 'Pinned one'])
  await panel.getByRole('button', {name: 'Pin Pinned one', exact: true}).click()
  await cardTitles(panel, ['Pinned one', 'Apple', 'banana'])
  assert.equal(
    await panel.getByRole('button', {name: 'Unpin Pinned one', exact: true}).getAttribute('aria-pressed'),
    'true',
  )

  await panel.locator('.library-chip', {hasText: /^Pinned$/}).click()
  await cardTitles(panel, ['Pinned one'])
  await page.keyboard.press('Escape')
  await panel.waitFor({state: 'detached'})

  // The autosave rewrites the row whole, and so does the write a closing tab
  // makes. Neither may take the pin with it.
  await setNote('# Pinned one\n\nmore')
  await saveNow()
  assert.equal((await row()).pinned, true, 'the autosave kept the pin')
  assert.equal((await row()).text, '# Pinned one\n\nmore')

  await page.evaluate(() => {
    globalThis.textarea.editor.replace('# Pinned one\n\nclosing')
    dispatchEvent(new Event('pagehide'))
  })
  await until(
    async () => {
      const {getDocument} = await import('/lib/library.js')
      return (await getDocument(globalThis.textarea.documentId))?.text === '# Pinned one\n\nclosing'
    },
    {what: 'the closing write to reach the library'},
  )
  assert.equal((await row()).pinned, true, 'the closing write kept the pin')
})

test('an archived note leaves the list until the archive is asked for', async () => {
  await page.evaluate(async () => {
    const library = await import('/lib/library.js')
    const far = Date.now() + 60_000
    await library.putDocument({id: 'arc-a', title: 'Apple', text: '# Apple #fruit', updated: far + 2})
    await library.putDocument({id: 'arc-b', title: 'banana', text: '# banana\n\n#fruit', updated: far + 1})
  })
  const stored = () => page.evaluate(async () => (await import('/lib/library.js')).getDocument('arc-b'))
  const before = await stored()
  const panel = await openDocuments()
  await cardTitles(panel, ['Apple', 'banana', 'Textarea'])

  await panel.getByRole('button', {name: 'Archive banana', exact: true}).click()
  await cardTitles(panel, ['Apple', 'Textarea'])
  assert.equal((await stored()).archived, true)
  // Marking a note is not editing it: it keeps the moment it was last written.
  assert.equal((await stored()).updated, before.updated)
  // An archived note is out of the tag counts as well as out of the list.
  assert.equal(await panel.locator('.library-chip', {hasText: '#fruit'}).count(), 0)

  await panel.locator('.library-chip', {hasText: /^Archived$/}).click()
  await cardTitles(panel, ['banana'])
  assert.equal(await panel.locator('.dialog-search').inputValue(), 'is:archived')

  // Out of the archive, and back in the list it left.
  await panel.getByRole('button', {name: 'Unarchive banana', exact: true}).click()
  await panel.locator('.document-row-empty').waitFor()
  await panel.locator('.dialog-search').fill('')
  await cardTitles(panel, ['Apple', 'banana', 'Textarea'])
  assert.equal(
    await page.evaluate(async () => 'archived' in (await (await import('/lib/library.js')).getDocument('arc-b'))),
    false,
    'a mark taken off leaves nothing behind on the row',
  )
  await page.keyboard.press('Escape')
})

test('the calendar lights the days notes were written, and a day filters the list', async () => {
  const day = await page.evaluate(async () => {
    const library = await import('/lib/library.js')
    const {dayOf} = await import('/lib/filter.js')
    const noon = new Date()
    noon.setHours(12, 0, 0, 0)
    const earlier = noon.getTime() - 3 * 86_400_000
    await library.putDocument({id: 'cal-a', title: 'Earlier', text: '# Earlier', created: earlier, updated: earlier})
    return {today: dayOf(Date.now()), earlier: dayOf(earlier)}
  })
  const panel = await openDocuments()
  await cardTitles(panel, ['Textarea', 'Earlier'])

  const calendar = panel.locator('.library-calendar')
  assert.match(await calendar.getAttribute('aria-label'), /2 active days/)
  assert.equal(await calendar.locator(`[data-day="${day.today}"]`).getAttribute('data-level'), '1')
  assert.equal(await calendar.locator(`[data-day="${day.earlier}"]`).getAttribute('data-level'), '1')

  // A lit square is the filter for its day, and the date field says so.
  await calendar.locator(`[data-day="${day.earlier}"]`).click()
  await cardTitles(panel, ['Earlier'])
  assert.equal(await panel.locator('.dialog-search').inputValue(), `on:${day.earlier}`)
  assert.equal(await panel.getByLabel('Show the notes of one day').inputValue(), day.earlier)
  assert.equal(await calendar.locator('[data-current="true"]').getAttribute('data-day'), day.earlier)

  // The date field is the same filter from the keyboard: another day
  // replaces the one asked for, and emptying it takes the filter away.
  await panel.getByLabel('Show the notes of one day').fill(day.today)
  await cardTitles(panel, ['Textarea'])
  assert.equal(await panel.locator('.dialog-search').inputValue(), `on:${day.today}`)
  await panel.getByLabel('Show the notes of one day').fill('')
  await cardTitles(panel, ['Textarea', 'Earlier'])
  assert.equal(await panel.locator('.dialog-search').inputValue(), '')
  await page.keyboard.press('Escape')
})

test('a jotted note goes into the library without leaving the panel', async () => {
  await setNote('# On screen')
  await saveNow()
  const panel = await openDocuments()
  await cardTitles(panel, ['On screen'])

  await panel.getByLabel('Quick note').fill('# Jotted\n\nthree words here #inbox')
  await panel.getByLabel('Quick note').press('ControlOrMeta+Enter')
  // By title: the note on screen is saved again by its own pause while the
  // panel is open, so which of the two was written last is not this test's.
  await panel.locator('.document-title', {hasText: 'Jotted'}).waitFor()
  assert.equal(await panel.getByLabel('Quick note').inputValue(), '')
  await panel.locator('.library-chip', {hasText: /^#inbox 1$/}).waitFor()

  // The button is the same save, and an empty box saves nothing.
  await panel.getByRole('button', {name: 'Save note'}).click()
  await panel.getByLabel('Quick note').fill('no heading on this one')
  await panel.getByRole('button', {name: 'Save note'}).click()
  await panel.locator('.document-title', {hasText: 'Textarea'}).waitFor()
  assert.equal(await panel.locator('.document-row:not(.document-row-empty)').count(), 3)

  const stored = await page.evaluate(async () => {
    const all = await (await import('/lib/library.js')).listDocuments()
    const jotted = all.find((entry) => entry.title === 'Jotted')
    return {count: all.length, text: jotted.text, words: jotted.words, own: jotted.id !== globalThis.textarea.documentId}
  })
  // Six words as the statistics panel counts them: the two marks are words to it.
  assert.deepEqual(stored, {count: 3, text: '# Jotted\n\nthree words here #inbox', words: 6, own: true})
  // The note on screen was never put away.
  assert.equal(await noteText(), '# On screen')
  await page.keyboard.press('Escape')
})

test('the timeline and a saved filter are remembered across a reload', async () => {
  await setNote('# Groceries\n\nmilk and eggs\n#home')
  await saveNow()
  try {
    let panel = await openDocuments()
    const view = panel.getByLabel('Show notes as')
    assert.equal(await view.inputValue(), 'board', 'the board it always was is what it opens as')
    await view.selectOption('timeline')
    await panel.locator('.document-list[data-view="timeline"]').waitFor()
    // The timeline card holds the note's own lines, not one flattened line.
    assert.equal(await panel.locator('.document-preview').first().textContent(), 'milk and eggs\n#home')
    assert.equal(await page.evaluate(() => localStorage.getItem('textarea:library-view')), 'timeline')

    // A search is offered for keeping only once there is one.
    assert.equal(await panel.locator('.library-chip-save').count(), 0)
    await panel.locator('.dialog-search').fill('#home eggs')
    await panel.locator('.library-chip-save').click()
    await panel.locator('.library-chip-saved', {hasText: '#home eggs'}).waitFor()
    assert.equal(await panel.locator('.library-chip-save').count(), 0, 'a kept search is not offered again')
    assert.equal(
      await page.evaluate(() => localStorage.getItem('textarea:filters')),
      '[{"name":"#home eggs","query":"#home eggs"}]',
    )

    await freshEditor()
    panel = await openDocuments()
    assert.equal(await panel.getByLabel('Show notes as').inputValue(), 'timeline')
    assert.equal(await panel.locator('.document-list').getAttribute('data-view'), 'timeline')

    // The chip puts its search back in the box, and takes it out again.
    const kept = panel.locator('.library-chip-saved', {hasText: '#home eggs'})
    await kept.click()
    assert.equal(await panel.locator('.dialog-search').inputValue(), '#home eggs')
    await cardTitles(panel, ['Groceries'])
    await panel.locator('.library-chip-saved', {hasText: '#home eggs'}).click()
    assert.equal(await panel.locator('.dialog-search').inputValue(), '')

    await panel.getByRole('button', {name: 'Remove the saved filter #home eggs'}).click()
    await panel.locator('.library-chip-saved').waitFor({state: 'detached'})
    assert.equal(await page.evaluate(() => localStorage.getItem('textarea:filters')), '[]')
    await page.keyboard.press('Escape')
  } finally {
    await page.evaluate(() => {
      localStorage.removeItem('textarea:library-view')
      localStorage.removeItem('textarea:filters')
    })
  }
})

test('a word-count goal shows in the statistics only once one is set', async () => {
  await setNote('one two three four five')
  await openMenu()
  await page.locator('#menu-stats').click()
  const stats = page.locator('#stats-panel')
  await stats.waitFor({state: 'visible'})
  assert.equal(await stats.locator('dd[data-key="goal"]').count(), 0, 'no goal, no row')

  try {
    // Set where the reader sets it: the line under Statistics in Settings.
    await openMenu()
    await page.locator('#menu-settings').click()
    const settings = page.locator('dialog.dialog-settings')
    await settings.waitFor({state: 'visible'})
    const goal = settings.getByLabel('Word-count goal (leave empty for none)')
    await goal.fill('20')
    await goal.dispatchEvent('change')
    await page.keyboard.press('Escape')
    await settings.waitFor({state: 'detached'})
    assert.equal(await page.evaluate(() => localStorage.getItem('textarea:word-goal')), '20')

    const row = stats.locator('dd[data-key="goal"]')
    await row.waitFor({state: 'visible'})
    assert.equal(await row.textContent(), '5 of 20 (25%)')
    // It follows the note like every other row.
    await setNote('one two three four five six seven eight nine ten')
    await saveNow()
    assert.equal(await row.textContent(), '10 of 20 (50%)')

    // A goal that is not a number is no goal, and the row leaves.
    await page.evaluate(() => localStorage.setItem('textarea:word-goal', 'plenty'))
    await saveNow()
    assert.equal(await row.isHidden(), true)
  } finally {
    await page.evaluate(() => localStorage.removeItem('textarea:word-goal'))
  }
})

test('Backup can write the whole library as one Markdown file instead', async () => {
  await page.evaluate(async () => {
    const library = await import('/lib/library.js')
    await library.putDocument({id: 'md-1', title: 'First', text: '# First\n\nalpha', updated: 2000})
    await library.putDocument({id: 'md-2', title: 'Second', text: '# Second\n\nbeta\n', updated: 1000})
    localStorage.setItem('textarea:backup-single', 'on')
  })
  try {
    await openMenu()
    let path = null
    let name = null
    const message = await notification(async () => {
      const [download] = await Promise.all([
        page.waitForEvent('download', {timeout: 60_000}),
        page.locator('#menu-backup').click(),
      ])
      name = download.suggestedFilename()
      path = join(DOWNLOADS, name)
      await download.saveAs(path)
    })
    assert.match(name, /^textarea-notes-\d{4}-\d{2}-\d{2}\.md$/)
    assert.match(message.text, /in one Markdown file/)
    const written = await fs.readFile(path, 'utf8')
    // The note on screen is the empty one the reset left, so it adds nothing.
    assert.equal(written, '# First\n\nalpha\n\n---\n\n# Second\n\nbeta\n')
  } finally {
    await page.evaluate(() => localStorage.removeItem('textarea:backup-single'))
  }
})

test('on paper there is the note and nothing else', async () => {
  await setNote('# Printed\n\nbody')
  await openMenu()
  await page.locator('#menu-stats').click()
  await page.locator('#stats-panel').waitFor({state: 'visible'})
  await page.emulateMedia({media: 'print'})
  try {
    const printed = await page.evaluate(() => {
      const shown = (selector) => getComputedStyle(document.querySelector(selector)).display !== 'none'
      const article = getComputedStyle(document.querySelector('article'))
      return {
        button: shown('#button'),
        menu: shown('#menu'),
        stats: shown('#stats-panel'),
        bubble: shown('#notification'),
        // textarea-plus: the shell stays on screen.
        sidebar: shown('#sidebar'),
        tabs: shown('#tabs'),
        bodyPadding: getComputedStyle(document.body).paddingLeft,
        padding: article.paddingLeft,
        color: article.color,
        page: getComputedStyle(document.documentElement).backgroundColor,
      }
    })
    assert.deepEqual(printed, {
      button: false,
      menu: false,
      stats: false,
      bubble: false,
      sidebar: false,
      tabs: false,
      bodyPadding: '0px',
      padding: '0px',
      color: 'rgb(0, 0, 0)',
      page: 'rgb(255, 255, 255)',
    })
  } finally {
    await page.emulateMedia({media: null})
  }
})

test('a model download can be cancelled, and cancelling is not an error', async () => {
  await page.evaluate(async () => {
    const {createWritingTools} = await import('/lib/writing-tools.js')
    const panel = createWritingTools({
      // A download that never finishes on its own: only the signal ends it,
      // the way the real loader's fetch ends.
      ensureModel: (onProgress, signal) =>
        new Promise((resolve, reject) => {
          if (globalThis.__modelBroken) return reject(new Error('part2 failed its checksum'))
          onProgress('Fetching model… 12 MB of 253 MB')
          signal.addEventListener('abort', () => reject(signal.reason))
        }),
      getText: () => 'Some words to work on.',
      getTools: () => ['improve'],
      getInstructions: () => '',
      onReplace: () => {},
    })
    panel.element.id = 'cancel-probe'
    document.body.append(panel.element)
    panel.open()
  })
  const probe = page.locator('#cancel-probe')
  try {
    const cancel = probe.getByRole('button', {name: 'Cancel download'})
    assert.equal(await cancel.isHidden(), true, 'nothing to cancel before a Run')

    await probe.locator('.writing-run').click()
    await cancel.waitFor({state: 'visible'})
    assert.match(await probe.locator('.writing-status').textContent(), /12 MB of 253 MB/)

    await cancel.click()
    await cancel.waitFor({state: 'hidden'})
    const status = probe.locator('.writing-status')
    assert.match(await status.textContent(), /Download cancelled/)
    assert.equal(await status.evaluate((element) => element.classList.contains('error')), false)
    // And the panel is ready for another go.
    assert.equal(await probe.locator('.writing-run').isDisabled(), false)

    // A load that fails for a real reason says why, in red, and keeps saying
    // it once the Run is over.
    await page.evaluate(() => {
      globalThis.__modelBroken = true
    })
    await probe.locator('.writing-run').click()
    await until(() => document.querySelector('#cancel-probe .writing-status').classList.contains('error'))
    assert.match(await status.textContent(), /failed its checksum/)
    assert.equal(await probe.locator('.writing-run').isDisabled(), false)
  } finally {
    await page.evaluate(() => {
      delete globalThis.__modelBroken
      document.querySelector('#cancel-probe')?.remove()
    })
  }
})

test('the speech panel transcribes a file through an injected engine and hands the text back', async () => {
  // The same seam the writing tools are tested through: a fake engine and a
  // fake decoder stand in for 249 MB of Whisper, so what is under test is
  // everything they are strangers to - the language that rides along, where
  // the progress and the transcript land, what Cancel and Insert do.
  await page.evaluate(async () => {
    const {createSpeechPanel} = await import('/lib/speech-panel.js')
    const state = {language: 'nl', decoded: null, asked: null, inserted: null, finish: null}
    state.release = new Promise((resolve) => {
      state.finish = resolve
    })
    const panel = createSpeechPanel({
      decode: async (blob) => {
        if (globalThis.__speechBroken) throw new Error('this is not audio the browser can decode')
        state.decoded = blob.size
        return new Float32Array(16_000)
      },
      // A download that waits to be released, or to be called off.
      ensureModel: (onProgress, signal, model) =>
        new Promise((resolve, reject) => {
          state.model = model
          onProgress('Fetching model… 67 MB of 249 MB')
          signal.addEventListener('abort', () => reject(signal.reason))
          void state.release.then(() =>
            resolve({
              transcribe: async (samples, {language}) => {
                state.asked = {samples: samples.length, language}
                return ' Hallo wereld. '
              },
            }),
          )
        }),
      getLanguage: () => state.language,
      setLanguage: (code) => {
        state.language = code
      },
      // Remembered as turbo, on a browser that cannot run it.
      getModel: () => 'turbo',
      setModel: (id) => {
        state.chosenModel = id
      },
      gpu: async () => false,
      onInsert: (text) => {
        state.inserted = text
      },
    })
    panel.element.id = 'speech-probe'
    // Pinned on screen: a probe under its own id has none of the panel's
    // CSS, and one left in the flow sits below the fold, where WebKit drops
    // a click that has to scroll to reach its button.
    panel.element.style.cssText = 'position: fixed; top: 16px; left: 16px; z-index: 5; background: #fff'
    globalThis.__speech = state
    globalThis.__speechPanel = panel
    document.body.append(panel.element)
    panel.open()
  })

  const probe = page.locator('#speech-probe')
  const status = probe.locator('.writing-status')
  const choose = probe.getByRole('button', {name: 'Choose file'})
  const cancel = probe.getByRole('button', {name: 'Cancel'})
  const memo = {name: 'memo.wav', mimeType: 'audio/wav', buffer: Buffer.from('sixteen bytes ok')}
  try {
    await probe.waitFor({state: 'visible'})
    const select = probe.getByLabel('Spoken language')
    assert.equal(await select.inputValue(), 'nl', 'the remembered language is the one on show')
    assert.equal(await select.locator('option').count(), 99)
    await select.selectOption('de')
    assert.equal(await page.evaluate(() => globalThis.__speech.language), 'de', 'a choice is handed back to be kept')
    assert.equal(await cancel.isHidden(), true, 'nothing to cancel before there is audio')

    // No WebGPU: turbo is listed, says why it cannot be had, and the
    // remembered choice falls back to the model that runs everywhere.
    const model = probe.getByLabel('Model')
    await until(() => document.querySelector('#speech-probe option[value="turbo"]').disabled)
    assert.equal(await model.inputValue(), 'small')
    assert.match(await model.locator('option[value="turbo"]').textContent(), /no WebGPU/)

    // A download in flight: it says how far it is, and it can be called off.
    await probe.locator('.speech-input').setInputFiles(memo)
    await cancel.waitFor({state: 'visible'})
    assert.match(await status.textContent(), /67 MB of 249 MB/)
    assert.equal(await choose.isDisabled(), true, 'one transcription at a time')
    await cancel.click()
    await cancel.waitFor({state: 'hidden'})
    assert.equal(await status.textContent(), 'Cancelled.')
    assert.equal(await status.evaluate((element) => element.classList.contains('error')), false)
    assert.equal(await choose.isDisabled(), false, 'and the panel is ready for another go')

    // The same file again - the input was cleared, so it is still a change.
    await page.evaluate(() => globalThis.__speech.finish())
    await probe.locator('.speech-input').setInputFiles(memo)
    const output = probe.locator('.writing-output')
    await output.waitFor({state: 'visible'})
    assert.equal(await output.textContent(), 'Hallo wereld.', 'trimmed: Whisper leads with a space')
    assert.equal(await status.textContent(), '')
    assert.deepEqual(await page.evaluate(() => [globalThis.__speech.decoded, globalThis.__speech.asked]), [
      16,
      {samples: 16_000, language: 'de'},
    ])
    assert.equal(await page.evaluate(() => globalThis.__speech.model), 'small', 'the engine is asked for the model on show')

    await probe.getByRole('button', {name: 'Insert at the cursor'}).click()
    assert.equal(await page.evaluate(() => globalThis.__speech.inserted), 'Hallo wereld.')
    assert.equal(await output.isHidden(), true, 'an inserted transcript is not offered twice')

    // A file that is not audio says so, in red, and leaves the panel usable.
    await page.evaluate(() => {
      globalThis.__speechBroken = true
    })
    await probe.locator('.speech-input').setInputFiles(memo)
    await until(() => document.querySelector('#speech-probe .writing-status').classList.contains('error'))
    assert.match(await status.textContent(), /not audio the browser can decode/)
    assert.equal(await choose.isDisabled(), false)

    await probe.getByRole('button', {name: 'Close speech to text'}).click()
    assert.equal(await page.evaluate(() => globalThis.__speechPanel.isOpen()), false)
  } finally {
    await page.evaluate(() => {
      delete globalThis.__speech
      delete globalThis.__speechPanel
      delete globalThis.__speechBroken
      document.querySelector('#speech-probe')?.remove()
    })
  }
})

test('the speech to text row opens its panel without an engine, and the language is remembered', async () => {
  // The app side of the seam. No test presses Record or picks a file here: a
  // real transcription is a real 249 MB download, and `npm run check:whisper`
  // is where that happens.
  const panel = page.locator('#speech-panel')
  try {
    await openMenu()
    await page.locator('#menu-speech').click()
    await panel.waitFor({state: 'visible'})

    const opened = await page.evaluate(() => performance.getEntriesByType('resource').map((entry) => entry.name))
    assert.ok(
      opened.some((name) => name.endsWith('/lib/speech-panel.js')),
      'the panel module arrives on the click that opens it',
    )
    assert.ok(
      !opened.some((name) => name.includes('whisper') || name.includes('/vendor/transformers/')),
      'no engine of any kind before there is audio to transcribe',
    )

    const select = panel.getByLabel('Spoken language')
    assert.equal(
      await select.inputValue(),
      await page.evaluate(() => navigator.language.toLowerCase().split('-')[0]),
      'a reader who never chose starts on the browser’s language',
    )
    await select.selectOption('nl')
    assert.equal(await page.evaluate(() => localStorage.getItem('textarea:speech-language')), 'nl')

    await panel.getByRole('button', {name: 'Close speech to text'}).click()
    await panel.waitFor({state: 'hidden'})
    await openMenu()
    await page.locator('#menu-speech').click()
    await panel.waitFor({state: 'visible'})
    assert.equal(await select.inputValue(), 'nl', 'and the choice is still there the next time')
  } finally {
    await page.evaluate(() => {
      localStorage.removeItem('textarea:speech-language')
      document.querySelector('#speech-panel .writing-close')?.click()
    })
  }
})

test('a tab that closed mid-keystroke reopens on what was typed, without a second copy', async () => {
  // The state a closing tab leaves behind when its save never finished: the
  // URL still says the old text, and the library row holds the new text under
  // the mark that means "this row's address was never written".
  const leaveUnfinished = async () => {
    await setNote('# Draft')
    await saveNow()
    return page.evaluate(async () => {
      const library = await import('/lib/library.js')
      const id = globalThis.textarea.documentId
      const row = await library.getDocument(id)
      // putDocumentNow, as the flush does it: the record goes in as given,
      // with the address it was typed under beside the mark.
      library.putDocumentNow({
        ...row,
        text: '# Draft, and the last words',
        hash: '~',
        from: location.hash.slice(1),
      })
      for (let tries = 0; tries < 50; tries++) {
        if ((await library.getDocument(id))?.hash === '~') break
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      return {id, url: location.href}
    })
  }
  const rows = () =>
    page.evaluate(async () =>
      (await (await import('/lib/library.js')).listDocuments()).map((entry) => ({
        id: entry.id,
        text: entry.text,
        hash: entry.hash,
      })),
    )

  // The tab comes back - a reload stands in for a restored session - and
  // opens on the newer text, in the same row, with the address caught up.
  const {id} = await leaveUnfinished()
  await page.reload()
  await page.waitForFunction(() => Boolean(globalThis.textarea))
  await until(() => globalThis.textarea.article.textContent === '# Draft, and the last words', {
    what: 'the unfinished text to reopen',
  })
  await until(async () => {
    const row = await (await import('/lib/library.js')).getDocument(globalThis.textarea.documentId)
    return row?.hash !== '~'
  })
  assert.equal(await page.evaluate(() => globalThis.textarea.documentId), id, 'the same row, not a new one')
  const hash = await page.evaluate(() => location.hash)
  assert.equal(await decodeHash(hash.slice(1)), '# Draft, and the last words')
  assert.deepEqual(
    (await rows()).map((row) => row.text),
    ['# Draft, and the last words'],
    'one note, not two',
  )

  // The same row found by a link opened fresh is not that link's note: the
  // link opens as itself, and the unfinished text stays in the library.
  const left = await leaveUnfinished()
  const second = await context.newPage()
  await second.goto(left.url)
  await second.waitForFunction(() => globalThis.textarea?.article.textContent === '# Draft')
  await second.close()
  const after = await rows()
  assert.ok(
    after.some((row) => row.id === left.id && row.text === '# Draft, and the last words'),
    'the unfinished text is still in the library',
  )

  // Nor is it another tab's to take. The row in hand is the origin's, shared
  // through localStorage: a second tab on a note of its own, reloaded while
  // the unfinished row is the one in hand, must come back as its own note.
  // The tab that left the row is dead in the case being tested, but this
  // page stands in for it and is very much alive - and an engine that blurs
  // it when another tab opens would have it save over the row it is
  // pretending to have abandoned. So it lets go of the row first.
  await page.evaluate(() => {
    location.hash = '#new'
  })
  await until(() => globalThis.textarea.documentId !== undefined && location.hash === '#new')
  await page.waitForFunction((id) => globalThis.textarea.documentId !== id, left.id)

  const other = await context.newPage()
  await other.goto(server.origin + '/')
  await other.waitForFunction(() => Boolean(globalThis.textarea))
  await other.evaluate(async () => {
    globalThis.textarea.editor.replace('# Another tab entirely')
    await globalThis.textarea.save()
  })
  // The first tab types and dies: its row is marked, and it is the one in hand.
  await page.evaluate((id) => localStorage.setItem('textarea:active-document', id), left.id)
  await other.reload()
  await other.waitForFunction(() => Boolean(globalThis.textarea))
  await other.waitForTimeout(300)
  assert.equal(await other.evaluate(() => globalThis.textarea.article.textContent), '# Another tab entirely')
  const otherHash = await other.evaluate(() => location.hash)
  assert.equal(await decodeHash(otherHash.slice(1)), '# Another tab entirely')
  await other.close()
  assert.ok(
    (await rows()).some((row) => row.id === left.id && row.text === '# Draft, and the last words' && row.hash === '~'),
    'the unfinished row was left exactly as it was',
  )
})

chromiumOnly('a reader who never asked for folder sync never loads it, and gets no database for it', async () => {
  // A profile of its own: every other test here shares one, and one of them
  // has connected a folder in it.
  const fresh = await context.browser().newContext()
  try {
    const visitor = await fresh.newPage()
    await visitor.goto(server.origin + '/')
    await visitor.waitForFunction(() => Boolean(globalThis.textarea))
    await visitor.evaluate(async () => {
      globalThis.textarea.editor.replace('# A note, typed and saved')
      await globalThis.textarea.save()
    })
    const seen = await visitor.evaluate(async () => ({
      databases: (await indexedDB.databases()).map((database) => database.name),
      engine: performance.getEntriesByType('resource').some((entry) => entry.name.endsWith('folder-sync.js')),
      status: globalThis.textarea.folderSync.status,
    }))
    assert.ok(seen.databases.includes('textarea'), 'the library is there')
    assert.ok(!seen.databases.includes('textarea-sync'), 'asking whether a folder is remembered created nothing')
    assert.equal(seen.engine, false, 'the engine was not fetched')
    // The status still has the shape the menu and the seam read.
    assert.deepEqual(seen.status, {
      supported: true,
      active: false,
      name: '',
      syncing: false,
      pending: false,
      lastPass: null,
      problem: null,
    })
  } finally {
    await fresh.close()
  }
})

test('a tab hidden mid-pause saves at once instead of waiting the pause out', async () => {
  await setNote('# Before')
  await saveNow()
  const before = await page.evaluate(() => location.hash)

  // One keystroke's worth of change, then the tab goes away inside the 500ms
  // the autosave would have waited. replace() raises the same input event a
  // key does, so the pause is running when the page is told it is hidden.
  const moved = await page.evaluate(async (was) => {
    globalThis.textarea.editor.replace('# After the pause would have lost this')
    Object.defineProperty(document, 'visibilityState', {value: 'hidden', configurable: true})
    document.dispatchEvent(new Event('visibilitychange'))
    delete document.visibilityState
    // Well inside the pause: only the flush can have written this.
    for (let waited = 0; waited < 300; waited += 20) {
      if (location.hash !== was) return true
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    return false
  }, before)
  assert.equal(moved, true, 'the hash was rewritten before the 500ms pause ran out')
  const hash = await page.evaluate(() => location.hash)
  assert.equal(await decodeHash(hash.slice(1)), '# After the pause would have lost this')

  // The library has it too, which is what survives a tab that really closes.
  await until(
    async () => {
      const {getDocument} = await import('/lib/library.js')
      const row = await getDocument(globalThis.textarea.documentId)
      return row?.text === '# After the pause would have lost this'
    },
    {what: 'the flushed text to reach the library'},
  )

  // pagehide is the same flush, for the tab that is closed rather than hidden.
  const closed = await page.evaluate(async () => {
    const was = location.hash
    globalThis.textarea.editor.replace('# Closed')
    dispatchEvent(new Event('pagehide'))
    for (let waited = 0; waited < 300; waited += 20) {
      if (location.hash !== was) return true
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    return false
  })
  assert.equal(closed, true, 'pagehide flushed the save as well')

  // And the real thing: a second tab closed in the same breath as its last
  // keystroke. No code of its own runs after the close, so only a write the
  // closing page had already issued can put these words in the library.
  const second = await context.newPage()
  await second.goto(server.origin + '/')
  await second.waitForFunction(() => Boolean(globalThis.textarea))
  await second.evaluate(async () => {
    globalThis.textarea.editor.replace('# First draft')
    await globalThis.textarea.save()
  })
  // Typed with the keyboard into a focused editor, because that is the case
  // that matters: closing a focused tab blurs the editor first, and the blur
  // starts an ordinary save that the closing page never finishes.
  await second.locator('article').click()
  await second.keyboard.press('Control+End')
  await second.keyboard.type(', and the words typed as the tab closed')
  await second.close({runBeforeUnload: true})
  await until(
    async () => {
      const entries = await (await import('/lib/library.js')).listDocuments()
      return entries.some((entry) => entry.text === '# First draft, and the words typed as the tab closed')
    },
    {what: 'the closed tab\u2019s last words to be in the library'},
  )
})

test('a library that stops keeping notes says so, once', async () => {
  await setNote('# Kept in the link')
  await saveNow()

  // The quota is the browser's to enforce, so the failure is injected where
  // it would surface: the write itself.
  await page.evaluate(() => {
    globalThis.__put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function () {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
    }
  })
  try {
    await notification(async () => {
      await setNote('# Kept in the link, not in the library')
      await saveNow()
    })
    const bubble = page.locator('#notification')
    assert.match(await bubble.textContent(), /could not be saved to your documents/)
    assert.equal(await bubble.getAttribute('aria-live'), 'assertive')
    // The note itself is untouched: the link still carries it.
    const hash = await page.evaluate(() => location.hash)
    assert.equal(await decodeHash(hash.slice(1)), '# Kept in the link, not in the library')

    // A second failed save does not ring the bubble again.
    const sequence = await bubble.getAttribute('data-sequence')
    await setNote('# Still failing')
    await saveNow()
    assert.equal(await bubble.getAttribute('data-sequence'), sequence)
  } finally {
    await page.evaluate(() => {
      IDBObjectStore.prototype.put = globalThis.__put
    })
  }
})

peerToPeer('Send to a device carries a note to another tab over WebRTC, after it accepts', async () => {
  // Two real tabs, two real peer connections, host candidates: everything a
  // phone on the same Wi-Fi does except the camera, which the paste box and
  // the copy buttons stand in for. The codes travel through a stubbed
  // clipboard, which every engine can read back.
  const tab = async (path) => {
    const opened = await context.newPage()
    await opened.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {writeText: async (text) => void (globalThis.__copied = text)},
      })
    })
    await opened.goto(server.origin + path)
    await opened.waitForFunction(() => Boolean(globalThis.textarea))
    return opened
  }
  const sender = await tab('/')
  let receiver = null
  try {
    await sender.evaluate(() => globalThis.textarea.editor.replace('# Nearby\n\nSent without a server.'))
    await sender.locator('#button').click()
    await sender.locator('#menu-send').click()
    const sendPanel = sender.locator('dialog.dialog-nearby')
    await sendPanel.locator('.qr-figure svg').waitFor({state: 'visible'})
    await sendPanel.getByRole('button', {name: 'Copy link'}).click()
    const link = await sender.evaluate(() => globalThis.__copied)
    // Made on localhost, so it points a phone at the deployed copy.
    assert.match(link, /^https:\/\/gitguy268-textarea\.vercel\.app\/#rtc=1o[A-Za-z0-9_-]+$/)

    receiver = await tab('/' + link.slice(link.indexOf('#')))
    const receivePanel = receiver.locator('dialog.dialog-nearby')
    await receivePanel.getByRole('button', {name: 'Connect'}).click()
    assert.doesNotMatch(await receiver.evaluate(() => location.hash), /rtc=/, 'the pairing code leaves the address bar')
    await receivePanel.getByRole('button', {name: 'Copy code'}).click()
    const answer = await receiver.evaluate(() => globalThis.__copied)
    assert.match(answer, /^1a[A-Za-z0-9_-]+$/)

    await sendPanel.getByLabel('Or paste the code').fill(answer)
    await sendPanel.getByRole('button', {name: 'Connect'}).click()
    await receivePanel.getByRole('button', {name: 'Accept'}).waitFor({state: 'visible', timeout: 20_000})
    assert.match(await receivePanel.getByRole('status').textContent(), /Accept “Nearby” \(\d+ bytes\)\?/)
    await receivePanel.getByRole('button', {name: 'Accept'}).click()

    await sendPanel.waitFor({state: 'detached'})
    await receiver.waitForFunction(
      () => document.querySelector('article')?.textContent === '# Nearby\n\nSent without a server.',
      undefined,
      {polling: 100, timeout: 10_000},
    )
    await sender.waitForFunction(() => document.querySelector('#notification').textContent === 'Sent to the other device')
  } finally {
    await sender.close()
    await receiver?.close()
  }
})

test('a pairing link opens Receive on a library row of its own, not the last one used', async () => {
  // The origin remembers the last note it wrote. A tab opened on a #rtc= link
  // is empty, and if it kept that id what arrives would be saved over it.
  const first = await context.newPage()
  await first.goto(server.origin + '/')
  await first.waitForFunction(() => Boolean(globalThis.textarea))
  await first.evaluate(async () => {
    globalThis.textarea.editor.replace('# Kept\n\nstill here')
    await globalThis.textarea.save()
  })
  await first.close()

  const second = await context.newPage()
  try {
    await second.goto(server.origin + '/#rtc=x')
    const panel = second.locator('dialog.dialog-nearby')
    await panel.getByRole('button', {name: 'Close'}).click()
    await panel.waitFor({state: 'detached'})
    const texts = await second.evaluate(async () => {
      await globalThis.textarea.openFiles([new File(['# Arrived\n\nfrom far'], 'r.md')])
      await globalThis.textarea.save()
      const {listDocuments} = await import('/lib/library.js')
      return (await listDocuments()).map((row) => row.text)
    })
    assert.ok(texts.includes('# Kept\n\nstill here'), 'the earlier note keeps its row')
    assert.ok(texts.includes('# Arrived\n\nfrom far'), 'what arrived has a row of its own')
  } finally {
    await second.close()
  }
})

test('Receive from a device turns away a code that is not one', async () => {
  await reset()
  await openMenu()
  await page.locator('#menu-receive').click()
  const panel = page.locator('dialog.dialog-nearby')
  await panel.getByLabel('Or paste the code').fill('https://example.com/#not-a-code')
  await panel.getByRole('button', {name: 'Connect'}).click()
  await panel.getByRole('alert').filter({hasText: 'not a pairing code'}).waitFor({state: 'visible'})
  await panel.getByRole('button', {name: 'Close'}).click()
  await panel.waitFor({state: 'detached'})
})

test('the shell: views list the notes they ask for, tabs follow the notes opened, Ctrl/Cmd+K reaches both', async () => {
  await reset()
  await page.evaluate(() => {
    for (const key of ['textarea:tabs', 'textarea:sidebar-view', 'textarea:sidebar']) localStorage.removeItem(key)
  })
  // Three notes the way the CLI and the web app write them: a capture with no
  // heading, a project, and one with an open task.
  await page.evaluate(async () => {
    const library = await import('/lib/library.js')
    for (const text of ['buy milk #home', '# Roadmap\n#project\n\nthe plan', '# Lisbon\n\n- [ ] book the tram']) {
      await library.putDocument({text, title: text.startsWith('# ') ? text.split('\n')[0].slice(2) : 'Textarea'})
    }
    await globalThis.textarea.save()
  })
  const sidebar = page.locator('#sidebar')
  const view = (name) => sidebar.locator(`.sidebar-view[data-view="${name}"]`)
  const listed = () => sidebar.locator('.sidebar-note').allTextContents()
  await until(() => document.querySelector('[data-view="inbox"] .sidebar-count')?.textContent === '1', {
    what: 'the Inbox count',
  })

  await view('inbox').click()
  assert.deepEqual(await listed(), ['buy milk #home'], 'Inbox is the capture with no heading')
  await view('projects').click()
  assert.deepEqual(await listed(), ['Roadmap'])
  assert.equal(await view('projects').getAttribute('aria-current'), 'page')

  // Opening from the sidebar asks nothing: the note on screen is already kept.
  await sidebar.getByRole('button', {name: 'Roadmap'}).click()
  await until(() => globalThis.textarea.article.textContent.startsWith('# Roadmap'), {what: 'Roadmap to open'})
  assert.equal(await page.locator('dialog.dialog').count(), 0, 'no question on the way')
  const current = page.locator('#tabs .tab-open[aria-current="page"]')
  await until(() => document.querySelector('#tabs .tab-open[aria-current="page"]')?.textContent === 'Roadmap', {
    what: 'the Roadmap tab',
  })

  // Today makes the day's note once, as `text today` would, and finds it after.
  const day = await page.evaluate(() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  })
  await view('today').click()
  await until(() => globalThis.textarea.article.textContent.startsWith('# 2'), {what: "the day's note"})
  assert.equal((await noteText()).split('\n')[0], `# ${day}`)
  await sidebar.getByRole('button', {name: 'Roadmap'}).click()
  await until(() => globalThis.textarea.article.textContent.startsWith('# Roadmap'), {what: 'Roadmap again'})
  await view('today').click()
  await until(() => globalThis.textarea.article.textContent.startsWith('# 2'), {what: "the day's note again"})
  const days = await page.evaluate(async (title) => {
    const library = await import('/lib/library.js')
    return (await library.listDocuments()).filter((entry) => entry.text.startsWith(`# ${title}`)).length
  }, day)
  assert.equal(days, 1, 'one note for the day, however often Today is clicked')

  // Closing the tab on screen hands the screen to its neighbour.
  // The tabs: the blank note reset() left, Roadmap, and the day after it.
  await until(() => document.querySelector('#tabs .tab-open[aria-current="page"]')?.textContent.startsWith('2'), {
    what: "the day's tab to be current",
  })
  assert.deepEqual((await page.locator('#tabs .tab-open').allTextContents()).slice(-2), ['Roadmap', day])
  await page.locator('#tabs .tab-close').last().click()
  await until(() => globalThis.textarea.article.textContent.startsWith('# Roadmap'), {what: 'the neighbour tab'})
  assert.equal(await current.textContent(), 'Roadmap')

  // Ctrl/Cmd+K: the views are in the same list as the notes.
  await page.keyboard.press('ControlOrMeta+k')
  const switcher = page.locator('dialog.dialog-switcher')
  await switcher.waitFor({state: 'visible'})
  await switcher.locator('input').fill('Go to Wiki')
  await page.keyboard.press('Enter')
  await until(() => document.querySelector('[data-view="wiki"]')?.getAttribute('aria-current') === 'page', {
    what: 'the Wiki view',
  })

  // Ctrl/Cmd+\ takes the shell away and brings it back, remembered.
  await page.keyboard.press('ControlOrMeta+Backslash')
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains('shell')), false)
  assert.equal(await page.evaluate(() => localStorage.getItem('textarea:sidebar')), 'off')
  await page.keyboard.press('ControlOrMeta+Backslash')
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains('shell')), true)

  await page.evaluate(() => {
    for (const key of ['textarea:tabs', 'textarea:sidebar-view', 'textarea:sidebar']) localStorage.removeItem(key)
  })
})

test('databases: a saved query as a table, board, calendar and list, every edit a line of a note', async () => {
  await reset()
  const today = await page.evaluate(() => {
    const now = new Date()
    const two = (n) => String(n).padStart(2, '0')
    return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`
  })
  await page.evaluate(async (today) => {
    const library = await import('/lib/library.js')
    for (const [id, title, rest] of [
      ['row-a', 'Alpha', `#project\nkeep  this  spacing\n\nstatus:: Todo\nowner:: Ann\ndue:: ${today}`],
      ['row-b', 'Beta', '#project\n\nstatus:: Doing'],
      ['row-c', 'Gamma', 'not a project'],
    ]) {
      await library.putDocument({id, title, text: `# ${title}\n\n${rest}\n`, style: 'color: red', words: 3})
    }
    await globalThis.textarea.save()
  }, today)
  const row = (id) => page.evaluate((id) => import('/lib/library.js').then((library) => library.getDocument(id)), id)
  const textOf = async (id) => (await row(id)).text
  const panel = page.locator('#database')
  const untilRow = async (id, check, what) => {
    const deadline = Date.now() + 30_000
    while (!check(await textOf(id))) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
      await page.waitForTimeout(40)
    }
  }

  // Made through Ctrl/Cmd+K, it is a note whose text says what it is.
  await until(() => document.querySelector('#sidebar .sidebar-more'), {what: 'the sidebar'})
  await page.locator('#sidebar').getByRole('button', {name: 'New database…'}).click()
  const dialog = page.locator('dialog', {hasText: 'New database'})
  await dialog.locator('input[name="name"]').fill('Active')
  await dialog.locator('input[name="query"]').fill('#project')
  await dialog.getByRole('button', {name: 'Create'}).click()
  await panel.getByRole('heading', {name: 'Active'}).waitFor()
  assert.equal(
    await page.evaluate(() => globalThis.textarea.article.textContent),
    '# Active\n\nview:: table\nquery:: `#project`\n',
    'the database is a note',
  )
  assert.equal(await page.locator('article').first().isVisible(), false, 'it takes the article\u2019s place')
  await until(() => document.querySelectorAll('#database tbody tr').length === 2, {what: 'two rows'})

  // A cell edit is one line of that note, and nothing else about it moves.
  const before = await row('row-a')
  const status = panel.locator('input[aria-label="status of Alpha"]')
  await status.fill('Doing')
  await page.keyboard.press('Tab')
  await untilRow('row-a', (text) => text.includes('status:: Doing'), 'the edit written')
  const after = await row('row-a')
  assert.equal(after.text, before.text.replace('status:: Todo', 'status:: Doing'), 'no other byte of the note moved')
  assert.equal(after.style, 'color: red', 'the note keeps its style')
  assert.equal(after.title, 'Alpha', 'and its title')
  assert.equal(after.words, 12, 'and its count follows the text')
  assert.ok(after.updated > before.updated, 'and counts as edited, so sync writes it')
  assert.equal(after.hash, '', 'and an old address cannot claim the old text back')
  // Where Tab lands differs by engine: WebKit skips buttons.
  await page.waitForTimeout(300)
  assert.ok(
    await page.evaluate(() => document.querySelector('#database').contains(document.activeElement)),
    'the redraw leaves the focus where Tab took it',
  )

  // Two cells of one row in quick succession: neither edit is lost.
  await panel.locator('input[aria-label="owner of Alpha"]').fill('Bea')
  await panel.locator('input[aria-label="owner of Beta"]').fill('Cy')
  await panel.locator('input[aria-label="status of Beta"]').fill('Late')
  await panel.getByRole('button', {name: 'Add column'}).focus()
  await untilRow('row-b', (text) => text.includes('owner:: Cy') && text.includes('status:: Late'), 'both edits of one row')
  assert.match(await textOf('row-a'), /owner:: Bea/)

  // Emptying a cell takes the line out.
  await panel.locator('input[aria-label="owner of Beta"]').focus()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('Backspace')
  await panel.getByRole('button', {name: 'Add column'}).focus()
  await untilRow('row-b', (text) => !text.includes('owner::'), 'the line removed')

  // Sort is a line of the database.
  await panel.getByRole('button', {name: 'status', exact: true}).click()
  await until(() => globalThis.textarea.article.textContent.includes('sort:: status'), {what: 'the sort saved'})

  // A column named before any note has it.
  await panel.getByRole('button', {name: 'Add column'}).click()
  const column = page.locator('dialog', {hasText: 'New column'})
  await column.locator('input[name="key"]').fill('priority')
  await column.getByRole('button', {name: 'Add'}).click()
  await panel.locator('input[aria-label="priority of Beta"]').fill('high')
  await page.keyboard.press('Tab')
  await untilRow('row-b', (text) => text.includes('priority:: high'), 'a value in the new column')

  // A new row carries what the query asks for.
  await panel.getByRole('button', {name: 'New row'}).click()
  const added = page.locator('dialog', {hasText: 'New row'})
  await added.locator('input[name="title"]').fill('Delta')
  await added.getByRole('button', {name: 'Add'}).click()
  await panel.getByRole('button', {name: 'Delta'}).waitFor()

  // The query changes what is found, and is saved.
  await panel.getByRole('textbox', {name: 'Query'}).fill('#project status:doing')
  await page.keyboard.press('Enter')
  await until(() => document.querySelectorAll('#database tbody tr').length === 1, {what: 'one row left'})
  assert.ok((await page.evaluate(() => globalThis.textarea.article.textContent)).includes('query:: `#project status:doing`'))
  await panel.getByRole('textbox', {name: 'Query'}).fill('#project')
  await page.keyboard.press('Enter')
  await until(() => document.querySelectorAll('#database tbody tr').length === 3, {what: 'three rows back'})

  // The board: the select moves a card from the keyboard.
  await panel.getByRole('combobox', {name: 'Layout'}).selectOption('board')
  const lane = (name) => panel.getByRole('region', {name, exact: true})
  await lane('Doing').waitFor()
  await panel.getByRole('button', {name: 'Add column'}).click()
  const lanes = page.locator('dialog', {hasText: 'New column'})
  await lanes.locator('input[name="value"]').fill('Done')
  await lanes.getByRole('button', {name: 'Add'}).click()
  await lane('Done').waitFor()
  const move = panel.getByRole('combobox', {name: 'Move Alpha'})
  await move.focus()
  await move.selectOption('Done')
  await lane('Done').getByRole('button', {name: 'Alpha'}).waitFor()
  assert.match(await textOf('row-a'), /status:: Done/)

  // And so does a drag.
  await lane('Late').locator('.database-card', {hasText: 'Beta'}).dragTo(lane('Done'))
  await lane('Done').getByRole('button', {name: 'Beta'}).waitFor()
  assert.match(await textOf('row-b'), /status:: Done/)

  // A file dragged onto a column is still the page's: the overlay goes away again.
  await lane('Done').evaluate((element) => {
    const dataTransfer = new DataTransfer()
    dataTransfer.items.add(new File(['x'], 'x.txt', {type: 'text/plain'}))
    const fire = (type) => element.dispatchEvent(new DragEvent(type, {bubbles: true, cancelable: true, dataTransfer}))
    fire('dragenter')
    fire('dragover')
    fire('dragleave')
  })
  assert.equal(await page.locator('#drop-overlay.visible').count(), 0)
  await lane('Done').evaluate((element) => {
    const dataTransfer = new DataTransfer()
    dataTransfer.items.add(new File(['x'], 'x.png', {type: 'image/png'}))
    const fire = (type) => element.dispatchEvent(new DragEvent(type, {bubbles: true, cancelable: true, dataTransfer}))
    fire('dragenter')
    fire('drop')
  })
  assert.equal(await page.locator('#drop-overlay.visible').count(), 0, 'a file dropped on a column clears the overlay')

  // A new card in a column has that column's value.
  await lane('Done').getByRole('button', {name: 'New row'}).click()
  const card = page.locator('dialog', {hasText: 'New row'})
  await card.locator('input[name="title"]').fill('Epsilon')
  await card.getByRole('button', {name: 'Add'}).click()
  await lane('Done').getByRole('button', {name: 'Epsilon'}).waitFor()

  // The calendar: a row sits on its day, and Alt+arrow moves it.
  await panel.getByRole('combobox', {name: 'Layout'}).selectOption('calendar')
  const chip = panel.locator(`[data-day="${today}"] .database-chip`, {hasText: 'Alpha'})
  await chip.waitFor()
  await chip.focus()
  await page.keyboard.press('Alt+ArrowDown')
  const weekOn = await page.evaluate((today) => {
    const [y, m, d] = today.split('-').map(Number)
    const next = new Date(y, m - 1, d + 7)
    const two = (n) => String(n).padStart(2, '0')
    return `${next.getFullYear()}-${two(next.getMonth() + 1)}-${two(next.getDate())}`
  }, today)
  await untilRow('row-a', (text) => text.includes(`due:: ${weekOn}`), 'the date moved a week')
  // A note with no date gets one through the list under the month.
  const undated = panel.locator('input[aria-label="due of Epsilon"]')
  await undated.fill(today)
  await page.keyboard.press('Enter')
  await panel.locator(`[data-day="${today}"] .database-chip`, {hasText: 'Epsilon'}).waitFor()

  // The list.
  await panel.getByRole('combobox', {name: 'Layout'}).selectOption('list')
  await until(() => document.querySelectorAll('#database .database-list > li').length === 4, {what: 'four rows listed'})
  assert.equal(await panel.getByRole('button', {name: 'Gamma'}).count(), 0, 'a note the query does not find')

  // A cell left by clicking its own note: the edit reaches the editor and stays,
  // from the sidebar's older copy of the row and from the table's title.
  await panel.getByRole('combobox', {name: 'Layout'}).selectOption('table')
  const sidebarRow = page.locator('#sidebar [data-view="notes"]')
  await sidebarRow.click()
  await panel.locator('input[aria-label="owner of Beta"]').fill('Raced')
  await page.locator('#sidebar .sidebar-note', {hasText: 'Beta'}).click()
  await until(() => globalThis.textarea.article.textContent.startsWith('# Beta'), {what: 'Beta opened'})
  assert.match(await page.evaluate(() => globalThis.textarea.article.textContent), /owner:: Raced/, 'the editor has the edit')
  await page.evaluate(() => globalThis.textarea.save())
  assert.match(await textOf('row-b'), /owner:: Raced/, 'and the save that followed kept it')
  await page.locator('#tabs').getByRole('button', {name: 'Active', exact: true}).click()
  await panel.getByRole('heading', {name: 'Active'}).waitFor()
  await until(() => document.querySelector('input[aria-label="owner of Beta"]')?.value === 'Raced', {what: 'the table caught up'})
  await panel.locator('input[aria-label="owner of Beta"]').fill('Raced again')
  await panel.getByRole('button', {name: 'Beta'}).click()
  await until(() => globalThis.textarea.article.textContent.startsWith('# Beta'), {what: 'Beta opened by its title'})
  assert.match(await page.evaluate(() => globalThis.textarea.article.textContent), /owner:: Raced again/)
  await page.evaluate(() => globalThis.textarea.save())
  assert.match(await textOf('row-b'), /owner:: Raced again/)
  await page.locator('#tabs').getByRole('button', {name: 'Active', exact: true}).click()
  await panel.getByRole('heading', {name: 'Active'}).waitFor()
  await panel.getByRole('combobox', {name: 'Layout'}).selectOption('list')
  await until(() => document.querySelectorAll('#database .database-list > li').length === 4, {what: 'the list again'})

  // Clicking a title opens the note as text, and a tab returns to the database.
  await panel.getByRole('button', {name: 'Alpha'}).click()
  await until(() => globalThis.textarea.article.textContent.startsWith('# Alpha'), {what: 'the note opened'})
  assert.equal(await panel.isVisible(), false)
  assert.match(await page.evaluate(() => globalThis.textarea.article.textContent), /status:: Done/, 'the editor has the written text')
  await page.locator('#tabs').getByRole('button', {name: 'Active', exact: true}).click()
  await panel.getByRole('heading', {name: 'Active'}).waitFor()

  // As text and back; typing the lines into a note does not snatch it away.
  await panel.getByRole('button', {name: 'Edit as text'}).click()
  assert.equal(await page.locator('article').first().isVisible(), true)
  await page.getByRole('button', {name: 'Show as database'}).click()
  await panel.getByRole('heading', {name: 'Active'}).waitFor()

  // A reload comes back to the database.
  await page.evaluate(() => globalThis.textarea.save())
  await page.reload()
  await panel.getByRole('heading', {name: 'Active'}).waitFor()
  assert.equal(await page.locator('article').first().isVisible(), false)

  await page.locator('#tabs').getByRole('button', {name: 'New note'}).click()
  await until(() => globalThis.textarea.article.textContent === '', {what: 'a new note'})
  await page.locator('article').first().click()
  await page.keyboard.type('# Typed\n\nview:: table\nquery:: x\n')
  await page.waitForTimeout(800)
  assert.equal(await page.locator('article').first().isVisible(), true, 'still the note being typed')

  // The database stays out of its own rows, and the sidebar lists it.
  await until(() => [...document.querySelectorAll('#sidebar .sidebar-note')].some((row) => row.textContent === 'Active'), {what: 'listed'})
})

test('tasks: quick add, the lists, keys, repeats, a board and a timeline, every change a line of a note', async () => {
  await reset()
  const days = await page.evaluate(() => {
    const two = (n) => String(n).padStart(2, '0')
    const at = (offset) => {
      const now = new Date()
      const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset)
      return `${day.getFullYear()}-${two(day.getMonth() + 1)}-${two(day.getDate())}`
    }
    return {today: at(0), tomorrow: at(1), week: at(7), ago: at(-3)}
  })
  await page.evaluate(async (days) => {
    const library = await import('/lib/library.js')
    await library.putDocument({
      id: 'plan',
      title: 'Plan',
      style: 'color: red',
      text: `# Plan\n\n#project\narea:: Home\n\n- [ ] overdue 📅 ${days.ago}\nkeep  this  line\n- [ ] later 📅 ${days.week}\n- [ ] sometime\n- [ ] weekly 🔁 every week 📅 ${days.today}\n\`\`\`\n- [ ] in code\n\`\`\`\n`,
    })
    await globalThis.textarea.save()
  }, days)
  const panel = page.locator('#tasks')
  const planText = () =>
    page.evaluate(() => import('/lib/library.js').then((library) => library.getDocument('plan').then((row) => row.text)))
  const untilPlan = async (check, what) => {
    const deadline = Date.now() + 30_000
    while (!check(await planText())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${await planText()}`)
      await page.waitForTimeout(40)
    }
  }
  const pick = (name) => panel.locator(`[data-list="${name}"]`).click()
  const row = (name) => panel.locator('.task-row', {hasText: name})

  // The sidebar's Tasks opens the screen on Today, and only real tasks are in it.
  await until(() => document.querySelector('#sidebar [data-view="tasks"]'), {what: 'the sidebar'})
  await page.locator('#sidebar [data-view="tasks"]').click()
  await row('overdue').waitFor()
  assert.equal(await page.locator('article').first().isVisible(), false)
  assert.equal(await row('in code').count(), 0, 'a fence is code')
  assert.equal(await row('later').count(), 0, 'not today')
  assert.match(await panel.locator('.tasks-heading').first().textContent(), /Home · Plan/, 'by area and note')
  await pick('upcoming')
  await row('later').waitFor()
  await pick('anytime')
  await row('sometime').waitFor()

  // Quick add says what it read, and writes it to a Tasks note.
  const box = panel.getByRole('textbox', {name: 'Quick add a task'})
  await box.fill('call mum tomorrow 3pm #home p1 every week')
  assert.match(await panel.locator('.tasks-add-preview').textContent(), /call mum #home: due .*reminder at 15:00, highest, every week/)
  await page.keyboard.press('Enter')
  await pick('upcoming')
  await row('call mum').waitFor()
  const quick = await page.evaluate(async () => {
    const library = await import('/lib/library.js')
    const all = await library.listDocuments()
    return all.find((entry) => entry.title === 'Tasks')?.text
  })
  assert.equal(quick, `# Tasks\n\n- [ ] call mum #home ⏰ ${days.tomorrow} 15:00 🔺 🔁 every week 📅 ${days.tomorrow}\n`)
  // Two at once make one Tasks note, with both in it.
  await box.fill('second task')
  await page.keyboard.press('Enter')
  await box.fill('third task')
  await page.keyboard.press('Enter')
  await pick('anytime')
  await row('second task').waitFor()
  assert.equal(await page.evaluate(() => import('/lib/library.js').then(async (library) => (await library.listDocuments()).filter((entry) => entry.title === 'Tasks').length)), 1, 'one Tasks note')

  // Keys on a row: each one a change to that line and no other byte.
  await pick('today')
  await row('overdue').focus()
  await page.keyboard.press('p')
  await untilPlan((text) => text.includes('overdue 📅') && /overdue .*🔺/.test(text), 'the priority')
  await row('overdue').locator('.task-meta', {hasText: 'Highest'}).waitFor()
  await page.keyboard.press('s')
  await untilPlan((text) => text.includes('- [/] overdue'), 'in progress')
  await row('overdue').locator('.task-meta', {hasText: 'In progress'}).waitFor()
  assert.equal(await page.evaluate(() => document.activeElement.classList.contains('task-row')), true, 'the focus stays on the row')
  assert.match(await planText(), /keep {2}this {2}line/)

  // A quick pair of keys: neither is lost.
  await page.keyboard.press('p')
  await page.keyboard.press('p')
  await page.keyboard.press('z')
  await untilPlan((text) => /overdue .*#someday/.test(text), 'three keys in a row')
  assert.match((await planText()).split('\n')[5], /🔼/, 'and each counted from the one before')
  await pick('someday')
  await row('overdue').waitFor()
  await row('overdue').focus()
  await page.keyboard.press('z')
  await untilPlan((text) => !text.includes('#someday'), 'off Someday')

  // n puts it in next week's cycle, and the cycle filter finds it.
  await pick('today')
  await row('overdue').focus()
  await page.keyboard.press('n')
  await untilPlan((text) => /overdue .*⏳/.test(text), 'a cycle')
  await panel.getByRole('combobox', {name: 'Cycle'}).selectOption({label: 'Next week'})
  await row('overdue').waitFor()
  assert.equal(await row('weekly').count(), 0, 'not in that cycle')
  await panel.getByRole('combobox', {name: 'Cycle'}).selectOption({label: 'All cycles'})

  // Finishing a repeat makes the next one above it, and the Logbook has this one.
  // The second press lands before the redraw and must finish nothing further.
  await row('weekly').waitFor()
  await row('weekly').focus()
  await page.keyboard.press('x')
  await page.keyboard.press('x')
  await untilPlan((text) => text.includes(`- [x] weekly 🔁 every week 📅 ${days.today} ✅ ${days.today}`), 'done')
  assert.ok((await planText()).includes(`- [ ] weekly 🔁 every week 📅 ${days.week}\n- [x] weekly`), 'the next above it')
  await page.waitForTimeout(300)
  assert.equal((await planText()).match(/weekly/g).length, 2, 'one finished and one next, no third')
  await pick('logbook')
  await row('weekly').waitFor()
  await row('weekly').getByRole('checkbox').uncheck()
  await untilPlan((text) => text.includes(`- [ ] weekly 🔁 every week 📅 ${days.today}\n`), 'unticked')

  // Escape goes back to the note on screen.
  await row('weekly').first().focus()
  await page.keyboard.press('Escape')
  assert.equal(await panel.isVisible(), false)
  await page.locator('#sidebar [data-view="tasks"]').click()

  // Enter opens the note at that line.
  await pick('anytime')
  await row('sometime').focus()
  await page.keyboard.press('Enter')
  await until(() => globalThis.textarea.article.textContent.startsWith('# Plan'), {what: 'the note opened'})
  assert.equal(await panel.isVisible(), false)
  const caret = await page.evaluate(() => globalThis.textarea.editor.selection().start)
  assert.ok((await planText()).slice(caret).startsWith('- [ ] sometime'), 'the caret is on its line')

  // With that note on screen the editor takes the write, and an unsaved word stays.
  await page.keyboard.press('ArrowRight')
  await page.evaluate(() => {
    const {editor, article} = globalThis.textarea
    const at = article.textContent.indexOf('sometime')
    editor.select(at, at)
    editor.insert('word ')
  })
  await page.locator('#sidebar [data-view="tasks"]').click()
  await pick('anytime')
  await row('word sometime').waitFor()
  await row('word sometime').focus()
  await page.keyboard.press('x')
  await until(() => globalThis.textarea.article.textContent.includes('- [x] word sometime ✅'), {what: 'the editor following'})
  await untilPlan((text) => text.includes('- [x] word sometime ✅'), 'the library following')

  // The board: a select from the keyboard, and a drag.
  await panel.getByRole('combobox', {name: 'Layout'}).selectOption('board')
  const lane = (name) => panel.getByRole('region', {name, exact: true})
  await lane('Todo').waitFor()
  await panel.getByRole('combobox', {name: 'Status of later'}).selectOption('/')
  await lane('In progress').getByRole('button', {name: 'later'}).waitFor()
  assert.match(await planText(), /- \[\/\] later/)
  await lane('Todo').locator('.database-card', {hasText: 'second task'}).dragTo(lane('Cancelled'))
  await lane('Cancelled').getByRole('button', {name: 'second task'}).waitFor()

  // The timeline: a bar for what has a date, moved by Alt and an arrow.
  await panel.getByRole('combobox', {name: 'Layout'}).selectOption('timeline')
  const bar = panel.locator('.timeline-bar', {hasText: 'later'})
  await bar.waitFor()
  await bar.focus()
  await page.keyboard.press('Alt+ArrowLeft')
  await untilPlan((text) => !text.includes(`later 📅 ${days.week}`), 'the bar moved')
  await panel.getByRole('combobox', {name: 'Layout'}).selectOption('list')

  // Reminders, through a stand-in for the browser's notifications.
  await page.evaluate(() => {
    globalThis.shown = []
    globalThis.Notification = class {
      static permission = 'granted'
      static requestPermission = async () => 'granted'
      constructor(title) {
        globalThis.shown.push(title)
      }
    }
  })
  await box.fill('ring now')
  await page.keyboard.press('Enter')
  await row('ring now').waitFor()
  await page.evaluate(async (days) => {
    const library = await import('/lib/library.js')
    await library.putDocument({id: 'bell', title: 'Bell', text: `# Bell\n\n- [ ] ring the bell ⏰ ${days.today} 00:00\n`})
    const view = await import('/lib/tasks-view.js')
    localStorage.setItem('textarea:reminders', 'on')
    await view.checkReminders()
    await view.checkReminders()
  }, days)
  assert.deepEqual(await page.evaluate(() => globalThis.shown), ['ring the bell'], 'once')

  // A tick in the note makes the next one too, and one undo takes it back.
  await page.locator('#sidebar .sidebar-new').click()
  await until(() => globalThis.textarea.article.textContent === '', {what: 'a new note'})
  assert.equal(await panel.isVisible(), false, 'a new note closes the screen')
  const repeat = `- [ ] again 🔁 every day 📅 ${days.today}`
  await page.evaluate((repeat) => globalThis.textarea.editor.replace(repeat), repeat)
  await page.locator('article').first().locator('.md-task').first().click({position: {x: 1, y: 1}, force: true})
  await until(() => globalThis.textarea.article.textContent.includes('- [x] again'), {what: 'the tick'})
  const ticked = await page.evaluate(() => globalThis.textarea.article.textContent)
  assert.equal(ticked, `- [ ] again 🔁 every day 📅 ${days.tomorrow}\n- [x] again 🔁 every day 📅 ${days.today} ✅ ${days.today}`)
})

test('notes: trees, folders, the slash menu, cards, images and the graph', async () => {
  await reset()
  await page.evaluate(async () => {
    localStorage.removeItem('textarea:sidebar-view')
    const library = await import('/lib/library.js')
    for (const text of [
      '# Alpha\n\nsee [[Beta]]\n#work/taxes',
      '# Beta\n\nthe second note\n#work',
      '# Filed\n\nbody\n\nfolder:: Work/Plans\n',
    ]) {
      await library.putDocument({text, title: text.split('\n')[0].slice(2)})
    }
    await globalThis.textarea.save()
  })
  const sidebar = page.locator('#sidebar')
  const listed = () => sidebar.locator('.sidebar-note').allTextContents()
  await until(() => document.querySelector('[data-view="tag:work/taxes"]'), {what: 'the nested tag row'})
  await sidebar.locator('[data-view="tag:work"]').click()
  assert.deepEqual((await listed()).sort(), ['Alpha', 'Beta'], 'a tag lists what is nested under it')
  await sidebar.locator('[data-view="folder:Work"]').click()
  assert.deepEqual(await listed(), ['Filed'], 'a folder lists what is nested under it')
  await sidebar.getByRole('button', {name: 'Fold Work', exact: true}).click()
  assert.equal(await sidebar.locator('[data-view="folder:Work/Plans"]').count(), 0, 'a branch folds')

  // Moving a note writes one line of its text, and the file stays a plain note.
  await sidebar.locator('[data-view="notes"]').click()
  await sidebar.getByRole('button', {name: 'Beta'}).click()
  await until(() => globalThis.textarea.article.textContent.startsWith('# Beta'), {what: 'Beta'})
  await page.keyboard.press('ControlOrMeta+k')
  const switcher = page.locator('dialog.dialog-switcher')
  await switcher.locator('input').fill('Move to folder')
  await page.keyboard.press('Enter')
  const move = page.locator('dialog.dialog[aria-label="Move to folder"]')
  await move.locator('input').fill('Home / Ideas')
  await move.locator('.dialog-button-primary').click()
  await until(() => globalThis.textarea.article.textContent.endsWith('folder:: Home/Ideas\n'), {what: 'the folder line'})
  await until(() => document.querySelector('[data-view="folder:Home/Ideas"]'), {what: 'the new folder row'})

  // A slash at the start of a line opens the menu; Escape leaves it as typed.
  await reset()
  await page.locator('article').click()
  await page.keyboard.type('/')
  const menu = page.locator('#slash-menu')
  await menu.waitFor({state: 'visible'})
  await page.keyboard.press('Escape')
  await menu.waitFor({state: 'hidden'})
  assert.equal(await noteText(), '/', 'Escape leaves the slash as typed')
  await page.keyboard.press('Backspace')
  await page.keyboard.type('/tab')
  await until(() => document.querySelector('#slash-menu li')?.textContent === 'Table', {what: 'the filtered row'})
  await page.keyboard.press('Enter')
  assert.equal(await noteText(), '| Column | Column |\n|---|---|\n|  |  |')
  await setNote('')
  await page.keyboard.type('/to-do')
  await page.keyboard.press('Enter')
  await page.keyboard.type('water')
  assert.equal(await noteText(), '- [ ] water', 'the caret lands where the snippet says')
  // A division or a path never opens it.
  await setNote('')
  await page.keyboard.type('1/2')
  assert.equal(await menu.isVisible(), false)

  // A card and a picture draw from the tree and leave the note's text alone.
  await reset()
  await page.evaluate(async () => {
    const library = await import('/lib/library.js')
    await library.putDocument({text: '# Target\n\nthe preview line', title: 'Target'})
  })
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  const token = await page.evaluate(async (data) => {
    const {addAttachment} = await import('/lib/attachments.js')
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0))
    return addAttachment(new File([bytes], 'dot.png', {type: 'image/png'}))
  }, png)
  assert.equal(token, '![dot.png](attachments/dot.png)')
  const text = `# Host\n\n[[Target]]\n${token}\ninline [[Target]] stays\n`
  await setNote(text)
  await saveNow()
  await until(() => document.querySelector('.md-card')?.dataset.preview === 'the preview line', {what: 'the card preview'})
  await until(() => document.querySelector('.md-image')?.style.getPropertyValue('--image').includes('data:image/png'), {
    what: 'the picture',
  })
  assert.equal(await noteText(), text, 'cards and pictures add nothing to the text')
  assert.equal(await page.locator('.md-wiki').count(), 2)
  assert.equal(await page.locator('.md-card').count(), 1, 'only the link alone on its line is a card')
  // Typing right after each keeps the caret and the text, and rubbing it out
  // draws the block again.
  await page.locator('article').focus()
  for (const [selector, end] of [
    ['.md-card', text.indexOf('\n', text.indexOf('[[Target]]'))],
    ['.md-image', text.indexOf('\n', text.indexOf(token))],
  ]) {
    await placeCaret(end)
    await page.keyboard.type('x')
    await untilCaret(end + 1, `the caret after ${selector}`)
    assert.equal(await noteText(), `${text.slice(0, end)}x${text.slice(end)}`)
    await page.locator(selector).waitFor({state: 'detached', timeout: 5000})
    await page.keyboard.press('Backspace')
    await untilCaret(end, `the caret back beside ${selector}`)
    assert.equal(await noteText(), text)
    await page.locator(selector).waitFor({state: 'attached', timeout: 5000})
  }

  // A click on the card opens its note.
  await setNote(text)
  await saveNow()
  await page.locator('.md-card').click()
  await until(() => globalThis.textarea.article.textContent.startsWith('# Target'), {what: 'the card to open'})

  // The graph draws the link, and a dot opens its note.
  await sidebar.locator('.sidebar-graph').click()
  const graph = page.locator('dialog.dialog-graph')
  await graph.waitFor({state: 'visible'})
  assert.equal(await graph.locator('line').count(), 1)
  await graph.getByRole('button', {name: /^Open Host/}).click()
  await graph.waitFor({state: 'detached'})
  await until(() => globalThis.textarea.article.textContent.startsWith('# Host'), {what: 'the dot to open'})
  await page.evaluate(() => localStorage.removeItem('textarea:sidebar-view'))
})

test('a picture arrives by paste, by drop and through the slash menu', async () => {
  await reset()
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  const arrive = (kind, name) =>
    page.evaluate(
      ({kind, name, data}) => {
        const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0))
        const transfer = new DataTransfer()
        transfer.items.add(new File([bytes], name, {type: 'image/png'}))
        if (kind === 'paste') {
          // A plain event: Firefox's ClipboardEvent constructor drops clipboardData.
          const event = new Event('paste', {bubbles: true, cancelable: true})
          Object.defineProperty(event, 'clipboardData', {value: transfer})
          document.querySelector('article').dispatchEvent(event)
        } else {
          window.dispatchEvent(new DragEvent('drop', {dataTransfer: transfer, bubbles: true, cancelable: true}))
        }
      },
      {kind, name, data: png},
    )
  // The slash menu's row first, on an empty line where a slash opens it.
  const chooser = page.waitForEvent('filechooser')
  await page.locator('article').focus()
  await page.keyboard.type('/image')
  await page.keyboard.press('Enter')
  await (await chooser).setFiles({name: 'chosen-three.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4')})
  await until(() => globalThis.textarea.article.textContent.includes('[chosen-three.pdf](attachments/chosen-three.pdf)'), {
    what: 'the chosen file',
  })
  assert.ok(!(await noteText()).includes('/image'), 'the slash and its query are gone')
  await arrive('paste', 'pasted-one.png')
  await until(() => globalThis.textarea.article.textContent.includes('(attachments/pasted-one.png)'), {what: 'the paste'})
  await arrive('drop', 'dropped-two.png')
  await until(() => globalThis.textarea.article.textContent.includes('(attachments/dropped-two.png)'), {what: 'the drop'})
  assert.ok((await noteText()).includes('(attachments/pasted-one.png)'), 'a dropped picture does not replace the note')
  await until(() => document.querySelectorAll('.md-image').length === 2 && document.querySelector('.md-attachment'), {
    what: 'two pictures and a file link',
  })
  await until(() => [...document.querySelectorAll('.md-image')].every((el) => el.style.getPropertyValue('--image')), {
    what: 'both pictures to draw',
  })
  const download = page.waitForEvent('download')
  await page.locator('.md-attachment').click()
  assert.equal((await download).suggestedFilename(), 'chosen-three.pdf')
})

test('nothing logged an error along the way', () => {
  const noise = consoleErrors.filter(
    (message) =>
      // Aborted downloads are expected when the anchor fallback races the test.
      !/net::ERR_ABORTED|Failed to load resource/.test(message) &&
      // Outside Chromium, two things the vendored zip library does are logged
      // by the engine itself and are not the app's: it tries its WebAssembly
      // build from a data: URL, which the Content-Security-Policy refuses on
      // purpose (it then runs its JavaScript build), and its worker reports
      // the wrong passwords and oversized archives these tests hand it on
      // purpose. Chromium logs neither, so the gate there is what it was.
      !(
        ENGINE_NAME !== 'chromium' &&
        /data:application\/wasm|Failed to read data from the ReadableStream/.test(message)
      ) &&
      // Firefox logs an IndexedDB transaction that a reload cut short, and no
      // handler in the page stops it (tried on the request, the transaction
      // and the database). A page that closes with unsaved text starts such
      // transactions on purpose, so under Firefox this one line is let
      // through. It is not evidence the write landed - a count of real
      // closes is: 20 of 20 kept their last words in each engine.
      !(ENGINE_NAME === 'firefox' && /^\[JavaScript Error: "AbortError: The operation was aborted\. "\]$/.test(message)),
  )
  assert.deepEqual(noise, [], 'the console should be clean')
})

test('organise by voice hands the transcript over, and the board draws, ticks and keeps focus', async () => {
  // The seam again: no model, only what the panel and the board do with it.
  await page.evaluate(async () => {
    const {createSpeechPanel} = await import('/lib/speech-panel.js')
    const {createBoard} = await import('/lib/board-panel.js')
    const state = {organised: null, changed: null}
    const panel = createSpeechPanel({
      decode: async () => new Float32Array(16_000),
      ensureModel: async () => ({transcribe: async () => 'Fence is done, soil still to buy.'}),
      gpu: async () => false,
      onInsert: () => {},
      canOrganise: () => true,
      onOrganise: (text, {allNotes, say}) => {
        state.organised = {text, allNotes}
        say('Organised into a board.')
      },
    })
    panel.element.id = 'organise-probe'
    panel.element.style.cssText = 'position: fixed; top: 16px; left: 16px; z-index: 5; background: #fff'
    const board = createBoard({
      onChange: (text) => {
        state.changed = text
      },
    })
    board.element.id = 'board-probe'
    board.element.style.cssText = 'position: fixed; top: 16px; right: 16px; z-index: 5; background: #fff'
    globalThis.__organise = state
    globalThis.__board = board
    document.body.append(panel.element, board.element)
    panel.open()
  })
  const probe = page.locator('#organise-probe')
  const board = page.locator('#board-probe')
  try {
    await probe.locator('.speech-input').setInputFiles({name: 'memo.wav', mimeType: 'audio/wav', buffer: Buffer.from('sixteen bytes ok')})
    const organise = probe.getByRole('button', {name: 'Organise into a board'})
    await organise.waitFor({state: 'visible'})
    await probe.getByLabel(/Sort all my notes too/).uncheck()
    await organise.click()
    assert.deepEqual(await page.evaluate(() => globalThis.__organise.organised), {
      text: 'Fence is done, soil still to buy.',
      allNotes: false,
    })
    assert.equal(await probe.locator('.writing-status').textContent(), 'Organised into a board.')

    const md = '# Organised today\n\n## Garden\n- [x] Fence posts\n- [ ] Buy soil\n- ? Which hedge'
    assert.equal(await page.evaluate((md) => globalThis.__board.update(md) && (globalThis.__board.open(), true), md), true)
    assert.equal(await board.locator('.board-title').textContent(), 'Organised today')
    assert.equal(await board.locator('.board-card').count(), 1)
    assert.equal(await board.locator('.board-count').textContent(), '1 of 2 done')
    assert.equal(await board.getByRole('progressbar', {name: 'Garden: 1 of 2 done'}).count(), 1)
    await board.getByLabel('Buy soil').check()
    assert.match(await page.evaluate(() => globalThis.__organise.changed), /- \[x\] Buy soil/)

    // The save that follows redraws the board; the keyboard stays on the box.
    await board.getByLabel('Buy soil').focus()
    await page.evaluate(() => globalThis.__board.update(globalThis.__organise.changed))
    assert.equal(await page.evaluate(() => document.activeElement?.closest('label')?.textContent), 'Buy soil')
    assert.equal(await page.evaluate(() => globalThis.__board.update('just prose')), false, 'prose is not a board')
  } finally {
    await page.evaluate(() => {
      document.querySelector('#organise-probe')?.remove()
      document.querySelector('#board-probe')?.remove()
    })
  }
})
