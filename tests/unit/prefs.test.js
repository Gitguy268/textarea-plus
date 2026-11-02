// The preferences: defaults, the stored contract, and the validators that
// stop a stray string in storage from deciding anything.

import assert from 'node:assert/strict'
import {test} from 'node:test'

const store = new Map()
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => store.set(key, String(value)),
}

const prefs = await import('../../lib/prefs.js')

test('every switch ships the way the original shipped it', () => {
  store.clear()
  const on = ['twoColumnsEnabled', 'fileLinksEnabled', 'wikiCreateEnabled', 'switcherEnabled', 'findEnabled', 'backupEnabled', 'backupMetadata', 'trashEnabled', 'wikilinksEnabled', 'tasksEnabled']
  const off = ['tasksDoneEnabled', 'statsPreferred', 'backlinksPreferred', 'backlinkMentionsEnabled', 'writingPreferred', 'selectionToolsEnabled', 'findCase', 'findWords', 'backupEncrypt', 'backupSingleFile', 'paletteEnabled']
  for (const name of on) assert.equal(prefs[name](), true, name)
  for (const name of off) assert.equal(prefs[name](), false, name)
  assert.equal(prefs.switcherShortcut(), 'k')
  assert.equal(prefs.switcherScope(), 'titles')
  assert.equal(prefs.trashKeep(), '30')
  assert.equal(prefs.librarySort(), 'updated')
  assert.equal(prefs.tagsEnabled(), true, 'new, and on: a tag drawn in colour changes no note')
  assert.equal(prefs.libraryView(), 'board')
  assert.deepEqual(prefs.savedFilters(), [])
  assert.equal(prefs.wordGoal(), 0)
  assert.equal(prefs.writingInstructions(), '')
  assert.equal(prefs.speechLanguage(), null, 'unchosen: the panel starts on the browser’s language')
  assert.equal(prefs.writingToolEnabled('improve'), true)
})

test('a switch writes the key and the value existing profiles already hold', () => {
  store.clear()
  prefs.setWikilinks(true)
  prefs.setTrashEnabled(false)
  prefs.setWritingTool('fix', false)
  prefs.setTrashKeep(90)
  assert.equal(store.get('textarea:wikilinks'), 'on')
  assert.equal(store.get('textarea:trash'), 'off')
  assert.equal(store.get('textarea:writing-tool-fix'), 'off')
  assert.equal(store.get('textarea:trash-keep'), '90')
  assert.equal(prefs.wikilinksEnabled(), true)
  assert.equal(prefs.trashEnabled(), false)
  assert.equal(prefs.writingToolEnabled('fix'), false)
})

test('a stray stored value falls back to the default, never flips it', () => {
  store.clear()
  store.set('textarea:wikilinks', 'yes')
  store.set('textarea:trash', 'no')
  store.set('textarea:tasks', 'yes')
  assert.equal(prefs.wikilinksEnabled(), true)
  assert.equal(prefs.tasksEnabled(), true)
  assert.equal(prefs.trashEnabled(), true)
  assert.equal(prefs.shortcutOf('z'), 'k')
  assert.equal(prefs.shortcutOf('p'), 'p')
  assert.equal(prefs.scopeOf('everything'), 'titles')
  assert.equal(prefs.keepDaysOf('1'), '30')
  assert.equal(prefs.keepDaysOf('7'), '7')
  assert.equal(prefs.sortOf('size'), 'updated')
  assert.equal(prefs.goalOf('-5'), 0)
  assert.equal(prefs.goalOf('abc'), 0)
  assert.equal(prefs.goalOf('500.9'), 500)
})

test('storage that throws costs the reader nothing but the memory', () => {
  const real = globalThis.localStorage
  globalThis.localStorage = {
    getItem() {
      throw new Error('denied')
    },
    setItem() {
      throw new Error('denied')
    },
  }
  try {
    assert.equal(prefs.findEnabled(), true)
    assert.equal(prefs.tasksEnabled(), true)
    assert.doesNotThrow(() => prefs.setFindEnabled(false))
  } finally {
    globalThis.localStorage = real
  }
})

test('saved filters come back as short names and queries, whatever was stored', () => {
  assert.deepEqual(prefs.filtersOf('not json'), [])
  assert.deepEqual(prefs.filtersOf('{"name":"x","query":"y"}'), [], 'a list or nothing')
  assert.deepEqual(
    prefs.filtersOf(JSON.stringify([{name: ' Work ', query: ' #work '}, {name: '', query: 'x'}, {name: 'x'}, null, 7])),
    [{name: 'Work', query: '#work'}],
  )
  assert.equal(prefs.filtersOf(JSON.stringify(Array.from({length: 30}, (_, i) => ({name: 'n' + i, query: 'q'})))).length, 20)
  assert.equal(prefs.filtersOf(JSON.stringify([{name: 'n'.repeat(99), query: 'q'.repeat(999)}]))[0].name.length, 40)

  store.clear()
  prefs.setSavedFilters([{name: 'Work', query: '#work', extra: true}])
  assert.equal(store.get('textarea:filters'), '[{"name":"Work","query":"#work"}]')
  assert.deepEqual(prefs.savedFilters(), [{name: 'Work', query: '#work'}])

  assert.equal(prefs.viewOf('timeline'), 'timeline')
  assert.equal(prefs.viewOf('anything else'), 'board')
})
