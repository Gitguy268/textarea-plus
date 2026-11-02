import assert from 'node:assert/strict'
import {test} from 'node:test'

import {SLASH_ITEMS, matchSlash, slashAt, snippetParts} from '../../lib/slash.js'

test('a slash opens at the start of a line or after a space, and nowhere else', () => {
  assert.deepEqual(slashAt('/', 1), {start: 0, query: ''})
  assert.deepEqual(slashAt('hello /ta', 9), {start: 6, query: 'ta'})
  assert.deepEqual(slashAt('one\n/to', 7), {start: 4, query: 'to'})
  for (const text of ['1/2', 'http://x', 'a/b/c', 'and/or', '/ta/b', 'x /!']) assert.equal(slashAt(text, text.length), null, text)
})

test('inside a code fence a slash is a slash', () => {
  const open = '```\n/ta'
  assert.equal(slashAt(open, open.length), null)
  const closed = '```\ncode\n```\n/ta'
  assert.equal(slashAt(closed, closed.length)?.query, 'ta')
})

test('rows match their label first, then their other names', () => {
  assert.equal(matchSlash('').length, SLASH_ITEMS.length)
  assert.equal(matchSlash('tab')[0].id, 'table')
  assert.equal(matchSlash('wikilink')[0].id, 'page')
  assert.deepEqual(matchSlash('zzz'), [])
})

test('every snippet is plain Markdown with the caret placed', () => {
  assert.deepEqual(snippetParts('# |'), {text: '# ', caret: 2})
  assert.deepEqual(snippetParts('[[|]]'), {text: '[[]]', caret: 2})
  assert.deepEqual(snippetParts('```\n|\n```'), {text: '```\n\n```', caret: 4})
  const table = SLASH_ITEMS.find((item) => item.id === 'table').snippet
  assert.equal(snippetParts(table).text, table, 'a table keeps its pipes')
})
