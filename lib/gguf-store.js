// Where the reader's own GGUF speech model is kept between visits.
//
// Two ways, picked by what the browser can do, never by asking:
//
//   - Linked. Chromium browsers hand out file handles (the same capability
//     lib/file-links.js keeps for links in notes), so the model stays where
//     it is on disk and only the handle is remembered. The browser decides
//     per session whether the handle may be read, so the first transcription
//     after a restart asks once.
//   - Copied. Everywhere else the files are copied into this site's private
//     storage (the origin private file system), which costs their size in
//     disk space once and survives restarts. The panel shows the size before
//     anything is written. Where even that is refused, the files are held for
//     this session only and the panel says so.
//
// The choice is one pair - a model and its mmproj projector - and choosing
// again replaces it. Nothing here reads more than a file's header until the
// engine asks for the whole of it.

import {ensurePermission} from './file-links.js'
import {HEADER_BYTES, describeGguf, pairGguf, readGgufMetadata} from './gguf.js'

const DB_NAME = 'textarea-gguf'
const STORE = 'choice'
const KEY = 'speech'
const FOLDER = 'gguf-speech'
/** How much of a file is copied at a time. */
const COPY_SLICE = 16 * 1024 * 1024

/** Files held for this session only, when nothing could be stored. */
let session = null

/** Whether the model can stay where it is on disk. */
export function canLink() {
  return typeof window !== 'undefined' && typeof window.showOpenFilePicker === 'function' && typeof indexedDB !== 'undefined'
}

function database() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('the model database could not be opened'))
  })
}

async function withStore(mode, act) {
  const db = await database()
  try {
    return await new Promise((resolve, reject) => {
      const request = act(db.transaction(STORE, mode).objectStore(STORE))
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  } finally {
    db.close()
  }
}

const readChoice = () => withStore('readonly', (store) => store.get(KEY)).catch(() => undefined)
const writeChoice = (choice) => withStore('readwrite', (store) => store.put(choice, KEY))
const clearChoice = () => withStore('readwrite', (store) => store.delete(KEY)).catch(() => {})

/**
 * Read each file's header and pair them, or throw with what is wrong.
 *
 * @param {File[]} files
 * @returns {Promise<{model: object, projector: object}>} each with `index`
 *   pointing back into `files`
 */
async function inspect(files) {
  if (!files.length) throw Object.assign(new Error('No file was picked.'), {name: 'AbortError'})
  const described = []
  for (const [index, file] of files.entries()) {
    let metadata
    try {
      metadata = readGgufMetadata(await file.slice(0, HEADER_BYTES).arrayBuffer())
    } catch (error) {
      throw new Error(`${file.name}: ${error.message}`, {cause: error})
    }
    described.push({...describeGguf(metadata), name: file.name, size: file.size, index})
  }
  const pair = pairGguf(described)
  if (pair.error) throw new Error(pair.error)
  return pair
}

const summary = (entry, where) => ({name: entry.name, size: entry.size, kind: entry.kind, where})

/**
 * Pick the pair with the browser's file picker and link it.
 *
 * Call this straight from a click: the picker needs the gesture.
 *
 * @returns {Promise<{model: object, projector: object}>} what the panel shows
 */
export async function chooseLinked() {
  const handles = await window.showOpenFilePicker({
    multiple: true,
    types: [{description: 'GGUF model files', accept: {'application/octet-stream': ['.gguf']}}],
  })
  const files = await Promise.all(handles.map((handle) => handle.getFile()))
  const {model, projector} = await inspect(files)
  const choice = {
    model: {...summary(model, 'linked'), handle: handles[model.index]},
    projector: {...summary(projector, 'linked'), handle: handles[projector.index]},
  }
  await removeCopies()
  await writeChoice(choice)
  session = null
  return {model: summary(model, 'linked'), projector: summary(projector, 'linked')}
}

/**
 * Take the pair from a file input and copy it into this site's storage.
 *
 * @param {FileList | File[]} list
 * @param {{onProgress?: (message: string) => void}} [options]
 * @returns {Promise<{model: object, projector: object}>}
 */
export async function addFiles(list, {onProgress = () => {}} = {}) {
  const files = [...list]
  const {model, projector} = await inspect(files)
  const pair = [model, projector]
  try {
    const root = await navigator.storage.getDirectory()
    await root.removeEntry(FOLDER, {recursive: true}).catch(() => {})
    const folder = await root.getDirectoryHandle(FOLDER, {create: true})
    const total = pair.reduce((sum, entry) => sum + entry.size, 0)
    let done = 0
    for (const entry of pair) {
      const handle = await folder.getFileHandle(entry.name, {create: true})
      if (typeof handle.createWritable !== 'function') throw new Error('no writable files here')
      const writable = await handle.createWritable()
      // Slice by slice rather than stream().pipeTo(): Firefox's pipe into a
      // private file stalls on files this size, and slices give a percentage.
      const file = files[entry.index]
      for (let offset = 0; offset < file.size; offset += COPY_SLICE) {
        onProgress(`Copying into this browser… ${Math.floor((done / total) * 100)}%`)
        const slice = file.slice(offset, offset + COPY_SLICE)
        await writable.write(slice)
        done += slice.size
      }
      await writable.close()
    }
    // Asked, not awaited: Firefox answers through a prompt, and the copy is
    // finished whether or not the reader ever answers it.
    void navigator.storage.persist?.().catch(() => false)
    const choice = {model: summary(model, 'copied'), projector: summary(projector, 'copied')}
    await writeChoice(choice)
    session = null
    return choice
  } catch {
    // Storage refused or full: still usable, until this tab closes.
    await removeCopies()
    await clearChoice()
    session = {model: files[model.index], projector: files[projector.index]}
    return {model: summary(model, 'session'), projector: summary(projector, 'session')}
  }
}

/**
 * The pair as the panel shows it, or null when none is chosen.
 *
 * @returns {Promise<{model: object, projector: object} | null>}
 */
export async function describeChoice() {
  if (session) {
    return {
      model: {name: session.model.name, size: session.model.size, kind: 'model', where: 'session'},
      projector: {name: session.projector.name, size: session.projector.size, kind: 'projector', where: 'session'},
    }
  }
  const choice = await readChoice()
  if (!choice) return null
  return {model: summary(choice.model, choice.model.where), projector: summary(choice.projector, choice.projector.where)}
}

/**
 * Ask for permission to read linked files again, if the browser wants that.
 * Call it early in a click, while the gesture still counts.
 *
 * @returns {Promise<boolean>} false when the reader said no
 */
export async function prepareChoice() {
  const choice = await readChoice()
  if (choice?.model?.where !== 'linked') return true
  return (await ensurePermission(choice.model.handle)) && (await ensurePermission(choice.projector.handle))
}

/**
 * Whether reading the linked files needs the browser to ask first. Asks
 * nothing itself, so it can run without a click.
 *
 * @returns {Promise<boolean>}
 */
export async function needsPermission() {
  const choice = await readChoice()
  if (choice?.model?.where !== 'linked') return false
  try {
    for (const entry of [choice.model, choice.projector]) {
      if (typeof entry.handle?.queryPermission !== 'function') continue
      if ((await entry.handle.queryPermission({mode: 'read'})) !== 'granted') return true
    }
    return false
  } catch {
    return true
  }
}

/**
 * The two files themselves, for the engine.
 *
 * @returns {Promise<File[]>} [model, projector]
 */
export async function choiceFiles() {
  if (session) return [session.model, session.projector]
  const choice = await readChoice()
  if (!choice) throw new Error('Choose your GGUF model files first.')
  if (choice.model.where === 'linked') {
    if (!(await prepareChoice())) throw new Error('Reading the model files was not allowed. Choose them again, or allow it when asked.')
    try {
      return await Promise.all([choice.model.handle.getFile(), choice.projector.handle.getFile()])
    } catch {
      throw new Error(`${choice.model.name} could not be read. It may have been moved or deleted - choose the files again.`)
    }
  }
  try {
    const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle(FOLDER)
    return await Promise.all(
      [choice.model, choice.projector].map(async (entry) => (await folder.getFileHandle(entry.name)).getFile()),
    )
  } catch {
    await clearChoice()
    throw new Error('The copy of the model in this browser is gone (the browser may have cleared site data). Choose the files again.')
  }
}

async function removeCopies() {
  try {
    await (await navigator.storage.getDirectory()).removeEntry(FOLDER, {recursive: true})
  } catch {
    // Nothing copied, or no private file system: nothing to remove.
  }
}

/** Forget the pair, and delete the copy when there is one. */
export async function forgetChoice() {
  session = null
  await removeCopies()
  await clearChoice()
}
