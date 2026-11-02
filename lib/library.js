// The document library: every note this browser has held, in IndexedDB.
//
// Until now a note lived in the URL and nowhere else, which is a good property
// and a bad one. The link is the only copy, so a note is lost when the tab
// closes without the link being kept, and a note large enough to hit the URL
// length limit has no link at all. The library is the second copy that fixes
// both.
//
// Two rules keep it from turning into a sync service or a surprise:
//
//   Nothing leaves the browser. There is no network call in this file, and the
//   database is per-origin, so the library is exactly as private as the profile
//   holding it.
//
//   Every function degrades to a no-op when storage is unavailable. Private
//   windows in some browsers refuse IndexedDB outright, and an editor that stops
//   accepting text because it cannot keep a backup would be a far worse bug than
//   a missing library. Callers get an empty list and an exception to ignore.

const DB_NAME = 'textarea'
const DB_VERSION = 2
const STORE = 'documents'
// The trash is the second store: the same records, keyed the same way, plus
// the moment they were deleted. It rides along in the same database so the
// move between the two is one transaction - a note cannot be in neither.
const TRASH_STORE = 'trash'
const ACTIVE_KEY = 'textarea:active-document'

/**
 * @typedef {object} LibraryEntry
 * @property {string} id
 * @property {string} title      the document title, or "Untitled note"
 * @property {string} text
 * @property {string} [style]    the inline style the author added to <article>
 * @property {string} [hash]     the URL hash at the time it was stored
 * @property {number} created    epoch milliseconds
 * @property {number} updated    epoch milliseconds, and the sort key
 * @property {number} words
 * @property {boolean} [pinned]   kept at the top of the list; absent when not
 * @property {boolean} [archived] kept out of the list; absent when not
 */

let dbPromise = null

/** The open connection itself, for the one write that cannot wait for a promise. */
let openDb = null

/**
 * Whether this browser will give us a database at all.
 *
 * The constructor is checked as well as the global: on an insecure origin
 * `indexedDB` exists but opening it throws a SecurityError, which is the same
 * outcome for our purposes.
 */
export function isAvailable() {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null
  } catch {
    return false
  }
}

/** A promise for the open database, opened once and then reused. */
export function database() {
  if (!isAvailable()) return Promise.reject(new Error('This browser has no IndexedDB.'))

  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION)

      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, {keyPath: 'id'})
          // The library is read newest first, so the sort key is indexed rather
          // than sorted in JavaScript over every record.
          store.createIndex('updated', 'updated')
        }
        // Version 1 never had a trash; an upgrade adds the store without
        // touching the notes already held. No index: the trash is bounded by
        // its keep days and always read whole, so a sort in JavaScript beats a
        // schema nothing else queries.
        if (!db.objectStoreNames.contains(TRASH_STORE)) {
          db.createObjectStore(TRASH_STORE, {keyPath: 'id'})
        }
      }

      request.onsuccess = () => {
        const db = request.result
        // Another tab opening a newer version would otherwise leave this one
        // holding a connection that blocks its upgrade forever.
        db.onversionchange = () => {
          db.close()
          dbPromise = null
          openDb = null
        }
        openDb = db
        resolve(db)
      }

      request.onerror = () => {
        dbPromise = null
        reject(request.error ?? new Error('The document library could not be opened.'))
      }

      // A blocked upgrade means another tab is holding the old version open.
      request.onblocked = () => {
        dbPromise = null
        reject(new Error('The document library is in use in another tab.'))
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
 * Run a callback inside a transaction over one or more stores and resolve once
 * the transaction itself has committed.
 *
 * Waiting for the transaction rather than for the last request is what makes a
 * write durable before the next line of code trusts it: a request can succeed
 * and the transaction still abort afterwards. With two stores named - the
 * trash move and the restore - it is also what makes them atomic: the record
 * lands in one and leaves the other, or neither happens at all.
 *
 * @param {string[]} names  the stores the transaction spans
 * @param {IDBTransactionMode} mode
 * @param {(…stores: IDBObjectStore[]) => any} callback
 */
async function runTransaction(names, mode, callback) {
  const db = await database()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(names, mode)
    let result
    transaction.oncomplete = () => resolve(result)
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error ?? new Error('The transaction was aborted.'))
    Promise.resolve(callback(...names.map((name) => transaction.objectStore(name))))
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

/** Run a callback inside a transaction over the documents store. */
async function inStore(mode, callback) {
  return runTransaction([STORE], mode, (store) => callback(store))
}

/** Run a callback inside a transaction over the trash store. */
async function inTrash(mode, callback) {
  return runTransaction([TRASH_STORE], mode, (store) => callback(store))
}

/**
 * Every note, newest edit first.
 *
 * @returns {Promise<LibraryEntry[]>} empty when storage is unavailable
 */
export async function listDocuments() {
  if (!isAvailable()) return []
  try {
    const entries = await inStore('readonly', (store) => fromRequest(store.getAll()))
    return (entries ?? []).sort((a, b) => b.updated - a.updated)
  } catch {
    return []
  }
}

/**
 * One note, or null.
 *
 * @param {string} id
 * @returns {Promise<LibraryEntry | null>}
 */
export async function getDocument(id) {
  if (!isAvailable() || !id) return null
  try {
    return (await inStore('readonly', (store) => fromRequest(store.get(id)))) ?? null
  } catch {
    return null
  }
}

/**
 * Insert or replace a note.
 *
 * @param {Partial<LibraryEntry> & {id?: string, text: string}} entry
 * @returns {Promise<LibraryEntry | null>} null when storage is unavailable
 */
export async function putDocument(entry) {
  if (!isAvailable()) return null

  const now = Date.now()
  const existing = await getDocument(entry.id)

  const record = {
    id: entry.id ?? newId(),
    title: entry.title || 'Untitled note',
    text: entry.text ?? '',
    style: entry.style ?? null,
    hash: entry.hash ?? '',
    created: existing?.created ?? entry.created ?? now,
    // Folder sync passes the timestamp the file claims, so a note edited in
    // another editor keeps that moment instead of reading as "just now" and
    // winning the next comparison it did not actually win.
    updated: entry.updated ?? now,
    words: entry.words ?? 0,
  }
  // Pin and archive are the reader's marks on the row rather than part of the
  // note. The autosave that builds this record never mentions them, so they
  // are carried over from the row it replaces - or every keystroke would
  // unpin the note being typed in.
  for (const flag of FLAGS) {
    if (entry[flag] ?? existing?.[flag]) record[flag] = true
  }

  try {
    await inStore('readwrite', (store) => fromRequest(store.put(record)))
  } catch {
    return null
  }

  return record
}

/** The marks a reader can put on a row. */
const FLAGS = ['pinned', 'archived']

/**
 * Pin or archive a note, or take the mark back off.
 *
 * Read and written in one transaction, and written as the row it was with
 * only the mark changed: `updated` in particular stays, because pinning a
 * note is not editing it. Through putDocument() the note would jump to the
 * top of "last edited", light up today on the calendar and be rewritten in
 * the synced folder, for a change to none of its text.
 *
 * @param {string} id
 * @param {{pinned?: boolean, archived?: boolean}} flags
 * @returns {Promise<LibraryEntry | null>} the row as it now is, or null
 */
export async function setDocumentFlags(id, flags) {
  if (!isAvailable() || !id) return null
  try {
    return await inStore('readwrite', async (store) => {
      const record = await fromRequest(store.get(id))
      if (!record) return null
      for (const flag of FLAGS) {
        if (!(flag in flags)) continue
        if (flags[flag]) record[flag] = true
        else delete record[flag]
      }
      await fromRequest(store.put(record))
      return record
    })
  } catch {
    return null
  }
}

/**
 * Start writing a note this instant, for a page that is closing.
 *
 * putDocument() reads the row before it writes it, and a closing page never
 * comes back from that first await - the write is never issued. This issues
 * it in the same turn of the event loop, which is the only kind of write the
 * browser still finishes after the page is gone. The caller supplies the
 * whole record, `created` included, because there is no time to look it up.
 *
 * @param {LibraryEntry} record
 * @returns {boolean} false when no connection is open yet, or the write was refused
 */
export function putDocumentNow(record) {
  if (!openDb) return false
  try {
    const transaction = openDb.transaction(STORE, 'readwrite')
    transaction.objectStore(STORE).put(record)
    // Without this the commit waits for the put's success event to come back
    // to a page that will not be there to receive it, and the browser aborts
    // the transaction instead. Asked for now, the commit travels with the put.
    transaction.commit?.()
    return true
  } catch {
    return false
  }
}

/**
 * Forget one note.
 *
 * @param {string} id
 * @returns {Promise<boolean>} false when nothing was stored or storage is closed
 */
export async function deleteDocument(id) {
  if (!isAvailable() || !id) return false
  try {
    await inStore('readwrite', (store) => fromRequest(store.delete(id)))
    return true
  } catch {
    return false
  }
}

/**
 * Move one note into the trash: a copy with the deletion time stamped on it
 * goes into the trash store, and the note leaves the library, in one
 * transaction over both. Half a move - a note in neither store, or in both -
 * is the failure this exists to make impossible.
 *
 * @param {string} id
 * @returns {Promise<boolean>} false when nothing was stored or storage is closed
 */
export async function moveToTrash(id) {
  if (!isAvailable() || !id) return false
  try {
    const record = await getDocument(id)
    if (!record) return false
    await runTransaction([STORE, TRASH_STORE], 'readwrite', async (documents, trash) => {
      await fromRequest(trash.put({...record, deletedAt: Date.now()}))
      await fromRequest(documents.delete(id))
    })
    return true
  } catch {
    return false
  }
}

/**
 * Put a trashed note back: same id, same text, same timestamps, so the note
 * returns as itself rather than as a new one - folder sync's file comes back
 * under its own name, and links to it find it.
 *
 * @param {string} id
 * @returns {Promise<boolean>} false when it is not in the trash or storage is closed
 */
export async function restoreFromTrash(id) {
  if (!isAvailable() || !id) return false
  try {
    const trashed = await inTrash('readonly', (store) => fromRequest(store.get(id)))
    if (!trashed) return false
    // The deletion stamp is the trash's bookkeeping, not part of the note: a
    // restored note reads as itself again in every field.
    const record = {...trashed}
    delete record.deletedAt
    await runTransaction([STORE, TRASH_STORE], 'readwrite', async (documents, trash) => {
      await fromRequest(documents.put(record))
      await fromRequest(trash.delete(id))
    })
    return true
  } catch {
    return false
  }
}

/**
 * Every trashed note, newest deletion first.
 *
 * @returns {Promise<Array<LibraryEntry & {deletedAt: number}>>} empty when storage is unavailable
 */
export async function listTrash() {
  if (!isAvailable()) return []
  try {
    const entries = await inTrash('readonly', (store) => fromRequest(store.getAll()))
    return (entries ?? []).sort((a, b) => b.deletedAt - a.deletedAt)
  } catch {
    return []
  }
}

/**
 * One note out of the trash, for good.
 *
 * @param {string} id
 * @returns {Promise<boolean>} false when storage is closed
 */
export async function deleteForever(id) {
  if (!isAvailable() || !id) return false
  try {
    await inTrash('readwrite', (store) => fromRequest(store.delete(id)))
    return true
  } catch {
    return false
  }
}

/** Empty the trash. @returns {Promise<boolean>} false when storage is closed */
export async function emptyTrash() {
  if (!isAvailable()) return false
  try {
    await inTrash('readwrite', (store) => fromRequest(store.clear()))
    return true
  } catch {
    return false
  }
}

/**
 * Take out everything older than `keepMs`, on the way in - the trash is read
 * when the panel opens, so a purge there is all the housekeeping it needs.
 *
 * @param {number} keepMs  how long a note earns in the trash
 * @returns {Promise<number>} how many went, 0 when storage is closed
 */
export async function purgeTrash(keepMs) {
  if (!isAvailable()) return 0
  try {
    return await inTrash('readwrite', async (store) => {
      const cutoff = Date.now() - keepMs
      const entries = (await fromRequest(store.getAll())) ?? []
      let purged = 0
      for (const entry of entries) {
        if (entry.deletedAt < cutoff) {
          await fromRequest(store.delete(entry.id))
          purged++
        }
      }
      return purged
    })
  } catch {
    return 0
  }
}

/** How many notes are stored. */
export async function countDocuments() {
  if (!isAvailable()) return 0
  try {
    return await inStore('readonly', (store) => fromRequest(store.count()))
  } catch {
    return 0
  }
}

/**
 * The note currently being edited.
 *
 * Held in localStorage rather than in the database because it is one value read
 * on every keystroke's worth of autosave, and because it has to mean the same
 * thing before the database has opened.
 */
export function activeDocumentId() {
  try {
    return localStorage.getItem(ACTIVE_KEY)
  } catch {
    return null
  }
}

export function setActiveDocumentId(id) {
  try {
    if (id) localStorage.setItem(ACTIVE_KEY, id)
    else localStorage.removeItem(ACTIVE_KEY)
  } catch {
    // Storage refused. The library still works, it just reopens the most recent
    // note next time instead of the one that was on screen.
  }
}

/** A fresh identifier. `randomUUID` needs a secure context, so there is a fallback. */
export function newId() {
  if (crypto?.randomUUID) return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
