// The menu: the button, the rows, what each row says and does, and the theme
// row that lives in the query string.

import {confirmDialog} from './dialog.js'
import {copyText} from './clipboard.js'
import {
  backlinksIsOpen,
  openExport,
  openSpeech,
  refreshBacklinks,
  statsPanel,
  toggleBacklinks,
  toggleFileLinks,
  toggleGlass,
  toggleStats,
  toggleTasksPanel,
  toggleTwoColumns,
  toggleWriting,
  updateTasks,
  writingIsOpen,
} from './features.js'
import {fileInput, openFiles, receiveFromDevice} from './files.js'
import {
  connectFolder,
  disconnectFolder,
  folderSyncAvailable,
  folderSyncStatus,
  noteDeleted,
  reconnectFolder,
  scheduleSync,
  syncNow,
} from './sync.js'
import {glassAvailable, glassEnabled, syncRoot, trackGlass} from './glass.js'
import {isAvailable as libraryAvailable} from './library.js'
import {fileLink} from './markdown.js'
import {
  article,
  createEncryptedLink,
  documentId,
  editor,
  newDocument,
  noteFlagged,
  openDocument,
  removeEncryption,
  save,
  state,
} from './note.js'
import {notify} from './notify.js'
import {
  backupEnabled,
  backupEncrypt,
  backupMetadata,
  backupSingleFile,
  fileLinksEnabled,
  librarySort,
  libraryView,
  savedFilters,
  setLibrarySort,
  setLibraryView,
  setSavedFilters,
  setStatsPreferred,
  stickyEnabled,
  tasksEnabled,
  trashEnabled,
  trashKeep,
  twoColumnsEnabled,
} from './prefs.js'
import {on} from './signals.js'
import {nextTheme, readTheme, withTheme} from './theme.js'

const menu = document.querySelector('#menu')
const button = document.querySelector('#button')

/* ---------------------------------------------------------------- the theme */

/** The chrome colour an installed app shows, per theme. */
const THEME_COLORS = {light: '#ffffff', dark: '#000000'}

/**
 * Apply a theme and tell the menu about it.
 *
 * The theme-colour meta tags are scoped to the system preference, so an explicit
 * choice has to take the media off them, or an installed app keeps its title bar
 * in the colour the system wanted rather than the one that was asked for.
 */
export function applyTheme(theme) {
  const root = document.documentElement
  if (theme === 'system') delete root.dataset.theme
  else root.dataset.theme = theme

  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
    if (theme === 'system') {
      meta.setAttribute('media', meta.dataset.systemMedia ?? '')
      meta.setAttribute('content', THEME_COLORS[meta.dataset.systemScheme ?? 'light'])
    } else {
      meta.removeAttribute('media')
      meta.setAttribute('content', THEME_COLORS[theme])
    }
  }

  updateMenuState()
}

export function initTheme() {
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
    meta.dataset.systemMedia = meta.getAttribute('media') ?? ''
    const scheme = meta.getAttribute('media')?.includes('dark') ? 'dark' : 'light'
    meta.dataset.systemScheme = scheme
  }

  applyTheme(readTheme(location.search))

  onMenu('theme', () => {
    const theme = nextTheme(readTheme(location.search))
    // The note in the hash has to survive this untouched.
    history.replaceState({}, '', withTheme(location.href, theme))
    applyTheme(theme)
  })
}

/* -------------------------------------------------------------------- menu */

export function updateMenuState() {
  document.querySelector('#menu-stats')?.setAttribute('aria-checked', String(statsPanel.isOpen()))
  document.querySelector('#menu-backlinks')?.setAttribute(
    'aria-checked',
    String(backlinksIsOpen()),
  )
  document.querySelector('#menu-writing')?.setAttribute(
    'aria-checked',
    String(writingIsOpen()),
  )
  document.querySelector('#menu-columns')?.setAttribute(
    'aria-checked',
    String(twoColumnsEnabled()),
  )

  // The padlock says which way the switch is currently pointing, so the row reads
  // correctly before it is opened as well as after.
  const encryptionIcon = document.querySelector('#menu-encryption use')
  if (encryptionIcon) {
    const href = state.encrypted ? '#icon-unlock' : '#icon-lock'
    encryptionIcon.setAttribute('href', href)
    encryptionIcon.setAttribute('xlink:href', href)
  }

  const encryption = document.querySelector('#menu-encryption-label')
  if (encryption) encryption.textContent = state.encrypted ? 'Encryption: on' : 'Encryption'

  const columns = document.querySelector('#menu-columns-label')
  if (columns) columns.textContent = 'Two column PDFs: ' + (twoColumnsEnabled() ? 'on' : 'off')

  // The switch and the action it gates travel together: without a picker the
  // row would promise something this browser cannot do, and with the switch
  // off the action would have nowhere to lead.
  const fileLinksRow = document.querySelector('#menu-filelinks')
  if (fileLinksRow) {
    const available = 'showOpenFilePicker' in window
    fileLinksRow.hidden = !available
    fileLinksRow.setAttribute('aria-checked', String(fileLinksEnabled()))
    const fileLinksLabel = document.querySelector('#menu-filelinks-label')
    if (fileLinksLabel) {
      fileLinksLabel.textContent = 'File links: ' + (fileLinksEnabled() ? 'on' : 'off')
    }
    const fileLinkAction = document.querySelector('#menu-filelink')
    if (fileLinkAction) fileLinkAction.hidden = !available || !fileLinksEnabled()
  }
  const theme = document.querySelector('#menu-theme-label')
  if (theme) theme.textContent = 'Theme: ' + readTheme(location.search)

  // A reader who has asked for reduced transparency has no effect to switch,
  // so the row is not offered rather than sitting there doing nothing.
  const glassRow = document.querySelector('#menu-glass')
  if (glassRow) {
    glassRow.hidden = !glassAvailable()
    glassRow.setAttribute('aria-checked', String(glassEnabled()))
  }
  const glass = document.querySelector('#menu-glass-label')
  if (glass) glass.textContent = 'Glass: ' + (glassEnabled() ? 'on' : 'off')

  // The Backup row is a switch-gated action like the file-link one: it hides
  // with the switch, and with the storage it would read from - a private
  // window that refuses IndexedDB has no library to put in an archive.
  const backupRow = document.querySelector('#menu-backup')
  if (backupRow) backupRow.hidden = !backupEnabled() || !libraryAvailable()

  // The Trash row hides the same way: with its switch, and with the storage
  // that would hold the notes it recovers.
  const trashRow = document.querySelector('#menu-trash')
  if (trashRow) trashRow.hidden = !trashEnabled() || !libraryAvailable()

  // The Tasks row is a switch-gated action the same way: with its switch,
  // and with the storage whose notes it would read.
  const tasksRow = document.querySelector('#menu-tasks')
  if (tasksRow) tasksRow.hidden = !tasksEnabled() || !libraryAvailable()

  // The sticky note: with its switch, where the browser has the window for it.
  const stickyRow = document.querySelector('#menu-sticky')
  if (stickyRow) stickyRow.hidden = !stickyEnabled() || !('documentPictureInPicture' in window)

  // Folder sync is offered only where the browser can honour it, and the row
  // says which folder it is talking to - even one merely remembered and
  // waiting for permission, which is the folder the reader must click to
  // allow - and, past the name, how the mirror is going right now. The state
  // is read fresh on every open, the same as the share link and every other
  // row here.
  const status = folderSyncStatus()
  const folderRow = document.querySelector('#menu-folder')
  if (folderRow) folderRow.hidden = !folderSyncAvailable()
  const folder = document.querySelector('#menu-folder-label')
  if (folder) {
    folder.textContent = status.name ? `Folder sync: ${status.name}` : 'Folder sync'
    let step = ''
    if (status.active) {
      if (status.syncing) step = 'Syncing…'
      else if (status.problem) step = 'Sync problem'
      else if (status.pending) step = 'Waiting to sync'
      else if (status.lastPass) step = 'Up to date'
    }
    if (step) folder.textContent += ` · ${step}`
  }

  // The action sits beside the state it acts on, and only while there is a
  // folder to act on: a sync-now with nothing connected has nothing to say.
  const syncRow = document.querySelector('#menu-sync')
  if (syncRow) syncRow.hidden = !status.active
}

on('menu', updateMenuState)

export function hideMenu() {
  menu.classList.remove('visible')
  button.setAttribute('aria-expanded', 'false')
}

export function onMenu(id, handler) {
  const element = document.querySelector('#menu-' + id)
  element?.addEventListener('click', (event) => {
    event.preventDefault()
    hideMenu()
    handler()
  })
}

/**
 * Connect to a folder, or offer to stop.
 *
 * Stopping asks first and says the files stay, because the menu row is one
 * click and a mirror that silently stops mirroring is the worse surprise of
 * the two. Reconnecting a folder from an earlier session tries its saved
 * handle before opening the picker again: Chrome's permission bubble is one
 * click, a new pick is a trip through the filesystem.
 */
export async function toggleFolderSync() {
  if (folderSyncStatus().active) {
    const status = folderSyncStatus()
    const ok = await confirmDialog({
      title: 'Folder sync',
      message:
        `Every note is mirrored to "${status.name}", where any editor can open it. ` +
        'Stopping leaves every file where it is.',
      submitLabel: 'Stop syncing',
    })
    if (!ok) return
    await disconnectFolder()
    updateMenuState()
    notify('Folder sync stopped')
    return
  }

  let name = await reconnectFolder()
  if (!name) {
    let result
    try {
      result = await connectFolder()
    } catch (error) {
      notify(error?.message ?? 'The folder could not be opened.', {error: true, duration: 6000})
      return
    }
    if (result.cancelled) return
    name = result.name
  }

  updateMenuState()
  notify(`Syncing to ${name}`)
}

/** The focusable menu items, in order, skipping the one that is hidden. */
export function menuItems() {
  return [...menu.querySelectorAll('.item:not([hidden])')]
}

/**
 * The button is 46px across, a fifth of a panel: the module's panel-sized
 * bulge would smear it, so it gets a shallower one and a thinner neutral core.
 */
const BUTTON_GLASS = {scale: -36, chroma: 5, border: 0.16, mapBlur: 5, blur: 3, saturate: 1.6}

export function initMenu() {
  // The button's glass is stylesheet until the menu first opens; this is the
  // class that stylesheet hangs off.
  syncRoot()
  button.addEventListener('click', (event) => {
    if (event.clientX || event.targetTouches) ripple(event)
    const open = menu.classList.toggle('visible')
    button.setAttribute('aria-expanded', String(open))
    document.querySelector('#menu-share')?.setAttribute('href', location.href)
    updateMenuState()
    // The first time the menu opens is the first time the glass module is
    // worth fetching; before that there has been nothing to put it on.
    if (open) {
      trackGlass(menu)
      // The module is being fetched for the menu anyway, so the button's
      // refraction arrives with it rather than with the boot.
      trackGlass(button, BUTTON_GLASS)
    }
  })

  document.body.addEventListener('click', (event) => {
    const target = event.target
    if (target.closest('#menu')) return
    if (target.closest('#button')) return
    if (target.closest('.ripple')) return
    hideMenu()
  })

  // A menu opened from the keyboard has to be navigable and dismissable from the
  // keyboard, and the focus belongs back on the button that opened it.
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !menu.classList.contains('visible')) return
    hideMenu()
    // The focus goes back on the next frame. Focus moved while the item that had
    // it is still visible, and the browser hands focus to the body when that item
    // finishes hiding 100ms later, which loses the handback.
    requestAnimationFrame(() => button.focus())
  })

  // Arrow keys are handled on the document rather than on the menu, so they work
  // with the focus still on the button that opened it. Tab is left to move the
  // focus out, with the menu closing behind it.
  document.addEventListener('keydown', (event) => {
    if (!menu.classList.contains('visible')) return

    if (event.key === 'Tab') {
      hideMenu()
      return
    }

    const items = menuItems()
    if (!items.length) return

    // Focus on the button counts as being before the first item, so the first
    // arrow press walks into the menu instead of skipping its first entry.
    const from = items.indexOf(document.activeElement)
    const step = {ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1}[event.key]
    let to
    if (step) to = from < 0 ? 0 : (from + step + items.length) % items.length
    else if (event.key === 'Home') to = 0
    else if (event.key === 'End') to = items.length - 1
    else return

    event.preventDefault()
    items[to].focus()
  })

  onMenu('open', () => fileInput.click())

  onMenu('filelinks', toggleFileLinks)
  onMenu('filelink', async () => {
    try {
      // Loaded on the click that needs it, like the panels: a reader who never
      // links a file never pays for the store that holds them.
      const {pickFile} = await import('./file-links.js')
      const picked = await pickFile()
      editor.insert(fileLink(picked.name, picked.id))
      notify(`Linked ${picked.name}`)
    } catch (error) {
      if (error?.name === 'AbortError') return
      notify(error?.message ?? 'The file could not be linked.', {error: true, duration: 6000})
    }
  })

  // The panels a reader opens rarely are fetched when their entry is used
  // rather than parsed at boot: the click waits the few milliseconds the fetch
  // takes, and every boot that never opens them pays nothing.
  onMenu('export', openExport)

  onMenu('send', async () => {
    const text = article.textContent
    if (text.trim() === '') {
      notify('There is nothing to send yet')
      return
    }
    const {showSendPanel} = await import('./nearby-panel.js')
    const result = await showSendPanel({title: document.title, text})
    if (result === 'sent') notify('Sent to the other device')
    else if (result === 'declined') notify('The other device declined the note')
  })

  onMenu('receive', () => receiveFromDevice())

  onMenu('documents', async () => {
    const {showDocumentsPanel} = await import('./library-panel.js')
    showDocumentsPanel({
      activeId: documentId(),
      onOpen: openDocument,
      onNew: newDocument,
      onDelete: (id) => {
        noteDeleted(id)
        // One of the notes on screen's list may have just left it.
        refreshBacklinks()
        // The tasks panel's rows are library-wide: one of them just left.
        updateTasks()
      },
      // The reader's switch, read at the moment the panel opens: on, a delete
      // waits in the trash; off, it is for good.
      trash: trashEnabled(),
      sort: librarySort(),
      onSort: setLibrarySort,
      view: libraryView(),
      onView: setLibraryView,
      filters: savedFilters(),
      onFilters: setSavedFilters,
      onFlag: noteFlagged,
      notify: (message, isError) => notify(message, {error: Boolean(isError)}),
    })
  })

  onMenu('folder', toggleFolderSync)
  // The note on screen joins the archive as it stands: the 500ms save may
  // still be pending when the reader clicks, and a backup that missed the last
  // few seconds of typing is exactly the one that needed to be right. The
  // module is fetched on the click that needs it, the same as the panels: a
  // reader who never backs up never pays for the code that writes the archive.
  onMenu('backup', async () => {
    try {
      await save()
      const {backupInteractive} = await import('./backup.js')
      await backupInteractive({
        metadata: backupMetadata(),
        encrypt: backupEncrypt(),
        single: backupSingleFile(),
        notify: (message, isError) => notify(message, {error: Boolean(isError)}),
      })
    } catch (error) {
      notify(error?.message ?? 'The backup could not be written.', {error: true, duration: 6000})
    }
  })

  // Restoring puts a note back into the library, which is the folder mirror's
  // cue to write its file again and the backlinks' cue to look again - the
  // same two things a save would have told them.
  onMenu('trash', async () => {
    try {
      const {showTrashPanel} = await import('./library-panel.js')
      await showTrashPanel({
        keepDays: Number(trashKeep()),
        onRestore: () => {
          scheduleSync()
          refreshBacklinks()
          updateTasks()
        },
        notify: (message, isError) => notify(message, {error: Boolean(isError)}),
      })
    } catch (error) {
      notify(error?.message ?? 'The trash could not be opened.', {error: true, duration: 6000})
    }
  })
  // A pass on demand, with the result in the same bubble as everything else:
  // what was written, imported, or removed - or nothing, said plainly, when
  // the folder already holds every note.
  onMenu('sync', async () => {
    const counts = await syncNow()
    if (!counts) return
    const parts = []
    if (counts.written) parts.push(`${counts.written} written`)
    if (counts.imported) parts.push(`${counts.imported} imported`)
    if (counts.removed) parts.push(`${counts.removed} removed`)
    notify(parts.length ? `Synced — ${parts.join(', ')}` : 'Nothing to sync — the folder is in step')
  })

  onMenu('encryption', async () => {
    const {showEncryptionPanel} = await import('./encryption-panel.js')
    showEncryptionPanel({
      encrypted: state.encrypted,
      onEncrypt: createEncryptedLink,
      onDecrypt: removeEncryption,
    })
  })

  onMenu('stats', toggleStats)
  onMenu('backlinks', () => {
    void toggleBacklinks()
  })
  onMenu('tasks', () => {
    void toggleTasksPanel()
  })
  onMenu('writing', () => {
    void toggleWriting()
  })
  onMenu('speech', () => {
    void openSpeech()
  })
  onMenu('sticky', async () => {
    const {openSticky} = await import('./sticky.js')
    openSticky(article).catch((error) => notify(error?.message ?? 'The sticky note could not open.', {error: true}))
  })
  onMenu('glass', toggleGlass)
  onMenu('columns', toggleTwoColumns)

  // The rows are a module of their own, fetched with the panel: they are
  // 270 lines that only ever run on this click.
  onMenu('settings', async () => {
    const [{showSettingsPanel}, {settingsRows}] = await Promise.all([
      import('./settings-panel.js'),
      import('./settings-rows.js'),
    ])
    await showSettingsPanel({
      features: settingsRows(),
      // The panel reports its own fonts through the same bubble every
      // other panel uses, injected rather than imported so the settings
      // dialog never grows a piece of the page it sits in.
      notify: (message, isError) => notify(message, {error: Boolean(isError)}),
    })
  })

  // The panel has its own close button, which is not the menu, so the menu entry
  // and the panel have to be told about each other in both directions.
  statsPanel.onDismiss(() => {
    setStatsPreferred(false)
    updateMenuState()
  })

  document.querySelector('#menu-share')?.addEventListener('click', async (event) => {
    event.preventDefault()
    hideMenu()
    if (!(await copyText(location.href))) {
      notify('The browser would not copy to the clipboard', {error: true})
      return
    }
    notify(state.encrypted ? 'Encrypted link copied' : 'Link copied')
  })

  fileInput.addEventListener('change', () => {
    const files = fileInput.files
    openFiles(files)
    fileInput.value = ''
  })
}

export function ripple(event) {
  const circle = document.createElement('span')
  const diameter = Math.max(button.clientWidth, button.clientHeight)
  const radius = diameter / 2
  circle.style.width = circle.style.height = `${diameter}px`
  circle.style.left = `${(event.clientX || event.targetTouches[0].pageX) - button.offsetLeft - radius}px`
  circle.style.top = `${(event.clientY || event.targetTouches[0].pageY) - button.offsetTop - radius}px`
  circle.classList.add('ripple')
  const previous = button.getElementsByClassName('ripple')[0]
  if (previous) previous.remove()
  button.append(circle)
}
