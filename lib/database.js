// textarea-plus: databases. A saved query, drawn as a table, a board, a calendar
// or a list, with a row for each note it finds and a column for each property.
//
// A database is itself a note, so it travels with the folder like any other:
//
//   # Active projects
//
//   view:: board
//   query:: `#project -status:done`
//   group:: status
//
// The query sits in a code span so its #project does not tag the database. The
// tokens are My documents' (lib/filter.js) plus the ones only a property has:
//   is:task           has an open task
//   due:<7d           a due:: line or the first 📅 of an open task, within seven
//                     days or overdue; also due:>7d,
//                     due:today, due:overdue, due:2026-11-03, due:<2026-12-01
//   status:doing      a property; quote a value with spaces, status:"in review"
//   -status:done      not that value
//   folder:Work       in that folder or under it
//
// Pure, as filter.js and views.js are: lib/database-panel.js draws what this says.

import {dayOf, matchNote, parseQuery} from './filter.js'
import {tasksIn} from './markdown.js'
import {propertiesOf} from './properties.js'
import {firstDue} from './tasks.js'
import {folderOf, labelOf} from './views.js'

export const LAYOUTS = ['table', 'board', 'calendar', 'list']

/** The column for notes with no value on a board. */
export const NO_VALUE = 'No value'

const DAY = /^\d{4}-\d{2}-\d{2}$/
export const isDay = (value) => DAY.test(value ?? '')

const listOf = (value) =>
  String(value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)

/**
 * The database a note describes.
 *
 * @param {string} text
 * @returns {{layout: string, query: string, group: string, date: string, columns: string[], options: string[], sort: string} | null}
 *   null for any other note
 */
export function databaseOf(text) {
  const properties = propertiesOf(text)
  const layout = properties.get('view')?.toLowerCase()
  if (!properties.has('query') || !LAYOUTS.includes(layout)) return null
  return {
    layout,
    query: properties.get('query').replace(/^`|`$/g, ''),
    group: properties.get('group')?.toLowerCase() || 'status',
    date: properties.get('date')?.toLowerCase() || 'due',
    columns: listOf(properties.get('columns')?.toLowerCase()),
    options: listOf(properties.get('options')),
    sort: properties.get('sort')?.toLowerCase() ?? '',
  }
}

/** A query as a property line holds it. */
export const queryValue = (query) => `\`${String(query).replace(/`/g, '').trim()}\``

/** A new database note. */
export const newDatabaseText = (name, query, layout) =>
  `# ${String(name).trim() || 'Database'}\n\nview:: ${layout}\nquery:: ${queryValue(query)}\n`

/**
 * A query taken apart: what My documents understands, and the tokens only a
 * property answers. My documents' own parser stays as it is, since a colon in
 * its search box is simply a thing to find.
 *
 * @param {string} query
 */
export function parseRowQuery(query) {
  const parsed = {task: false, due: null, wanted: [], unwanted: [], folder: '', rest: ''}
  const rest = []
  for (const raw of String(query ?? '').match(/[^\s"]*"[^"]*"|\S+/g) ?? []) {
    const lower = raw.toLowerCase()
    const property = /^(-?)(\p{L}[\p{L}\p{N}_-]*):(?!\/)(.+)$/u.exec(raw)
    if (lower === 'is:task') parsed.task = true
    else if (/^(?:on|is):/.test(lower) || !property) rest.push(raw.replace(/"/g, ''))
    else {
      const [, not, key, quoted] = property
      const name = key.toLowerCase()
      const value = quoted.replace(/"/g, '')
      if (name === 'due' && !not && dueRule(value)) parsed.due = value.toLowerCase()
      else if (name === 'folder' && !not) parsed.folder = value
      else (not ? parsed.unwanted : parsed.wanted).push({key: name, value})
    }
  }
  parsed.rest = parseQuery(rest.join(' '))
  return parsed
}

const dueRule = (value) => /^(?:today|overdue|[<>]\d+d|[<>]?\d{4}-\d{2}-\d{2})$/i.test(value)

/** The day a number of days from another, by the calendar, not by 24 hours. */
export function shiftDay(day, days) {
  const [year, month, date] = day.split('-').map(Number)
  return dayOf(new Date(year, month - 1, date + days).getTime())
}

function dueMatches(due, rule, today) {
  if (!isDay(due)) return false
  if (rule === 'today') return due === today
  if (rule === 'overdue') return due < today
  const relative = /^([<>])(\d+)d$/.exec(rule)
  if (relative) {
    const edge = shiftDay(today, Number(relative[2]))
    return relative[1] === '<' ? due <= edge : due > edge
  }
  if (rule[0] === '<') return due < rule.slice(1)
  if (rule[0] === '>') return due > rule.slice(1)
  return due === rule
}

const sameValue = (a, b) => String(a ?? '').toLowerCase() === String(b).toLowerCase()

/**
 * The notes a query finds, as rows. A database is never a row, of itself or
 * of another: its query line would be a match for its own words.
 *
 * @param {Array<{id: string, text?: string, archived?: boolean}>} entries
 * @param {string} query
 * @param {Date} [now]
 * @returns {Array<{id: string, title: string, properties: Map<string, string>}>}
 */
export function rowsOf(entries, query, now = new Date()) {
  const parsed = parseRowQuery(query)
  const today = dayOf(now.getTime())
  const rows = []
  for (const entry of entries) {
    const text = entry.text ?? ''
    if (databaseOf(text) || !matchNote(entry, parsed.rest)) continue
    if (parsed.task && !tasksIn(text).some((task) => !task.done)) continue
    const properties = propertiesOf(text)
    if (parsed.due && !dueMatches(properties.get('due') ?? firstDue(entry), parsed.due, today)) continue
    if (parsed.wanted.some(({key, value}) => !sameValue(properties.get(key), value))) continue
    if (parsed.unwanted.some(({key, value}) => sameValue(properties.get(key), value))) continue
    if (parsed.folder) {
      const folder = folderOf(text).toLowerCase()
      const path = parsed.folder.toLowerCase()
      if (folder !== path && !folder.startsWith(`${path}/`)) continue
    }
    rows.push({id: entry.id, title: labelOf(entry), properties})
  }
  return rows
}

const order = new Intl.Collator(undefined, {numeric: true, sensitivity: 'base'})

/**
 * Rows in the order a `sort` value asks for: a property name, `-` before it for
 * backwards, the title when it is empty. A row with no value goes last either way.
 *
 * @param {ReturnType<typeof rowsOf>} rows
 * @param {string} sort
 */
export function sortRows(rows, sort) {
  const down = sort.startsWith('-')
  const key = down ? sort.slice(1) : sort
  const sign = down ? -1 : 1
  return [...rows].sort((a, b) => {
    if (!key) return order.compare(a.title, b.title)
    const x = a.properties.get(key) ?? ''
    const y = b.properties.get(key) ?? ''
    if (!x || !y) return (x ? 0 : 1) - (y ? 0 : 1) || order.compare(a.title, b.title)
    return sign * order.compare(x, y) || order.compare(a.title, b.title)
  })
}

/** The columns to draw: the ones the database names, or every property found. */
export function columnsOf(rows, database) {
  if (database.columns.length) return database.columns
  const found = new Set()
  for (const row of rows) {
    for (const key of row.properties.keys()) if (key !== 'folder') found.add(key)
  }
  return [...found].sort(order.compare)
}

/**
 * A board's columns: the named options in their order, then any other value
 * found, then the notes with none. A note's value keeps its own spelling.
 *
 * @returns {Array<{value: string, label: string, rows: ReturnType<typeof rowsOf>}>}
 */
export function boardColumns(rows, database) {
  const columns = new Map(database.options.map((value) => [value.toLowerCase(), {value, label: value, rows: []}]))
  const none = {value: '', label: NO_VALUE, rows: []}
  const others = []
  for (const row of rows) {
    const value = row.properties.get(database.group) ?? ''
    if (!value) {
      none.rows.push(row)
      continue
    }
    const key = value.toLowerCase()
    if (!columns.has(key)) {
      const column = {value, label: value, rows: []}
      columns.set(key, column)
      others.push(column)
    }
    columns.get(key).rows.push(row)
  }
  others.sort((a, b) => order.compare(a.value, b.value))
  return [...database.options.map((value) => columns.get(value.toLowerCase())), ...others, ...(none.rows.length ? [none] : [])]
}

/**
 * The 42 days a month's page shows, Monday first.
 *
 * @param {number} year
 * @param {number} month 0 to 11
 * @returns {Array<{day: string, inMonth: boolean}>}
 */
export function monthDays(year, month) {
  const first = new Date(year, month, 1)
  const before = (first.getDay() + 6) % 7
  return Array.from({length: 42}, (_, index) => {
    const date = new Date(year, month, 1 - before + index)
    return {day: dayOf(date.getTime()), inMonth: date.getMonth() === month}
  })
}

/**
 * A new note for a row: the tags and values its database asks for, so it is
 * found as soon as it is made. A phrase in the query is not something a new
 * note can be given.
 *
 * @param {ReturnType<typeof databaseOf>} database
 * @param {string} title
 * @param {Record<string, string>} [values] set beyond what the query asks for
 */
export function newRowText(database, title, values = {}) {
  const parsed = parseRowQuery(database.query)
  const lines = [`# ${String(title).trim() || 'Untitled'}`, '']
  if (parsed.task) lines.push('- [ ] ', '')
  if (parsed.rest.tags.length) lines.push(parsed.rest.tags.map((tag) => `#${tag}`).join(' '), '')
  const properties = new Map(parsed.wanted.map(({key, value}) => [key, value]))
  if (parsed.folder) properties.set('folder', parsed.folder)
  if (isDay(parsed.due)) properties.set('due', parsed.due)
  for (const [key, value] of Object.entries(values)) properties.set(key, value)
  for (const [key, value] of properties) if (value) lines.push(`${key}:: ${value}`)
  return `${lines.join('\n').replace(/\n+$/, '')}\n`
}

