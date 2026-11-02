// textarea-plus: pictures and files that belong to a note.
//
// The note holds a reference, `![name](attachments/name.png)`, and the bytes
// live in a database of their own: a note's text goes into its link, and a
// picture in there would make every link too long to share. Kept as data URLs
// because that is what the page's policy already allows for images.
//
// A note carried somewhere else (a share link, a synced file) keeps the
// reference and shows it as text where the bytes have not arrived.

const DB_NAME = 'textarea-attachments'
const STORE = 'files'

/** The largest file kept, since all of it stays in this browser's storage. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024

/**
 * Where a file goes: its own name, cleaned, and numbered if the name is taken.
 * Pure, for the tests.
 *
 * @param {string} name
 * @param {(path: string) => boolean} taken
 */
export function attachmentPath(name, taken) {
  const clean =
    String(name)
      .replace(/[()[\]\\/\n\r:*?"<>|]/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^[. ]+|[. ]+$/g, '')
      .slice(-120) || 'file'
  const dot = clean.lastIndexOf('.')
  const stem = dot > 0 ? clean.slice(0, dot) : clean
  const ext = dot > 0 ? clean.slice(dot) : ''
  let path = `attachments/${clean}`
  for (let n = 2; taken(path); n++) path = `attachments/${stem} ${n}${ext}`
  return path
}

/** The text a note holds for a file: a picture draws, anything else links. */
export function attachmentToken(path, type) {
  const label = path.slice('attachments/'.length)
  return `${String(type).startsWith('image/') ? '!' : ''}[${label}](${path})`
}

function database() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, {keyPath: 'path'})
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('The attachments database could not be opened.'))
  })
}

async function inStore(mode, work) {
  const db = await database()
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, mode)
      const request = work(transaction.objectStore(STORE))
      let result
      request.onsuccess = () => {
        result = request.result
      }
      transaction.oncomplete = () => resolve(result)
      transaction.onerror = transaction.onabort = () => reject(transaction.error)
    })
  } finally {
    db.close()
  }
}

function readDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

/** Answers already read: the renderer asks synchronously, on every draw. */
const loaded = new Map()

/**
 * Keep a file.
 *
 * @param {File} file
 * @returns {Promise<string>} the token to write into the note
 * @throws when the file is over the limit or storage refuses it
 */
export async function addAttachment(file) {
  if (file.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(`${file.name} is over the ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB an attachment may be.`)
  }
  const existing = new Set(await inStore('readonly', (store) => store.getAllKeys()))
  const path = attachmentPath(file.name || 'pasted', (candidate) => existing.has(candidate))
  const url = await readDataUrl(file)
  await inStore('readwrite', (store) => store.put({path, url, type: file.type, size: file.size, added: Date.now()}))
  loaded.set(path, url)
  return attachmentToken(path, file.type)
}

/**
 * The data URL for a path, if it has been read. A first ask starts the read
 * and calls back when it lands, so the note can draw again.
 *
 * @param {string} path
 * @param {() => void} [ready]
 * @returns {string} '' until the bytes are here, or when there are none
 */
export function attachmentUrl(path, ready) {
  if (loaded.has(path)) return loaded.get(path)
  loaded.set(path, '')
  if (typeof indexedDB === 'undefined') return ''
  inStore('readonly', (store) => store.get(path))
    .then((record) => {
      if (!record) return
      loaded.set(path, record.url)
      ready?.()
    })
    .catch(() => {
      // No database, no picture: the reference stays as text.
    })
  return ''
}

/** Hand a stored file to the reader as a download. */
export async function downloadAttachment(path) {
  const record = await inStore('readonly', (store) => store.get(path))
  if (!record) return false
  const link = document.createElement('a')
  link.href = record.url
  link.download = path.slice('attachments/'.length)
  link.click()
  return true
}
