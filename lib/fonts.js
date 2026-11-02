// The reader's own fonts: font files kept in this browser and used for the
// note.
//
// The note font is one of three system stacks, which is fast, always
// available, and never quite the font the reader had in mind. This module is
// the other half: a font file - TTF, OTF, WOFF or WOFF2 - is read in the
// page, judged by the browser itself through the FontFace API, kept in its
// own IndexedDB database, and offered in Settings as more choices for the
// note. Nothing is uploaded anywhere, and the one request this module makes
// is for a font file the reader linked from a public GitHub repository
// (fetchFontFile). Registering a font needs no font-src change in the
// Content-Security-Policy: the bytes are handed to the FontFace constructor
// rather than fetched from a URL, and a policy about URLs never sees them.
//
// Two rules keep it honest:
//
//   The file is judged by the browser, not by us. Signature sniffing narrows
//   the field to the four formats every browser can load, and then
//   FontFace.load() decides whether the bytes really are a font - a corrupt
//   or lying file is refused with a message instead of stored.
//
//   Every function degrades when storage is unavailable, the bargain the
//   document library already makes: a browser that refuses IndexedDB gets no
//   custom fonts and keeps every other feature working.
//
// Nothing here reaches for the DOM or for storage at module load, so the
// pure half - the signatures, the names, the identifiers - can be imported
// and tested without a browser.

import {isCustomFont} from './appearance.js'

/** The preference that switches the feature; anything but "off" is on. */
export const CUSTOM_FONTS_KEY = 'textarea:custom-fonts'

/** The four loadable formats, named for the reader. */
export const FONT_FORMATS = 'TTF, OTF, WOFF or WOFF2'

/** What the file picker filters on; the signatures are the real gate. */
export const FONT_EXTENSIONS = '.ttf,.otf,.woff,.woff2'

/** A font file bigger than this is refused before its bytes are kept. */
export const MAX_FONT_BYTES = 5 * 1024 * 1024

/** How many fonts the shelf holds; past this, one has to go first. */
export const MAX_FONTS = 10

/** Where the fonts live: a database of their own, one store, keyed by id. */
const DB_NAME = 'textarea-fonts'
const DB_VERSION = 1
const STORE = 'fonts'

/** The one host a font may be fetched from: GitHub's raw file service. */
const RAW_HOST = 'raw.githubusercontent.com'

/**
 * The four-byte signatures of the four loadable formats.
 *
 * `true` is the Apple flavour of TrueType. `ttcf` - a font collection - is
 * deliberately absent: no browser hands a collection to FontFace, so a
 * collection would be stored and never render.
 */
const SIGNATURES = [
  ['wOFF', 'woff'],
  ['wOF2', 'woff2'],
  ['OTTO', 'otf'],
  ['\x00\x01\x00\x00', 'ttf'],
  ['true', 'ttf'],
]

/**
 * The format of a font file from its first bytes, or null when it is not one.
 *
 * @param {Uint8Array | ArrayBuffer} bytes
 * @returns {'ttf' | 'otf' | 'woff' | 'woff2' | null}
 */
export function sniffFont(bytes) {
  const head = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? [])
  if (head.length < 4) return null
  const magic = String.fromCharCode(head[0], head[1], head[2], head[3])
  for (const [tag, format] of SIGNATURES) {
    if (magic === tag) return format
  }
  return null
}

/**
 * A font family name the stylesheet can be handed.
 *
 * The name comes from a file name, so it goes through the same charset the
 * identifiers do: letters, digits, spaces, underscores and hyphens, nothing
 * that could end a CSS string or start a declaration. What survives is
 * trimmed to a readable length, and anything that survives as nothing is
 * "Custom font" rather than an empty family.
 *
 * @param {unknown} name
 * @returns {string}
 */
export function safeFamily(name) {
  const cleaned = String(name ?? '')
    .replace(/[^A-Za-z0-9 _-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 48)
    .trim()
    .replace(/^-+|-+$/g, '')
  return cleaned || 'Custom font'
}

/**
 * The family behind a file name: the last path part without its font
 * extension.
 *
 * @param {unknown} name
 * @returns {string}
 */
export function familyFromFileName(name) {
  const base = String(name ?? '').split(/[\\/]/).pop() ?? ''
  return safeFamily(base.replace(/\.(ttf|otf|woff2|woff)$/i, ''))
}

/**
 * The preference id for a family: the family, slugged.
 *
 * The same family therefore replaces itself rather than piling up copies -
 * two files that agree on a name are the same font to the reader - and the
 * pattern readNoteFont() trusts is the shape this produces: `custom-` then
 * lowercase words joined by single hyphens, short enough to read in the
 * address of a preference.
 *
 * @param {unknown} family
 * @returns {string}
 */
export function fontId(family) {
  const slug = safeFamily(family)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '')
  return `custom-${slug || 'font'}`
}

/**
 * The stack a family becomes: quoted, with the system font behind it.
 *
 * A custom font can go missing - cleared storage, a removed preference -
 * so the family never stands alone in the declaration.
 *
 * @param {unknown} family
 * @returns {string}
 */
export function stackFor(family) {
  return `"${safeFamily(family)}", system-ui`
}

/** The message for a file over the cap, in the megabytes Settings quotes. */
function tooLarge() {
  return new Error(`That font file is over ${Math.round(MAX_FONT_BYTES / 1024 / 1024)} MB.`)
}

/**
 * The raw file URL behind a GitHub link, or null when it is not one.
 *
 * Exactly three shapes name a file in a public repository: the raw service
 * itself, a blob page, and the /raw/ path that redirects to one - so those
 * are the only three that come through. Everything else is refused here,
 * before any request is made, because the Content-Security-Policy allows
 * one host and this function is where that promise is kept: a check that
 * only ran after the fetch would already have lost the argument.
 *
 * The query and fragment are dropped, so a blob link with ?raw=1 and the
 * same link without it are the same file, and a branch name containing a
 * slash passes through whole - where the ref ends is the raw service's
 * question, not this one's.
 *
 * @param {unknown} input
 * @returns {string | null}
 */
export function rawGitHubUrl(input) {
  let url
  try {
    url = new URL(String(input ?? '').trim())
  } catch {
    return null
  }
  if (url.protocol !== 'https:') return null

  const parts = url.pathname.split('/').filter(Boolean)

  if (url.hostname === RAW_HOST) {
    // owner/repository/ref/... - with a file to read after the ref
    if (parts.length < 4) return null
    return `https://${RAW_HOST}/${parts.join('/')}`
  }

  if (url.hostname === 'github.com' || url.hostname === 'www.github.com') {
    // owner/repository/blob|raw/ref/file - a tree or a repository root is
    // a folder, and a folder has no bytes to fetch
    if (parts.length < 5) return null
    if (parts[2] !== 'blob' && parts[2] !== 'raw') return null
    return `https://${RAW_HOST}/${[parts[0], parts[1], ...parts.slice(3)].join('/')}`
  }

  return null
}

/**
 * Whether custom fonts are switched on, which is the default.
 *
 * @param {{getItem: (key: string) => string | null}} [storage]
 * @returns {boolean}
 */
export function enabled(storage) {
  try {
    const store = storage ?? globalThis.localStorage
    return store.getItem(CUSTOM_FONTS_KEY) !== 'off'
  } catch {
    // No storage to ask: the feature ships on, like every other default.
    return true
  }
}

/**
 * Whether this browser will give us a database at all.
 *
 * The constructor is checked as well as the global: on an insecure origin
 * `indexedDB` exists but opening it throws, which is the same outcome here.
 */
export function isAvailable() {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null
  } catch {
    return false
  }
}

let dbPromise = null

/** A promise for the open database, opened once and then reused. */
function database() {
  if (!isAvailable()) return Promise.reject(new Error('This browser has no IndexedDB.'))

  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION)

      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, {keyPath: 'id'})
      }

      request.onsuccess = () => {
        const db = request.result
        db.onversionchange = () => {
          db.close()
          dbPromise = null
        }
        resolve(db)
      }

      request.onerror = () => {
        dbPromise = null
        reject(request.error ?? new Error('The font shelf could not be opened.'))
      }

      request.onblocked = () => {
        dbPromise = null
        reject(new Error('The font shelf is in use in another tab.'))
      }
    })
  }

  return dbPromise
}

/** Every IndexedDB request as a promise. */
function fromRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

/**
 * Run a callback inside a transaction and resolve once the transaction has
 * committed - the same wait library.js makes, for the same reason: a request
 * can succeed and the transaction still abort afterwards.
 */
async function inStore(mode, callback) {
  const db = await database()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, mode)
    let result
    transaction.oncomplete = () => resolve(result)
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error ?? new Error('The transaction was aborted.'))
    Promise.resolve(callback(transaction.objectStore(STORE)))
      .then((value) => {
        result = value
      })
      .catch((error) => {
        reject(error)
        try {
          transaction.abort()
        } catch {
          // Already finished; the rejection above is what the caller sees.
        }
      })
  })
}

/**
 * The stack of every stored font, by id.
 *
 * Filled by listFonts() and importFont() - the two calls Settings makes -
 * because the stacks are one read of a family away from the records, and
 * because applyAppearance() wants them synchronously when a control moves.
 *
 * @type {Map<string, string>}
 */
const stacks = new Map()

/** The stacks for applyAppearance()'s third argument. */
export function customStacks() {
  return Object.fromEntries(stacks)
}

/**
 * Every stored font, families in order, without their bytes.
 *
 * @returns {Promise<Array<{id: string, family: string, format: string,
 *   created: number}>>} empty when storage is unavailable
 */
export async function listFonts() {
  if (!isAvailable()) return []
  try {
    const records = (await inStore('readonly', (store) => fromRequest(store.getAll()))) ?? []
    for (const record of records) stacks.set(record.id, stackFor(record.family))
    // The bytes stay in the shelf: what Settings asks for is the list, and
    // handing half a megabyte around to draw three rows would be rude.
    return records
      .map((record) => ({
        id: record.id,
        family: record.family,
        format: record.format,
        created: record.created,
      }))
      .sort((a, b) => a.family.localeCompare(b.family))
  } catch {
    return []
  }
}

/** One stored record, or null. */
async function getFont(id) {
  if (!isAvailable() || !id) return null
  try {
    return (await inStore('readonly', (store) => fromRequest(store.get(id)))) ?? null
  } catch {
    return null
  }
}

/**
 * Read a font file and keep it.
 *
 * The name is the file's own (its family comes from it), the bytes are
 * judged three times - the size, the signature, and the browser's own
 * FontFace.load() - and only what passes all three is written. The face is
 * registered on the way past, so the font is usable the moment it lands.
 *
 * @param {unknown} fileName the file's name, for its family
 * @param {Uint8Array | ArrayBuffer} bytes
 * @returns {Promise<{id: string, family: string, format: string,
 *   created: number}>}
 * @throws {Error} with a message written for the reader
 */
export async function importFont(fileName, bytes) {
  const family = familyFromFileName(fileName)
  const id = fontId(family)
  const buffer =
    bytes instanceof ArrayBuffer
      ? bytes
      : ArrayBuffer.isView(bytes)
        ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
        : null

  if (!buffer || buffer.byteLength === 0) {
    throw new Error('That font file is empty.')
  }
  if (buffer.byteLength > MAX_FONT_BYTES) {
    throw tooLarge()
  }

  const head = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 4))
  const format = sniffFont(head)
  if (!format) {
    throw new Error(`That file is not a font this browser can use (${FONT_FORMATS}).`)
  }

  const face = await loadFace(family, buffer)
  const record = {id, family, format, bytes: buffer, created: Date.now()}

  if (!isAvailable()) {
    throw new Error('This browser keeps no storage for fonts.')
  }
  const existing = await getFont(id)
  if (!existing && (await countFonts()) >= MAX_FONTS) {
    throw new Error(`The shelf holds ${MAX_FONTS} fonts; remove one before adding another.`)
  }
  try {
    await inStore('readwrite', (store) => fromRequest(store.put(record)))
  } catch {
    throw new Error('That font could not be stored.')
  }

  stacks.set(id, stackFor(family))
  addFace(id, face)
  return {id, family, format, created: record.created}
}

/**
 * Read a font file from a GitHub link, refusing anything oversized on the
 * way down.
 *
 * The link is turned down before the network if it is not one of the three
 * shapes rawGitHubUrl trusts; then the declared length is checked, because
 * most servers send one; and then the bytes are counted as they arrive,
 * because a header is a promise nobody has to keep. Whichever notice comes
 * first stops the read - a response body over the shelf's cap is never
 * held whole. The family comes from the file name at the end of the link,
 * percent-decoded the way a pasted URL carries it.
 *
 * @param {unknown} input a GitHub link or a raw link
 * @returns {Promise<{bytes: Uint8Array, name: string}>}
 * @throws {Error} with a message written for the reader
 */
export async function fetchFontFile(input) {
  const url = rawGitHubUrl(input)
  if (!url) {
    throw new Error('That is not a link to a file in a public GitHub repository.')
  }

  let response
  try {
    response = await fetch(url)
  } catch {
    throw new Error('GitHub could not be reached.')
  }
  if (!response.ok) {
    throw new Error(`GitHub answered ${response.status} for that link.`)
  }
  if (Number(response.headers.get('content-length')) > MAX_FONT_BYTES) throw tooLarge()

  const name = familyFromFileName(decoded(url))
  const reader = response.body?.getReader?.()
  if (!reader) {
    // No stream to count on: take the whole buffer and check it after.
    const buffer = await response.arrayBuffer()
    if (buffer.byteLength > MAX_FONT_BYTES) throw tooLarge()
    return {bytes: new Uint8Array(buffer), name}
  }

  const chunks = []
  let total = 0
  for (;;) {
    const {done, value} = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_FONT_BYTES) {
      await reader.cancel().catch(() => {})
      throw tooLarge()
    }
    chunks.push(value)
  }

  const bytes = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    bytes.set(chunk, at)
    at += chunk.byteLength
  }
  return {bytes, name}
}

/**
 * Fetch a font from a GitHub link and keep it, through the same three
 * judgements an uploaded file faces - the size, the signature, and the
 * browser's own FontFace.load().
 *
 * @param {unknown} input
 * @returns {Promise<{id: string, family: string, format: string,
 *   created: number}>}
 * @throws {Error} with a message written for the reader
 */
export async function importFontFromUrl(input) {
  const {bytes, name} = await fetchFontFile(input)
  return importFont(name, bytes)
}

/**
 * A URL with its path percent-decoded, or left alone when the escape is
 * malformed: a file called `My%20Font.ttf` is `My Font.ttf` to everyone
 * who clicked the link before us.
 */
function decoded(url) {
  try {
    return decodeURIComponent(url)
  } catch {
    return url
  }
}

/** How many fonts are stored. */
async function countFonts() {
  try {
    return await inStore('readonly', (store) => fromRequest(store.count()))
  } catch {
    return 0
  }
}

/**
 * The browser's verdict on the bytes: a loaded FontFace, or a message.
 *
 * @param {string} family
 * @param {ArrayBuffer} buffer
 * @returns {Promise<FontFace>}
 */
async function loadFace(family, buffer) {
  try {
    return await new FontFace(family, buffer).load()
  } catch {
    throw new Error(`That file is not a font this browser can read (${FONT_FORMATS}).`)
  }
}

/** The face each id has registered this session, so none is loaded twice. */
const faces = new Map()

/** Take an id's face back out of the document, if it has one there. */
function dropFace(id) {
  try {
    if (faces.has(id)) document.fonts.delete(faces.get(id))
  } catch {
    // The document is gone, and its faces went with it.
  }
  faces.delete(id)
}

/** Register a loaded face with the document, where one can be registered. */
function addFace(id, face) {
  try {
    if (typeof document === 'undefined' || !document.fonts) return
    // A family imported again replaces its face rather than sitting beside it.
    dropFace(id)
    document.fonts.add(face)
    faces.set(id, face)
  } catch {
    // The face is already registered, or the document is gone; either way
    // the record is stored and the next boot registers it again.
  }
}

/**
 * The stack of a stored font, loading and registering it on the way.
 *
 * This is the boot's path for a note that was last seen in a custom font,
 * and Settings' path for a font picked off the shelf: listFonts() knows a
 * stored font's stack, but only this (and importFont) gives it a face.
 * Everything it can fail at comes back null, because a font that is missing,
 * unreadable, or switched off falls back to the stylesheet's own stack
 * rather than holding the note hostage to a preference.
 *
 * @param {string} id
 * @returns {Promise<string | null>}
 */
export async function applyFont(id) {
  if (!isCustomFont(id) || !enabled()) return null
  if (faces.has(id) && stacks.has(id)) return stacks.get(id)
  try {
    const record = await getFont(id)
    if (!record) return null
    const face = await loadFace(record.family, record.bytes)
    addFace(id, face)
    const stack = stackFor(record.family)
    stacks.set(id, stack)
    return stack
  } catch {
    return null
  }
}

/**
 * Forget one font: its stack, its face, and its record.
 *
 * @param {string} id
 * @returns {Promise<boolean>} false when nothing was stored
 */
export async function removeFont(id) {
  if (!isAvailable() || !id) return false
  stacks.delete(id)
  dropFace(id)
  try {
    await inStore('readwrite', (store) => fromRequest(store.delete(id)))
    return true
  } catch {
    return false
  }
}
