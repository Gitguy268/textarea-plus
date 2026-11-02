// The filters My documents understands, as text in its search box.
//
// Every filter is a token in the one query: `#tag`, `on:2026-10-11`,
// `is:pinned`, `is:archived`, and whatever is left over is the phrase to
// find. A tag chip, a day on the calendar and a saved filter are then all the
// same thing - a string put into the search box - and the box always says
// what the list is showing. Text in, answers out: no page, so the decisions
// are tested under Node.

import {tagsIn} from './markdown.js'

/** The local calendar day of a moment, as YYYY-MM-DD. */
export function dayOf(ms) {
  const date = new Date(ms)
  const two = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`
}

/**
 * A note's tags, remembered for as long as the note is not written again.
 *
 * The panel asks on every keystroke of a search, of every note, and reading
 * tags means walking the note the way the renderer does: 25ms a keystroke
 * over five hundred notes when measured, and a fraction of that once asked.
 * `updated` moves whenever the text does, so the pair names one text.
 */
const known = new Map()

export function tagsOf(entry) {
  // A row with no id is not from the library: nothing to remember it by.
  if (entry.id === undefined) return tagsIn(entry.text ?? '')
  const key = `${entry.id}:${entry.updated}`
  if (!known.has(key)) known.set(key, tagsIn(entry.text ?? ''))
  return known.get(key)
}

/**
 * A query, taken apart.
 *
 * @param {string} query
 * @returns {{phrase: string, tags: string[], day: string | null, pinned: boolean, archived: boolean}}
 */
export function parseQuery(query) {
  const parsed = {phrase: '', tags: [], day: null, pinned: false, archived: false}
  const words = []
  for (const token of String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean)) {
    if (/^#\p{L}/u.test(token)) parsed.tags.push(token.slice(1))
    else if (/^on:\d{4}-\d{2}-\d{2}$/.test(token)) parsed.day = token.slice(3)
    else if (token === 'is:pinned') parsed.pinned = true
    else if (token === 'is:archived') parsed.archived = true
    else words.push(token)
  }
  // What is left is one phrase, as the search box always read it.
  parsed.phrase = words.join(' ')
  return parsed
}

/**
 * The query with one token switched: added when absent, removed when there.
 * A day replaces whatever day was asked for, since a note list has one.
 *
 * @param {string} query
 * @param {string} token  `#tag`, `on:YYYY-MM-DD`, `is:pinned` or `is:archived`
 */
export function toggleToken(query, token) {
  const wanted = token.toLowerCase()
  const tokens = String(query ?? '').split(/\s+/).filter(Boolean)
  const had = tokens.some((t) => t.toLowerCase() === wanted)
  const kept = tokens.filter(
    (t) => t.toLowerCase() !== wanted && !(wanted.startsWith('on:') && t.toLowerCase().startsWith('on:')),
  )
  return (had ? kept : [...kept, token]).join(' ')
}

/**
 * Whether a note belongs in the list a query asks for.
 *
 * An archived note is out of every list but the one that asks for it, which
 * is the whole of what archiving means. A tag also answers for the tags
 * nested under it: `#work` finds `#work/taxes`.
 *
 * @param {{title?: string, text?: string, created?: number, updated?: number, pinned?: boolean, archived?: boolean}} entry
 * @param {ReturnType<typeof parseQuery>} query  parsed once, asked of every note
 */
export function matchNote(entry, query) {
  if (Boolean(entry.archived) !== query.archived) return false
  if (query.pinned && !entry.pinned) return false
  if (query.day && dayOf(entry.created) !== query.day && dayOf(entry.updated) !== query.day) return false
  if (query.tags.length) {
    const tags = tagsOf(entry)
    if (!query.tags.every((want) => tags.some((tag) => tag === want || tag.startsWith(want + '/')))) return false
  }
  if (!query.phrase) return true
  return (
    String(entry.title ?? '').toLowerCase().includes(query.phrase) ||
    String(entry.text ?? '').toLowerCase().includes(query.phrase)
  )
}

/**
 * Every tag in the library with the number of notes that carry it, the most
 * used first and the alphabet settling ties. Archived notes are left out, as
 * they are from the list the chips filter.
 *
 * @param {Array<{text?: string, archived?: boolean}>} entries
 * @returns {Array<[string, number]>}
 */
export function tagCounts(entries) {
  const counts = new Map()
  for (const entry of entries) {
    if (entry.archived) continue
    for (const tag of new Set(tagsOf(entry))) counts.set(tag, (counts.get(tag) ?? 0) + 1)
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
}

/**
 * How many notes were written or last edited on each day.
 *
 * The library keeps two moments per note and no history between them, so
 * that is what the calendar can honestly show: a note counts on the day it
 * was made and on the day it was last touched, once if they are the same.
 *
 * @param {Array<{created?: number, updated?: number}>} entries
 * @returns {Map<string, number>} by YYYY-MM-DD
 */
export function activityByDay(entries) {
  const days = new Map()
  for (const entry of entries) {
    for (const day of new Set([dayOf(entry.created), dayOf(entry.updated)])) {
      days.set(day, (days.get(day) ?? 0) + 1)
    }
  }
  return days
}

/**
 * The days a calendar of whole weeks ending this week holds, Monday first,
 * stopping at today: the future has no activity to show.
 *
 * @param {number} now  epoch milliseconds
 * @param {number} [weeks]
 * @returns {string[]} YYYY-MM-DD, oldest first
 */
export function recentDays(now, weeks = 12) {
  const today = new Date(now)
  const day = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  // Back to this week's Monday, then back the weeks before it. setDate does
  // the calendar arithmetic, so a clock change in between costs no day.
  day.setDate(day.getDate() - ((day.getDay() + 6) % 7) - 7 * (weeks - 1))
  const days = []
  while (day <= today) {
    days.push(dayOf(day.getTime()))
    day.setDate(day.getDate() + 1)
  }
  return days
}
