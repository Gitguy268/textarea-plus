import assert from 'node:assert/strict'
import {test} from 'node:test'

import {
  cleanFolder,
  closeTab,
  dayText,
  dayTitle,
  findDay,
  folderOf,
  folderTree,
  liveTabs,
  openTab,
  setFolder,
  tagTree,
  viewEntries,
  viewLabel,
  viewOf,
} from '../../lib/views.js'

const note = (text, extra = {}) => ({id: text.slice(0, 12), updated: 1, text, ...extra})

const library = [
  note('buy milk #home'),
  note('call the plumber'),
  note('# Trip to Lisbon\n\n- [ ] book the tram'),
  note('# Roadmap\n#project\n- [x] shipped'),
  note('# Standup\n#meeting/weekly'),
  note('# How we deploy\n#wiki'),
  note('a loose idea #project'),
  note('# Filed\n#inbox'),
  note('# Old\n#project', {archived: true}),
  note('  \n'),
]
const titles = (entries) => entries.map((entry) => entry.text.split('\n')[0])

test('the day is the reader’s own calendar day, as textarea-cli writes it', () => {
  // 00:30 on the 26th in a timezone east of Greenwich is still the 25th in
  // UTC; the day's note must be the 26th's.
  const lateNight = new Date(2026, 9, 26, 0, 30)
  assert.equal(dayTitle(lateNight), '2026-10-26')
  assert.equal(dayText(new Date(2026, 0, 5, 12)), '# 2026-01-05\n')
})

test('the day’s note is found by its heading, not made twice', () => {
  const day = new Date(2026, 9, 26, 9)
  const entries = [note('# Other'), note('# 2026-10-26\n\n- 09:00 walked the dog'), note('# 2026-10-25')]
  assert.equal(findDay(entries, day), entries[1])
  assert.equal(findDay([note('2026-10-26 without a heading')], day), null)
  assert.equal(findDay([note('# 2026-10-26', {archived: true})], day)?.text, '# 2026-10-26')
})

test('Inbox holds untitled captures and #inbox, until a heading or a view’s tag files them, and no blank page', () => {
  assert.deepEqual(titles(viewEntries(library, 'inbox')), ['buy milk #home', 'call the plumber', '# Filed'])
})

// A #tag on a heading line is part of the heading, to the renderer and so to
// every view - the tags here sit on the line below.
test('a view with a tag lists its tag, nested tags included, and never the archive', () => {
  assert.deepEqual(titles(viewEntries(library, 'projects')), ['# Roadmap', 'a loose idea #project'])
  assert.deepEqual(titles(viewEntries(library, 'meetings')), ['# Standup'])
  assert.deepEqual(titles(viewEntries(library, 'wiki')), ['# How we deploy'])
})

test('Tasks lists the notes with an open task; Notes lists everything live', () => {
  assert.deepEqual(titles(viewEntries(library, 'tasks')), ['# Trip to Lisbon'])
  assert.equal(viewEntries(library, 'notes').length, library.length - 1, 'every note but the archived one')
  assert.deepEqual(viewEntries(library, 'today'), [])
})

test('a stored view that is not a view is Notes', () => {
  assert.equal(viewOf('inbox'), 'inbox')
  assert.equal(viewOf('<script>'), 'notes')
  assert.equal(viewOf(null), 'notes')
})

test('a tab opens after the current one, and an open note keeps its place', () => {
  assert.deepEqual(openTab([], 'a'), ['a'])
  assert.deepEqual(openTab(['a', 'b', 'c'], 'x', 'a'), ['a', 'x', 'b', 'c'])
  assert.deepEqual(openTab(['a', 'b'], 'x', 'gone'), ['a', 'b', 'x'])
  const tabs = ['a', 'b']
  assert.equal(openTab(tabs, 'b', 'a'), tabs)
})

test('closing the tab on screen hands over to its right, or its left at the end', () => {
  assert.deepEqual(closeTab(['a', 'b', 'c'], 'b', 'b'), {tabs: ['a', 'c'], next: 'c'})
  assert.deepEqual(closeTab(['a', 'b', 'c'], 'c', 'c'), {tabs: ['a', 'b'], next: 'b'})
  assert.deepEqual(closeTab(['a'], 'a', 'a'), {tabs: [], next: null})
  // A tab in the background goes without moving the screen.
  assert.deepEqual(closeTab(['a', 'b'], 'a', 'b'), {tabs: ['b'], next: null})
  assert.deepEqual(closeTab(['a'], 'zz', 'a'), {tabs: ['a'], next: null})
})

test('tabs read back from storage name only notes that still exist, once each', () => {
  const ids = new Set(['a', 'b', 'c'])
  assert.deepEqual(liveTabs(['a', 'gone', 'b', 'a', 7], ids, 'c'), ['a', 'b', 'c'])
  assert.deepEqual(liveTabs('{"not": "a list"}', ids, 'a'), ['a'])
  assert.deepEqual(liveTabs(null, ids, null), [])
})

test('tags fold into a tree on the slash, and a parent counts what is under it', () => {
  const tree = tagTree([note('a #work/taxes'), note('b #work/taxes/2026'), note('c #work'), note('d #home')])
  assert.deepEqual(tree.map((tag) => tag.name), ['home', 'work'])
  const work = tree.find((tag) => tag.name === 'work')
  assert.equal(work.count, 3)
  assert.equal(tagTree([note('both #work and #work/taxes')])[0].count, 1, 'one note counts once')
  assert.equal(work.children[0].path, 'work/taxes')
  assert.equal(work.children[0].children[0].path, 'work/taxes/2026')
})

test('a tag or folder view lists what is inside it, nested ones included', () => {
  const notes = [note('a #work/taxes'), note('b\n\nfolder:: Work/Plans\n'), note('c\n\nfolder:: Work\n'), note('d\nfolder:: Workshop\n')]
  assert.deepEqual(titles(viewEntries(notes, 'tag:work')), ['a #work/taxes'])
  assert.deepEqual(titles(viewEntries(notes, 'folder:Work')), ['b', 'c'])
  assert.deepEqual(titles(viewEntries(notes, 'folder:Work/Plans')), ['b'])
  assert.equal(viewLabel('tag:work/taxes'), '#work/taxes')
  assert.equal(viewLabel('folder:Work/Plans'), 'Work/Plans')
  assert.equal(viewOf('folder:Work'), 'folder:Work')
  assert.equal(viewOf('folder:'), 'notes')
})

test('a note’s folder is one line of its text, moved, added and taken out cleanly', () => {
  assert.equal(folderOf('# A\n\nfolder:: Work/Plans\nmore'), 'Work/Plans')
  assert.equal(folderOf('# A\n\nnot a folder:: here'), '')
  assert.equal(cleanFolder(' /Work // Plans/ \n'), 'Work/Plans')
  assert.equal(setFolder('# A\n\nbody', 'Work'), '# A\n\nbody\n\nfolder:: Work\n')
  assert.equal(setFolder('# A\n\nfolder:: Work\nbody', 'Home/x'), '# A\n\nfolder:: Home/x\nbody')
  assert.equal(setFolder('# A\n\nbody\n\nfolder:: Work\n', ''), '# A\n\nbody\n')
  assert.equal(setFolder('# A', ''), '# A')
  assert.equal(setFolder('', 'Work'), 'folder:: Work\n')
  // A path holding $& must land as written, not as a replacement pattern.
  assert.equal(folderOf(setFolder('folder:: a', '$&b')), '$&b')
})

test('a filed capture leaves the Inbox; the folder tree counts live notes', () => {
  const notes = [note('idea\n\nfolder:: Work/Plans\n'), note('other\nfolder:: Work\n', {archived: false}), note('old\nfolder:: Gone\n', {archived: true})]
  assert.deepEqual(viewEntries(notes, 'inbox'), [])
  const tree = folderTree(notes)
  assert.deepEqual(tree.map((f) => [f.name, f.count]), [['Work', 2]])
  assert.deepEqual(tree[0].children.map((f) => [f.path, f.count]), [['Work/Plans', 1]])
})
