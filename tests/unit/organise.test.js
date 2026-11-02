// Organise by voice, without a model: the prompt it sends and the board it
// reads back from whatever a small model answers.

import assert from 'node:assert/strict'
import {test} from 'node:test'

import {boardNote, buildOrganisePrompt, ORGANISE_LIMIT, parseBoard, progress, setDone} from '../../lib/organise.js'

test('the prompt carries the spoken update, the notes and one worked example', () => {
  const {messages, truncated} = buildOrganisePrompt('Fence is done.', [{title: 'Garden', text: 'buy soil'}, {text: '  '}])
  assert.equal(truncated, false)
  assert.deepEqual(messages.map((m) => m.role), ['system', 'user', 'assistant', 'user'])
  assert.match(messages[0].content, /## Topic name/)
  assert.match(messages[3].content, /What I just said:\nFence is done\./)
  assert.match(messages[3].content, /Note "Garden":\nbuy soil/)
  assert.doesNotMatch(messages[3].content, /Note:\n\s*\n/, 'empty notes are skipped')
})

test('a long pile of notes is cut, and the cut is reported', () => {
  const {messages, truncated} = buildOrganisePrompt('', [{text: 'x'.repeat(ORGANISE_LIMIT * 2)}])
  assert.equal(truncated, true)
  assert.ok(messages[3].content.length <= ORGANISE_LIMIT)
})

test('the board reads the shape it asked for', () => {
  const board = parseBoard('# Organised today\n\n## Garden\n- [x] Fence posts\n- [ ] Buy soil\n\n## Thesis\n- ? Which dataset\n- Supervisor is away in May')
  assert.deepEqual(board.map((t) => t.topic), ['Garden', 'Thesis'])
  assert.deepEqual(board[0].items.map(({kind, done, text}) => [kind, done, text]), [['task', true, 'Fence posts'], ['task', false, 'Buy soil']])
  assert.deepEqual(board[1].items.map(({kind}) => kind), ['question', 'note'])
  assert.deepEqual(progress(board[0]), {done: 1, total: 2})
})

test('the board forgives a small model’s drift', () => {
  const board = parseBoard('Sure! Here you go:\n- loose item\n### Garden:\n* [X] soil\n1. which hedge?\n**Thesis**\n+ [ ] email')
  assert.deepEqual(board.map((t) => t.topic), ['Notes', 'Garden', 'Thesis'])
  assert.deepEqual(board[1].items.map(({kind, done}) => [kind, done]), [['task', true], ['question', false]])
  assert.equal(board[2].items[0].text, 'email')
  assert.deepEqual(parseBoard(''), [])
})

test('ticking a box writes back to exactly that line, and nothing else', () => {
  const md = '## A\n- [ ] one\n- two'
  const [{items}] = parseBoard(md)
  assert.equal(setDone(md, items[0].line, true), '## A\n- [x] one\n- two')
  assert.equal(setDone(md, items[1].line, true), md, 'a line with no box is left alone')
  assert.equal(setDone(md, 99, true), md)
})

test('the saved note is a dated title over clean topics', () => {
  const note = boardNote('Intro text\n## Garden\n* [X] soil\n- why?', new Date(2026, 9, 20))
  assert.match(note, /^# Organised .*2026\n\n## Garden\n- \[x\] soil\n- \? why\?\n$/)
  assert.deepEqual(parseBoard(note).map((t) => t.topic), ['Garden'])
})
