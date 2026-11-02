// The entry point: wire the modules in lib/ together, boot, and expose the
// small surface the tests and the console use. Everything that does something
// lives in lib/ - see docs/ARCHITECTURE.md for which file owns what.

import {applyAppearance, isCustomFont, readAppearance} from './lib/appearance.js'
import {
  applyBacklinksPreference,
  applyStatsPreference,
  applyWritingPreference,
  expandTaskShortcut,
  openWikiLink,
  statsPanel,
  toggleTask,
} from './lib/features.js'
import {initDragAndDrop, initFileHandling, hasFileDrag, openFileLink, openFiles} from './lib/files.js'
import {
  connectToDirectory,
  disconnectFolder,
  folderSyncAvailable,
  folderSyncStatus,
  restoreFolder,
  setFolderSyncApply,
  setFolderSyncNotice,
  syncNow,
} from './lib/sync.js'
import {initMenu, initTheme, updateMenuState} from './lib/menu.js'
import {
  applySyncedNote,
  article,
  documentId,
  editor,
  flushSave,
  load,
  newDocument,
  openDocument,
  save,
  scheduleSave,
  state,
  updateTitle,
} from './lib/note.js'
import {notify} from './lib/notify.js'
import {readNote} from './lib/read-note.js'
import {initShortcuts} from './lib/shortcuts.js'
import {initShell} from './lib/shell.js'

/**
 * A custom font chosen in Settings, fetched and applied after the first
 * paint.
 *
 * The bytes live in IndexedDB and register through the FontFace API, so
 * this cannot be part of the synchronous line below: the built-in stack is
 * already on screen while the file is read, exactly the bargain any other
 * webfont makes. A font that is missing, unreadable, or switched off
 * leaves that stack in place and says nothing - holding the note hostage
 * to a preference would be worse than a font that did not arrive.
 */
function applyFontPreference() {
  const appearance = readAppearance(localStorage)
  if (!isCustomFont(appearance.font)) return
  void import('./lib/fonts.js')
    .then(async ({applyFont}) => {
      const stack = await applyFont(appearance.font)
      if (stack) applyAppearance(document.documentElement, appearance, {[appearance.font]: stack})
    })
    .catch(() => {
      // No shelf, or no FontFace: the default stack stays.
    })
}

function init() {
  initMenu()
  initTheme()
  // The reader's own accent and note sizing are preferences like the rest:
  // applied at boot, next to the theme, so a stored choice never flashes
  // its absence before the override lands.
  applyAppearance(document.documentElement, readAppearance(localStorage))
  applyFontPreference()
  initDragAndDrop()
  initFileHandling()
  applyStatsPreference()
  // The backlinks panel and the writing tools build themselves only if they
  // were left open, so these stay no-ops - and stay off the boot's fetch
  // list - for a reader who has never switched the features on.
  void applyBacklinksPreference()
  void applyWritingPreference()
  updateMenuState()
  initShell()

  // Background sync has no menu to speak from, so problems land in the same
  // bubble everything else uses, and a folder remembered from the last session
  // asks Chrome for it back right away.
  setFolderSyncNotice((message, isError) => notify(message, {error: Boolean(isError), duration: 6000}))
  setFolderSyncApply(applySyncedNote)
  restoreFolder().then((name) => {
    if (name) notify(`Syncing to ${name}`)
  })

  // The title follows the first keystroke; the URL and the library are
  // rewritten on a pause - and at once when the tab is hidden or closed, so
  // the pause can never cost the last words typed.
  article.addEventListener('input', (event) => {
    expandTaskShortcut(event)
    updateTitle()
    scheduleSave()
  })
  article.addEventListener('blur', save)
  addEventListener('pagehide', flushSave)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushSave()
  })
  article.addEventListener('click', (event) => {
    // The checkbox is a span, not a link, and it writes the one character
    // the task is made of - which the keyboard would have typed anyway.
    if (event.target.classList.contains('md-task')) {
      toggleTask(event.target)
      return
    }
    if (event.target.tagName !== 'A') return
    // A file kept with the note: handed over as a download on the click.
    if (event.target.classList.contains('md-attachment')) {
      void import('./lib/attachments.js').then(({downloadAttachment}) =>
        downloadAttachment(event.target.dataset.attachment),
      )
      return
    }
    // A wikilink resolves against this browser's library: its title is on
    // the element, and whether nothing is made on a miss is the reader's
    // choice under the switch.
    if (event.target.classList.contains('md-wiki')) {
      openWikiLink(event.target.dataset.wikiTitle)
      return
    }
    // A link to a file on this computer is not a URL: it resolves against
    // this browser's own records, and the module that holds them arrives on
    // the click.
    if (event.target.classList.contains('md-file')) {
      openFileLink(event.target.dataset.fileId)
      return
    }
    // noopener and noreferrer in the features string: the href is note content,
    // so the page that receives the click must not hold window.open's default
    // handle on this tab. The anchor's own rel does not apply here, because this
    // call opens the tab, not the default navigation.
    window.open(event.target.getAttribute('href'), '_blank', 'noopener,noreferrer')
  })
  article.addEventListener('dragover', (event) => {
    if (hasFileDrag(event)) event.preventDefault()
  })

  addEventListener('hashchange', load)
  addEventListener('load', () =>
    new MutationObserver(save).observe(article, {attributeFilter: ['style']}),
  )
  initShortcuts()

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js')
  }
}

init()

// A module script is deferred, so DOMContentLoaded may already have fired.
if (document.readyState === 'loading') {
  addEventListener('DOMContentLoaded', load)
} else {
  load()
}

// A small programmatic surface, handy from the console and used by the tests.
globalThis.textarea = {
  article,
  editor,
  openFiles,
  openDocument,
  newDocument,
  readNote: () => readNote({article}),
  statsPanel,
  // The folder the menu picks is reached the same way from here: a handle the
  // caller already holds (an OPFS directory in the tests) skips the native
  // picker every automation would have to sit through.
  folderSync: {
    available: folderSyncAvailable,
    connect: connectToDirectory,
    sync: syncNow,
    disconnect: disconnectFolder,
    get status() {
      return folderSyncStatus()
    },
  },
  // The save the input listener holds back for 500ms, callable now. A caller
  // that already knows the note is ready - the reader who just finished
  // typing, or a test that should not spend half a second on every wait -
  // makes the pending save land instead of waiting it out.
  save,
  get state() {
    return state
  },
  get documentId() {
    return documentId()
  },
}
