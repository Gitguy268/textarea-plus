// The note: the text in the editor, the URL hash that is its primary copy,
// and the library row that mirrors it.

import {attachmentUrl} from './attachments.js'
import {confirmDialog, promptPassword} from './dialog.js'
import {copyText} from './clipboard.js'
import {debounce, Editor} from './editor.js'
import {scheduleSync} from './sync.js'
import {titleOf} from './front-matter.js'
import {
  activeDocumentId,
  getDocument,
  isAvailable as libraryAvailable,
  newId,
  putDocument,
  putDocumentNow,
  setActiveDocumentId,
} from './library.js'
import {parseMarkdown} from './markdown.js'
import {notify} from './notify.js'
import {fileLinksEnabled, tagsEnabled, tasksEnabled, wikilinksEnabled} from './prefs.js'
import {
  DecryptError,
  decodeHash,
  decryptHash,
  encodeHash,
  encryptHash,
  ENCRYPTED_PREFIX,
  isEncryptedHash,
  isHashGettingLong,
  isHashTooLong,
  joinContent,
  splitContent,
} from './share.js'
import {emit} from './signals.js'
import {countStats} from './stats.js'
import {sanitizeStyle} from './style.js'

export const article = document.querySelector('article')

/** Whether the current URL hash holds an encrypted snapshot of the note. */
export const state = {encrypted: false}

/** A page link card's second line; lib/shell.js answers from the library. */
let cardPreview = () => ''
export function setCardPreview(answer) {
  cardPreview = answer
}

/** Draw the note again from its own text: nothing changes but how it looks. */
export function redrawNote() {
  editor.set(article.textContent)
}

// The switches are read here rather than cached: the highlighter runs often
// enough that a getter is cheaper than keeping a copy in sync, and a toggle
// that re-reads on the next keystroke is what makes the switch honest.
export const editor = new Editor(article, (element, text) =>
  parseMarkdown(
    element,
    {
      fileLinks: fileLinksEnabled(),
      wikilinks: wikilinksEnabled(),
      tasks: tasksEnabled(),
      tags: tagsEnabled(),
      preview: (title) => cardPreview(title),
      attachments: (path) => attachmentUrl(path, redrawNote),
    },
    text,
  ),
)

/* --------------------------------------------------------------- the title */

export function updateTitle() {
  // Only a level one heading on the first non-blank line names the document.
  // The old pattern required a trailing newline, so a note consisting of just
  // "# Title" lost its title, and it captured the space after the hash, so the
  // tab read " Title". Upstream issue #26. Leading blank lines are skipped, as
  // before, but "#Title" without a space and "## Sub" are not headings here:
  // only a level one heading names the tab. The rule lives in titleOf() so a
  // note imported from a folder gets the name this tab would give it.
  document.title = titleOf(article.textContent)
}

/* --------------------------------------------------------------- the hash */

/** The note as the codec sees it: the text, and the author's inline style. */
export function currentContent() {
  return joinContent(article.textContent, article.getAttribute('style'))
}

/** Put a decoded note into the editor without pushing it onto the undo stack. */
export function applyContent(content) {
  const {text, style} = splitContent(content)
  editor.set(text)
  // The style half of a shared link is whoever sent the link, not the reader,
  // so it goes through the allowlist before it becomes an attribute.
  const safe = sanitizeStyle(style)
  if (safe) article.setAttribute('style', safe)
  else article.removeAttribute('style')
}

/**
 * Push the note into the URL, and into the document library.
 *
 * While an encrypted snapshot is in the hash the plaintext must never reach it
 * again: autosave stops, and the link stays exactly what was shared. Reloading
 * then asks for the password again, which is the point. The library is separate
 * from the hash and keeps writing while encrypted, or turning on the encryption
 * would silently stop the backup.
 */
export async function save() {
  const text = article.textContent
  if (!state.encrypted) {
    // The '#' is part of the URL, not of the payload the codec returns.
    const hash = '#' + (await encodeHash(currentContent()))
    if (location.hash !== hash) history.replaceState({}, '', hash)
    if (isHashTooLong(hash) && !save.warnedLong) {
      save.warnedLong = true
      notify(
        'This note is now large, and some browsers and servers will refuse a URL this long. ' +
          'Save it to a file instead.',
        {error: true, duration: 6000},
      )
    } else if (isHashGettingLong(hash) && !save.warnedLong && !save.warnedNear) {
      // Said once, early, and not as an error: the link still works.
      save.warnedNear = true
      notify('This note is getting long for a link. Past about twice this size, share it as a file instead.', {
        duration: 5000,
      })
    }
  }
  await saveToLibrary()
  // Clean only now, and only if nothing was typed meanwhile. Marked clean at
  // the top, a save begun by the blur that precedes a closing tab told the
  // flush there was nothing left to save - and then never finished.
  if (article.textContent === text) dirty = false
  // The folder is the library's mirror, so a note that reached the library
  // earns a file a moment later, on the same pause.
  scheduleSync()
  updateTitle()
  // The panels that say something about the note - statistics, backlinks,
  // tasks, the writing tools - are pushed the news rather than polling.
  emit('note')
}

/** Typed since the last save: what a closing tab would lose. */
let dirty = false

const debouncedSave = debounce(500, save)

/**
 * A keystroke: save on the next pause, since re-compressing the note and
 * re-writing its row on every character would be wasteful.
 */
export function scheduleSave() {
  dirty = true
  debouncedSave()
}

/** The row as the library last confirmed it, which is where `created` is kept. */
let stored = null

/**
 * The tab is being hidden or closed with the pause still running: save now.
 *
 * A closing page never comes back from an await, so the ordinary save - which
 * compresses the note, then reads the row, then writes it - may get nowhere.
 * What the browser does finish is an IndexedDB write issued before the page
 * went, so the text goes into the library first, in this turn of the event
 * loop, and the ordinary save is started after it for the tab that was only
 * hidden and lives on.
 *
 * '~' is in no hash the codec writes. If the page dies before save() records
 * the real one, a tab restored on the stale URL finds a row that is not its
 * own, starts a fresh one, and leaves this text in the library instead of
 * writing the older note over it.
 */
export function flushSave() {
  if (!dirty) return
  const id = documentId()
  if (id && libraryAvailable()) {
    const now = Date.now()
    putDocumentNow({
      id,
      title: titleOf(article.textContent) || 'Untitled note',
      text: article.textContent,
      style: article.getAttribute('style'),
      hash: '~',
      // Which address this text was typed under. The row id in hand is
      // shared by every tab of the origin, so the mark alone does not say
      // whose unfinished text this is; the address it came from does.
      from: location.hash.slice(1),
      created: stored?.id === id ? stored.created : now,
      updated: now,
      words: countStats(article.textContent).words,
      // This write replaces the row whole, so the reader's marks on it have
      // to be in it.
      ...(stored?.id === id && stored.pinned && {pinned: true}),
      ...(stored?.id === id && stored.archived && {archived: true}),
    })
  }
  // On a page that really is closing, this save is torn down part-way and
  // rejects. That is the case the write above exists for, not an error.
  save().catch(() => {})
}

/**
 * A row was pinned or archived in My documents. If it is the note on screen,
 * the copy above is the one flushSave() would write back, so it follows.
 *
 * shortcut: a pin set in another tab is not seen here, so that tab closing
 * mid-keystroke can undo it; listen on a BroadcastChannel if that bites.
 *
 * @param {object} record the row as the library now holds it
 */
export function noteFlagged(record) {
  if (record?.id === documentId()) stored = record
}

/**
 * The library row this tab is editing, or null before a note has been claimed.
 *
 * Held in memory because localStorage belongs to the origin, not to the tab: two
 * tabs of the same note would otherwise fight over one row, with the second to
 * write silently taking the first tab's note over.
 */
let currentDocumentId = null

export function documentId() {
  if (currentDocumentId === null) currentDocumentId = activeDocumentId()
  return currentDocumentId
}

/** Point this tab at a different row. */
export function setDocumentId(id) {
  currentDocumentId = id
  setActiveDocumentId(id)
  return id
}

/**
 * Write the note into IndexedDB as the document being edited.
 *
 * One note is one library entry, and which one is held in memory rather than
 * derived from the note. See claimDocumentForHash() for why.
 *
 * Storage that is unavailable or full must never interrupt typing, so a failure
 * here is swallowed. The worst case is that the library is behind.
 */
export async function saveToLibrary(hash = location.hash.slice(1)) {
  if (!libraryAvailable()) return

  let id = documentId()
  if (!id) id = setDocumentId(newId())

  const written = await putDocument({
    id,
    title: document.title,
    text: article.textContent,
    style: article.getAttribute('style'),
    // Without the '#', to match what claimDocumentForHash() compares against.
    // It is the same value the hash codec produces and the same one load() reads.
    hash,
    words: countStats(article.textContent).words,
  })

  // Typing goes on either way, but a library that has silently stopped
  // keeping notes is the failure the reader finds out about too late. Said
  // once per run of failures, and again only after a write has worked.
  if (written) {
    stored = written
    saveToLibrary.failed = false
  } else if (!saveToLibrary.failed) {
    saveToLibrary.failed = true
    notify(
      'This note could not be saved to your documents: the browser\u2019s storage is full or blocked. ' +
        'The link in the address bar still holds it. Export it to a file to be safe.',
      {error: true, duration: 8000},
    )
  }
}

/** textarea-plus: writes to other notes still on their way; lib/database-panel.js says. */
let pendingWrites = () => undefined
export function setPendingWrites(answer) {
  pendingWrites = answer
}

/**
 * Open a note from the library.
 *
 * The hash is rewritten as well as the editor, so the note is shareable again
 * straight away. Replacing the whole document rather than setting the hash is
 * what keeps the back button meaningful and lands the caret at the end of the
 * text, the same as opening a file.
 */
export async function openDocument(entry, {ask = true, quiet = false} = {}) {
  if (!entry) return

  if (ask) {
    const ok = await confirmReplace(entry.title)
    if (!ok) return
  }

  // A list's copy of a row can be older than the row, and the save below would
  // write that older text back over it: a database edit still on its way, say.
  await pendingWrites()
  const row = (await getDocument(entry.id)) ?? entry

  setDocumentId(row.id)
  editor.replace(row.text)
  // A library row can hold a style that arrived through a shared link, so the
  // same allowlist applies here as in applyContent().
  const safe = sanitizeStyle(row.style)
  if (safe) article.setAttribute('style', safe)
  else article.removeAttribute('style')

  save.warnedLong = save.warnedNear = false
  await save()
  emit('menu')
  if (!quiet) notify(`Opened ${row.title}`)
}

/**
 * Whether the note on screen can be left without asking: saved this moment,
 * and saved somewhere it can be reopened from. The sidebar and the tabs move
 * between notes the way a browser moves between tabs, and a question on
 * every click would be the editor guarding text it already keeps.
 */
export async function canLeaveNote() {
  if (!libraryAvailable()) return false
  await save()
  return !saveToLibrary.failed
}

/** Open a note from the sidebar or a tab: no question when nothing is at stake. */
export async function switchDocument(entry) {
  if (!entry || entry.id === documentId()) return
  await openDocument(entry, {ask: !(await canLeaveNote()), quiet: true})
}

/** A new, empty note with its own library entry. */
export async function newDocument({ask = true} = {}) {
  if (ask && article.textContent.trim() !== '') {
    const ok = await confirmDialog({
      title: 'Start a new note?',
      message:
        'What is in the editor now stays in your documents and can be reopened. This note becomes empty.',
      submitLabel: 'New note',
    })
    if (!ok) return
  }

  // A fresh row, or the next keystroke would write the empty note over the one
  // just left behind.
  setDocumentId(newId())
  editor.replace('')
  article.removeAttribute('style')
  save.warnedLong = save.warnedNear = false
  await save()
  notify('New note')
}

/** @returns {Promise<boolean>} false when the reader changed their mind */
export async function confirmReplace(what) {
  if (article.textContent.trim() === '') return true
  const ok = await confirmDialog({
    title: 'Replace the current note?',
    message: `Opening ${what} replaces what is in the editor. It can be undone.`,
    submitLabel: 'Open',
  })
  return ok
}

/**
 * Read the URL hash into the editor.
 *
 * An encrypted hash prompts for its password. A wrong one is worth another try
 * rather than a dead end, since a mistyped password is the common case.
 */
export async function load(event) {
  let hash = location.hash.slice(1)

  // A pairing link from another device's Send panel (lib/nearby.js). It is
  // not a note: the address bar goes back to the note that was there before,
  // and the Receive panel takes the code. The "=" cannot occur in a note hash.
  // A fresh tab carries on as an empty one, claim included, so what arrives
  // gets a library row of its own instead of the one last used.
  if (hash.startsWith('rtc=')) {
    const before = event?.oldURL ? new URL(event.oldURL).hash : ''
    history.replaceState({}, '', before || location.pathname + location.search)
    const offer = hash
    void import('./files.js').then(({receiveFromDevice}) => receiveFromDevice(offer))
    if (before) return
    hash = ''
  }

  const unfinished = await claimDocumentForHash(hash)

  // The last session's tab closed mid-keystroke: its text reached the library
  // but its URL never caught up, and this is that tab coming back on the old
  // URL. The library's copy is the newer one, so it is what opens - and the
  // save that follows finally writes the address the closing tab could not.
  if (unfinished) {
    state.encrypted = false
    applyContent(joinContent(unfinished.text, unfinished.style))
    await save()
    notify('Restored what was typed just before this tab closed')
    return
  }

  if (hash === '') {
    state.encrypted = false
    updateTitle()
    emit('note')
    return
  }

  // The menu's "New" link points at #new so it opens a tab with no JavaScript
  // involved. It is not a note, so it opens an empty one. Upstream fed it to the
  // decoder instead, where it failed and the failure path cleared the editor by
  // accident: the same path a genuinely corrupt link takes, and it left the
  // hash sitting at #new. Upstream issue #37.
  if (hash === 'new') {
    state.encrypted = false
    applyContent('')
    updateTitle()
    emit('note')
    return
  }

  try {
    if (isEncryptedHash(hash)) {
      state.encrypted = true
      const content = await unlock(hash)
      if (content !== null) applyContent(content)
      emit('menu')
    } else {
      state.encrypted = false
      applyContent(await decodeHash(hash))
      updateTitle()
    }
    // The note is on screen, so it belongs in the library even if nobody types
    // a character: a link opened and closed is exactly the note that had no
    // other copy.
    await saveToLibrary()
    emit('note')
  } catch (error) {
    if (error instanceof DecryptError) {
      article.textContent = ''
      article.removeAttribute('style')
      notify('This link could not be opened: ' + error.message, {error: true, duration: 5000})
    } else {
      article.textContent = ''
      article.removeAttribute('style')
    }
  }
}

/**
 * Decide which library row the note in the address bar belongs to.
 *
 * The rule is one row per note, not one row per hash: the hash is rewritten on
 * every keystroke, so it cannot be the identity, and matching rows on it would
 * make every character create a note. Instead the id is held in memory and
 * written through to localStorage, and it is only replaced when the address bar
 * genuinely holds a *different* note than the row in hand.
 *
 * The check is one primary-key read rather than a scan of the library, and it is
 * skipped entirely when there is nothing to compare against.
 *
 * Holding the id in memory rather than reading localStorage on every autosave is
 * also what keeps two tabs apart: localStorage is shared, so the second tab to
 * write would otherwise take over the first tab's note.
 */
export async function claimDocumentForHash(hash) {
  if (!libraryAvailable()) return

  const wanted = hash === '' || hash === 'new' ? '' : hash
  const id = documentId()

  // Nothing in hand, or a first visit: start a row.
  if (!id) {
    setDocumentId(newId())
    return
  }

  const held = await getDocument(id)

  // '~' is the mark flushSave() leaves on a row whose URL was never written.
  // The row is handed back to be reopened only when this page is a tab coming
  // back on the very address that text was typed under. A link opened fresh
  // is a different note that merely found this row in hand, and so is another
  // tab reloading: the id in hand is the origin's, not the tab's, so without
  // the address check a reload would open some other tab's unfinished note. An
  // encrypted link is left alone too: the library's copy is plaintext, and it
  // must not appear without the password having been asked for.
  if (held?.hash === '~' && held.from === wanted && !isEncryptedHash(hash) && cameBack()) return held

  // The row in hand already holds this note, so this is a reload of the same
  // note or a return to the same link, and it stays where it is.
  if (held && held.hash === wanted) return

  // No row, or a row holding something else: this is a different note.
  setDocumentId(newId())
}

/** Whether this page load is a tab returning rather than an address being opened. */
function cameBack() {
  const type = performance.getEntriesByType('navigation')[0]?.type
  return type === 'reload' || type === 'back_forward'
}

/** Prompt for the password of an encrypted hash. Returns null when cancelled. */
export async function unlock(hash) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const password = await promptPassword({
      title: 'This note is encrypted',
      message: 'Enter the password this link was created with.',
      submitLabel: 'Unlock',
    })
    if (password === null) {
      notify('Unlock cancelled')
      return null
    }
    try {
      return await decryptHash(hash.slice(ENCRYPTED_PREFIX.length), password)
    } catch {
      notify('Wrong password', {error: true})
    }
  }
  return null
}

/* -------------------------------------------------------- encrypted sharing */

export async function createEncryptedLink() {
  if (article.textContent === '') {
    notify('There is nothing to share yet', {error: true})
    return
  }

  const password = await promptPassword({
    title: 'Encrypted link',
    message:
      'The note is encrypted with AES-256 and the URL holds only ciphertext. ' +
      'Anyone with the link and the password can read it.',
    confirm: true,
    minLength: 8,
    submitLabel: 'Create',
  })
  if (password === null) return

  const payload = await encryptHash(currentContent(), password)
  const hash = '#' + ENCRYPTED_PREFIX + payload
  history.replaceState({}, '', hash)
  state.encrypted = true
  // The library row keeps the note in the clear even though the URL does not, so
  // the backup survives turning encryption on and off.
  await saveToLibrary()
  emit('menu')

  if (await copyText(location.href)) {
    notify('Encrypted link copied. Edits no longer change the URL.')
  } else {
    notify('Link is encrypted. Copy the address bar to share it.')
  }
}

export async function removeEncryption() {
  const ok = await confirmDialog({
    title: 'Remove encryption?',
    message:
      'The note will be stored in the URL unencrypted, as it was before. ' +
      'Anyone with the link will be able to read it.',
    submitLabel: 'Remove',
    danger: true,
  })
  if (!ok) return
  state.encrypted = false
  save.warnedLong = save.warnedNear = false
  await save()
  emit('menu')
  notify('The link is no longer encrypted')
}

/**
 * A file won the comparison, and this note is the one on screen.
 *
 * The editor is the half of the mirror the sync cannot see: left alone it
 * would hold the losing text and save it straight back over the winner on the
 * next keystroke. editor.replace() pushes onto the undo stack first, so the
 * change arrives undoable, which is what makes replacing what someone may be
 * halfway through typing acceptable at all.
 */
export function applySyncedNote(record) {
  if (record.id !== documentId()) return
  const style = sanitizeStyle(record.style)
  const current = article.getAttribute('style')
  if (article.textContent === record.text && (current ?? null) === (style ?? null)) return
  editor.replace(record.text)
  if (style) article.setAttribute('style', style)
  else article.removeAttribute('style')
  // The reader's own version just lost to the file's, so the message has to
  // carry the way back. The app binds undo to either modifier key on every
  // platform, so naming both is the honest hint without sniffing for a Mac.
  notify('Updated from the folder — Ctrl+Z or ⌘Z undoes it', {duration: 4000})
}
