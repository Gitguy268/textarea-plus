// The filters of My documents, as far as a Node process can check them.
//
// lib/filter.js is text in, answers out, so every decision the panel makes
// about which notes to show can be asked here without a page: what a query
// means, which notes it keeps, what the tag chips count and which days the
// calendar lights.

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  activityByDay,
  dayOf,
  matchNote,
  parseQuery,
  recentDays,
  tagCounts,
  toggleToken,
} from '../../lib/filter.js'

/** A moment on a local calendar day, at noon so no clock change moves it. */
const at = (year, month, day) => new Date(year, month - 1, day, 12).getTime()

const notes = [
  {title: 'Groceries', text: '# Groceries\n\nmilk #home #shopping', created: at(2026, 10, 1), updated: at(2026, 10, 11)},
  {title: 'Taxes', text: '# Taxes\n\nforms #work/taxes', created: at(2026, 10, 9), updated: at(2026, 10, 9), pinned: true},
  {title: 'Old plan', text: '# Old plan\n\n#work', created: at(2026, 9, 1), updated: at(2026, 9, 1), archived: true},
]
const titles = (query) => notes.filter((note) => matchNote(note, parseQuery(query))).map((note) => note.title)

test('a query is tokens for the filters and one phrase for the rest', () => {
  assert.deepEqual(parseQuery('  Pasta  and PESTO #Home on:2026-10-11 is:pinned is:archived '), {
    phrase: 'pasta and pesto',
    tags: ['home'],
    day: '2026-10-11',
    pinned: true,
    archived: true,
  })
  // What only looks like a filter is a word to search for.
  assert.deepEqual(parseQuery('#1 on:tuesday is:starred').phrase, '#1 on:tuesday is:starred')
  assert.deepEqual(parseQuery(undefined), {phrase: '', tags: [], day: null, pinned: false, archived: false})
})

test('an archived note is in no list but the one that asks for it', () => {
  assert.deepEqual(titles(''), ['Groceries', 'Taxes'])
  assert.deepEqual(titles('is:archived'), ['Old plan'])
  assert.deepEqual(titles('plan'), [], 'a search does not reach into the archive')
})

test('tags, pins, days and the phrase each narrow the list', () => {
  assert.deepEqual(titles('#home'), ['Groceries'])
  assert.deepEqual(titles('#work'), ['Taxes'], 'a tag answers for the tags nested under it')
  assert.deepEqual(titles('#work/taxes'), ['Taxes'])
  assert.deepEqual(titles('#home #work'), [], 'two tags must both be there')
  assert.deepEqual(titles('is:pinned'), ['Taxes'])
  assert.deepEqual(titles('on:2026-10-01'), ['Groceries'], 'the day a note was made')
  assert.deepEqual(titles('on:2026-10-11'), ['Groceries'], 'and the day it was last edited')
  assert.deepEqual(titles('FORMS'), ['Taxes'], 'the phrase is found in the text, whatever its case')
  assert.deepEqual(titles('groceries #home'), ['Groceries'])
})

test('a chip adds its token, takes it back, and a day replaces a day', () => {
  assert.equal(toggleToken('', '#home'), '#home')
  assert.equal(toggleToken('milk #Home', '#home'), 'milk')
  assert.equal(toggleToken('milk on:2026-10-01', 'on:2026-10-02'), 'milk on:2026-10-02')
  assert.equal(toggleToken('on:2026-10-02', 'on:2026-10-02'), '')
})

test('the tag chips count notes, not mentions, and leave the archive out', () => {
  const counted = tagCounts([
    ...notes,
    {text: '#home again #home', created: 0, updated: 0},
    {text: 'no tags here', created: 0, updated: 0},
  ])
  assert.deepEqual(counted, [
    ['home', 2],
    ['shopping', 1],
    ['work/taxes', 1],
  ])
})

test('the calendar counts a note on the day it was made and the day it was last edited', () => {
  const days = activityByDay(notes)
  assert.equal(days.get('2026-10-01'), 1)
  assert.equal(days.get('2026-10-11'), 1)
  assert.equal(days.get('2026-10-09'), 1, 'made and edited the same day is one note that day')
  assert.equal(days.get('2026-09-01'), 1, 'an archived note was still written')
  assert.equal(days.size, 4)
  assert.equal(dayOf(at(2026, 1, 5)), '2026-01-05')
})

test('the calendar is whole weeks from a Monday, and stops at today', () => {
  // 11 October 2026 is a Sunday: twelve whole weeks, the last one complete.
  const sunday = recentDays(at(2026, 10, 11))
  assert.equal(sunday.length, 84)
  assert.equal(sunday[0], '2026-07-20')
  assert.equal(new Date(2026, 6, 20).getDay(), 1, 'which is a Monday')
  assert.equal(sunday.at(-1), '2026-10-11')

  // A Wednesday leaves the last column three days tall.
  const wednesday = recentDays(at(2026, 10, 7))
  assert.equal(wednesday.length, 77 + 3)
  assert.equal(wednesday.at(-1), '2026-10-07')
})
