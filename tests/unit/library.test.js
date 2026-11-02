import assert from 'node:assert/strict'
import test from 'node:test'

import {
  countDocuments,
  deleteDocument,
  deleteForever,
  emptyTrash,
  getDocument,
  isAvailable,
  listDocuments,
  listTrash,
  moveToTrash,
  putDocument,
  purgeTrash,
  restoreFromTrash,
  setDocumentFlags,
} from '../../lib/library.js'

// The library's own rule, stated at the top of the file: every function
// degrades to a no-op when storage is unavailable, because an editor that
// stops accepting text because it cannot keep a note would be a far worse bug
// than a missing library. Node has no IndexedDB, which is the honest way to
// ask: this is the private-window case, not a mock of it.
test('every library and trash call degrades to a no-op without storage', async () => {
  assert.equal(isAvailable(), false, 'Node is the browser without IndexedDB')

  assert.deepEqual(await listDocuments(), [])
  assert.equal(await countDocuments(), 0)
  assert.equal(await getDocument('note-1'), null)
  assert.equal(await putDocument({text: 'hello'}), null)
  assert.equal(await deleteDocument('note-1'), false)
  assert.equal(await setDocumentFlags('note-1', {pinned: true}), null)

  assert.deepEqual(await listTrash(), [])
  assert.equal(await moveToTrash('note-1'), false)
  assert.equal(await restoreFromTrash('note-1'), false)
  assert.equal(await deleteForever('note-1'), false)
  assert.equal(await emptyTrash(), false)
  assert.equal(await purgeTrash(86_400_000), 0, 'nothing purged, nothing thrown')
})

test('the documents panel orders notes three ways without touching the list it was given', async () => {
  const {sortNotes} = await import('../../lib/library-panel.js')
  const stored = [
    {title: 'banana', created: 3},
    {title: 'Apple', created: 1},
    {title: 'cherry 10', created: 2},
    {title: 'cherry 9', created: 0},
  ]
  const titles = (entries) => entries.map((entry) => entry.title)
  assert.equal(sortNotes(stored, 'updated'), stored, 'the stored order is handed straight back')
  assert.equal(sortNotes(stored, 'nonsense'), stored)
  assert.deepEqual(titles(sortNotes(stored, 'created')), ['banana', 'cherry 10', 'Apple', 'cherry 9'])
  // Case does not sort capitals first, and 9 comes before 10.
  assert.deepEqual(titles(sortNotes(stored, 'title')), ['Apple', 'banana', 'cherry 9', 'cherry 10'])
  assert.deepEqual(titles(stored), ['banana', 'Apple', 'cherry 10', 'cherry 9'])
})

test('pinned notes come first, each half in the order that was asked for', async () => {
  const {sortNotes} = await import('../../lib/library-panel.js')
  const stored = [
    {title: 'banana', created: 3},
    {title: 'Apple', created: 1, pinned: true},
    {title: 'cherry', created: 2},
    {title: 'date', created: 0, pinned: true},
  ]
  const titles = (entries) => entries.map((entry) => entry.title)
  assert.deepEqual(titles(sortNotes(stored, 'updated')), ['Apple', 'date', 'banana', 'cherry'])
  assert.deepEqual(titles(sortNotes(stored, 'created')), ['Apple', 'date', 'banana', 'cherry'])
  assert.deepEqual(titles(sortNotes(stored, 'title')), ['Apple', 'date', 'banana', 'cherry'])
  assert.deepEqual(titles(stored), ['banana', 'Apple', 'cherry', 'date'], 'the list it was given is untouched')
})
