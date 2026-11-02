// textarea-plus: writing to a note from outside the editor.
//
// A database cell and a task row change a line of a note that may not be on
// screen. Everything that does goes through here, one write at a time: two
// edits of one note in quick succession would otherwise both read the row
// before either wrote it, and the first would be lost.

import {titleOf} from './front-matter.js'
import {getDocument, putDocument} from './library.js'
import {notify} from './notify.js'
import {article, documentId, editor, save, setPendingWrites} from './note.js'
import {emit} from './signals.js'
import {countStats} from './stats.js'
import {scheduleSync} from './sync.js'

let writes = Promise.resolve()
setPendingWrites(() => writes)

/**
 * Change a note's text, wherever it is.
 *
 * @param {string} id
 * @param {(text: string) => string} change
 */
export function writeNote(id, change) {
  writes = writes.then(async () => {
    // The note on screen belongs to the editor, whose next save would put its
    // own copy back over a write to the library.
    if (id === documentId()) {
      const text = change(article.textContent)
      if (text === article.textContent) return
      editor.replace(text)
      await save()
      return
    }
    const row = await getDocument(id)
    if (!row) return
    const text = change(row.text)
    if (text === row.text) return
    // The hash goes: it is the old text, and a return to that address must not
    // claim this row and write the old text back.
    const written = await putDocument({
      ...row,
      text,
      title: titleOf(text),
      words: countStats(text).words,
      hash: '',
      updated: Date.now(),
    })
    if (!written) {
      notify('That change could not be saved: the browser\u2019s storage is full or blocked.', {error: true, duration: 6000})
      return
    }
    scheduleSync()
    emit('note')
  })
  return writes
}

/** A new note, from outside the editor. */
export async function addNote(text) {
  const made = await putDocument({text, title: titleOf(text), words: countStats(text).words})
  if (made) {
    scheduleSync()
    emit('note')
  }
  return made
}
