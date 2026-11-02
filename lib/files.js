// Files coming in: the file input, a drop anywhere on the page, the
// installed app's "Open with", and a `[name](file:id)` link in the note.

import {promptPassword} from './dialog.js'
import {confirmReplace, editor, save} from './note.js'
import {notify, showBusy} from './notify.js'
import {twoColumnsEnabled} from './prefs.js'

export const fileInput = document.querySelector('#file-input')
const dropOverlay = document.querySelector('#drop-overlay')

/**
 * Follow a `[name](file:id)` link from the note.
 *
 * The store arrives on the click, so a reader who never follows such a link
 * never downloads it. Everything that can go wrong - the record is not on
 * this machine, the browser will not re-admit the handle - is said out loud
 * rather than left as a click that did nothing, and the note itself is never
 * touched until a file has actually been read.
 */
export async function openFileLink(id) {
  try {
    const {openLinkedFile} = await import('./file-links.js')
    const file = await openLinkedFile(id)
    await openFiles([file])
  } catch (error) {
    notify(error?.message ?? 'That file could not be opened.', {error: true, duration: 6000})
  }
}

/** textarea-plus: what a drop of pictures does; lib/shell.js says. */
let attachDropped = null
export function setDropAttach(handler) {
  attachDropped = handler
}

export async function openFiles(files) {
  const list = [...files]
  if (list.length === 0) return

  if (list.length > 1) {
    // The editor holds one note, so a multi-file drop would have to invent a
    // container. Say what happened instead of silently keeping only the first.
    notify(`Only the first of ${list.length} files was opened: ${list[0].name}`)
  }

  const file = list[0]

  if (!(await confirmReplace(file.name))) return

  try {
    const result = await openWithPassword(file)
    editor.replace(result.text)
    save.warnedLong = save.warnedNear = false

    // Say what was opened first, then anything worth knowing about how it was
    // read. A note about columns or an odd encoding is a footnote, not a failure:
    // the text is in the editor either way, so replacing the confirmation with the
    // footnote would leave the user guessing whether anything happened at all.
    const kind = result.pages ? 'PDF' : 'file'
    const opened = `Opened ${result.source ?? file.name}${result.pages ? `, ${result.pages} pages` : ''} (${kind})`
    notify(result.warning ? `${opened}\n\n${result.warning}` : opened, {
      error: false,
      duration: result.warning ? 8000 : 2000,
    })
  } catch (error) {
    if (error?.message === 'Cancelled') return
    notify(error?.message ?? `Could not open ${file.name}`, {error: true, duration: 6000})
  }
}

/**
 * A note sent from another device's Send panel opens like a file dropped
 * here: the same question before it replaces anything, and the same undo.
 *
 * @param {string} [offer]  the pairing code from a link, if there was one
 */
export async function receiveFromDevice(offer) {
  const [{showReceivePanel}, {sanitizeFilename}] = await Promise.all([
    import('./nearby-panel.js'),
    import('./filename.js'),
  ])
  const note = await showReceivePanel(offer)
  if (!note) return
  const name = sanitizeFilename(note.title, 'Received note') + '.md'
  await openFiles([new File([note.text], name, {type: 'text/markdown'})])
}

export async function openWithPassword(file) {
  // The readers - text, PDF, ZIP - arrive with the first file opened, not at
  // boot: a session that only types never needs any of them.
  const [{extensionOf, readFile}, {PdfPasswordError}] = await Promise.all([
    import('./open.js'),
    import('./pdf.js'),
  ])
  const isPdf = extensionOf(file.name) === 'pdf'
  try {
    return await readFile(file, {onprogress: showBusy, twoColumns: twoColumnsEnabled()})
  } catch (error) {
    // A locked PDF falls through to the prompt below; everything else stops
    // here. Keeping the prompt outside the catch means cancelling is a decision
    // of its own rather than a new error thrown while handling this one.
    if (!(error instanceof PdfPasswordError)) throw error
    if (!isPdf) throw error
  }

  const password = await promptPassword({
    title: 'Password protected PDF',
    message: `${file.name} cannot be opened without its password.`,
    submitLabel: 'Open',
  })
  if (password === null) throw new Error('Cancelled')
  return readFile(file, {
    onprogress: showBusy,
    twoColumns: twoColumnsEnabled(),
    password,
  })
}

/* --------------------------------------------------------- drag and drop */

export function initDragAndDrop() {
  const hasFiles = (event) => [...(event.dataTransfer?.types ?? [])].includes('Files')

  let depth = 0

  addEventListener('dragenter', (event) => {
    if (!hasFiles(event)) return
    event.preventDefault()
    depth++
    dropOverlay.classList.add('visible')
  })

  addEventListener('dragover', (event) => {
    if (!hasFiles(event)) return
    // Required, or the browser navigates to the dropped file instead.
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  })

  addEventListener('dragleave', (event) => {
    if (!hasFiles(event)) return
    depth = Math.max(0, depth - 1)
    if (depth === 0) dropOverlay.classList.remove('visible')
  })

  addEventListener('drop', (event) => {
    if (!hasFiles(event)) return
    event.preventDefault()
    depth = 0
    dropOverlay.classList.remove('visible')
    const files = [...event.dataTransfer.files]
    if (files.every((file) => file.type.startsWith('image/')) && attachDropped) attachDropped(files)
    else openFiles(files)
  })
}

/* ------------------------------------------------------------- installed PWA */

export function initFileHandling() {
  // Lets the app be a target in the OS "Open with" menu once installed. Both
  // globals are read off window: a bare `LaunchParams` throws a ReferenceError
  // where the interface is not exposed, which would take the whole app down.
  if (!('launchQueue' in window)) return
  if (!window.LaunchParams || !('files' in window.LaunchParams.prototype)) return

  window.launchQueue.setConsumer(async (params) => {
    if (!params?.files?.length) return
    openFiles(params.files)
  })
}

export function hasFileDrag(event) {
  return [...(event.dataTransfer?.types ?? [])].includes('Files')
}
