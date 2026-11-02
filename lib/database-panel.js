// textarea-plus: a database on screen. When the note open is a database (see
// lib/database.js) this takes the article's place; the note underneath stays
// the note, and "Edit as text" shows it. Every edit here is a rewrite of one
// line of some note's text, through setProperty, and nothing else is kept.

import {
  boardColumns,
  columnsOf,
  databaseOf,
  isDay,
  LAYOUTS,
  monthDays,
  newRowText,
  queryValue,
  rowsOf,
  shiftDay,
  sortRows,
} from './database.js'
import {showDialog} from './dialog.js'
import {hasFileDrag} from './files.js'
import {dayOf} from './filter.js'
import {titleOf} from './front-matter.js'
import {getDocument} from './library.js'
import {notify} from './notify.js'
import {article, documentId, switchDocument} from './note.js'
import {setProperty, validKey} from './properties.js'
import {addNote, writeNote} from './write-back.js'

export const LAYOUT_OPTIONS = LAYOUTS.map((value) => ({value, label: value[0].toUpperCase() + value.slice(1)}))

const root = document.documentElement

const panel = document.createElement('section')
panel.id = 'database'
panel.setAttribute('aria-label', 'Database')

// The way back from "Edit as text".
const toggle = document.createElement('button')
toggle.id = 'database-show'
toggle.className = 'noprint'
toggle.type = 'button'
toggle.textContent = 'Show as database'
toggle.hidden = true
toggle.addEventListener('click', () => {
  showing = true
  updateDatabase()
})

let entries = []
let lastId = null
let loaded = false
let showing = false
let month = null
let redrawOnLeave = false

export function initDatabase() {
  article.after(panel)
  panel.addEventListener('focusout', () => {
    if (!redrawOnLeave) return
    redrawOnLeave = false
    // After the focus has landed, so the redraw can find it and put it back.
    setTimeout(() => updateDatabase())
  })
  document.body.append(toggle)
}

/**
 * Whether the note on screen shows as a database. A note becomes one when it is
 * opened, never while its lines are being typed.
 */
function follow() {
  const id = documentId()
  const text = article.textContent
  const database = databaseOf(text)
  // The first text after a page load is the note arriving, not being typed.
  if (id !== lastId || (!loaded && text.trim())) {
    showing = Boolean(database)
    month = null
  }
  lastId = id
  loaded ||= Boolean(text.trim())
  if (!database) showing = false
  root.classList.toggle('database-open', showing)
  toggle.hidden = showing || !database
  return database
}

/**
 * Draw again.
 *
 * @param {Array<object>} [all] the library, when it has just been read
 */
export function updateDatabase(all) {
  if (all) entries = all
  const database = follow()
  if (showing) draw(database)
}

/**
 * A save or a load, before the library has been read again: a note just opened
 * goes up at once, so it does not flash as text. Anything already on screen
 * waits for the read, or this edit's own cell would go back to its old value.
 */
export function followNote() {
  const before = lastId
  const database = follow()
  if (showing && lastId !== before) draw(database)
}

/* ------------------------------------------------------------- writing back */

const writeProperty = (id, key, value) => writeNote(id, (text) => setProperty(text, key, value))

/** A setting of the database itself: a line of the note on screen. */
const setSetting = (key, value) => writeProperty(documentId(), key, value)

/** Ask for a title and make a row. */
async function addRow(database, values) {
  const answer = await showDialog({
    title: 'New row',
    submitLabel: 'Add',
    fields: [{type: 'text', name: 'title', label: 'Title'}],
  })
  if (!answer) return
  const text = newRowText(database, answer.title, values)
  const made = await addNote(text)
  if (made && !rowsOf([made], database.query).length) {
    notify('Added, but it does not match this query, so it is not shown here.', {duration: 5000})
  }
}

async function openRow(id) {
  const entry = await getDocument(id)
  if (entry) await switchDocument(entry)
}

/* ------------------------------------------------------------------ drawing */

export function make(tag, className, text) {
  const element = document.createElement(tag)
  if (className) element.className = className
  if (text !== undefined) element.textContent = text
  return element
}

export function action(text, onClick, focus) {
  const element = make('button', 'database-button', text)
  element.type = 'button'
  element.addEventListener('click', onClick)
  if (focus) element.dataset.focus = focus
  return element
}

export function chooser(label, value, options, onChange) {
  const select = make('select', 'database-select')
  select.setAttribute('aria-label', label)
  select.dataset.focus = `choose:${label}`
  for (const option of options) {
    const element = make('option', '', option.label)
    element.value = option.value
    select.append(element)
  }
  select.value = value
  select.addEventListener('change', () => onChange(select.value))
  return select
}

function draw(database) {
  const active = panel.contains(document.activeElement) ? document.activeElement : null
  // A save lands while the reader is typing in the next cell. A control put
  // back holding that text would never fire its change, so the edit would be
  // lost: the redraw waits for the reader to leave the cell instead.
  if (active?.tagName === 'INPUT' && active.value !== active.defaultValue) {
    redrawOnLeave = true
    return
  }
  const focus = active?.dataset.focus
  // A date input has no selection to ask about, and answers null.
  const selected = active?.selectionStart == null ? null : [active.selectionStart, active.selectionEnd]

  const rows = sortRows(rowsOf(entries, database.query), database.sort)
  const draws = {table: drawTable, board: drawBoard, calendar: drawCalendar, list: drawList}
  panel.replaceChildren(drawHeader(database, rows), draws[database.layout](database, rows))

  if (!focus) return
  const again = [...panel.querySelectorAll('[data-focus]')].find((element) => element.dataset.focus === focus)
  again?.focus()
  if (selected && again?.tagName === 'INPUT') again.setSelectionRange(...selected)
}

function drawHeader(database, rows) {
  const header = make('header', 'database-header')
  const title = make('h1', 'database-title', titleOf(article.textContent))
  const count = make('span', 'database-count', rows.length === 1 ? '1 note' : `${rows.length} notes`)

  const query = make('input', 'database-query')
  query.defaultValue = database.query
  query.placeholder = '#tag status:doing due:<7d'
  query.setAttribute('aria-label', 'Query')
  query.dataset.focus = 'query'
  query.addEventListener('change', () => void setSetting('query', queryValue(query.value)))
  query.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') query.blur()
  })

  const layout = chooser('Layout', database.layout, LAYOUT_OPTIONS, (value) => void setSetting('view', value))
  const asText = action('Edit as text', () => {
    showing = false
    updateDatabase()
    article.focus()
  })
  const controls = make('div', 'database-controls')
  controls.append(query, layout)
  const keys = columnsOf(rows, {...database, columns: []})
  const named = (current) => [...new Set([current, ...keys])].map((key) => ({value: key, label: key}))
  if (database.layout === 'board') {
    controls.append(chooser('Group by', database.group, named(database.group), (value) => void setSetting('group', value)))
  }
  if (database.layout === 'calendar') {
    controls.append(chooser('Date', database.date, named(database.date), (value) => void setSetting('date', value)))
  }
  controls.append(asText)
  header.append(title, count, controls)
  return header
}

/** The values a column has, offered as a cell is typed in. */
function valueLists(rows, columns) {
  const lists = make('div')
  lists.hidden = true
  columns.forEach((key, index) => {
    const list = make('datalist')
    list.id = `database-values-${index}`
    const values = new Set(rows.map((row) => row.properties.get(key)).filter(Boolean))
    for (const value of [...values].slice(0, 50)) {
      const option = make('option')
      option.value = value
      list.append(option)
    }
    lists.append(list)
  })
  return lists
}

function cell(row, key, index, database) {
  let value = row.properties.get(key) ?? ''
  const input = make('input', 'database-cell')
  // A date picker can only show a date: anything else stays as it was typed.
  input.type = (key === 'due' || key === database.date) && (!value || isDay(value)) ? 'date' : 'text'
  input.defaultValue = value
  input.setAttribute('aria-label', `${key} of ${row.title}`)
  if (input.type === 'text') input.setAttribute('list', `database-values-${index}`)
  input.dataset.focus = `cell:${row.id}:${key}`
  // On leaving, not on change: a date input changes at every digit of its year.
  input.addEventListener('blur', () => {
    if (input.value === value) return
    value = input.defaultValue = input.value
    void writeProperty(row.id, key, value)
  })
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') input.blur()
    if (event.key === 'Escape') {
      input.value = value
      input.blur()
    }
  })
  return input
}

const rowLink = (row) => action(row.title, () => void openRow(row.id), `open:${row.id}`)

async function addColumn(database, columns) {
  const answer = await showDialog({
    title: 'New column',
    description: 'A property. It is written into a note as a key:: value line once that note has a value.',
    submitLabel: 'Add',
    fields: [{type: 'text', name: 'key', label: 'Name'}],
    validate: ({key}) => (validKey(key) ? null : 'A name starts with a letter and has no colons.'),
  })
  if (!answer) return
  const key = answer.key.trim().toLowerCase()
  await setSetting('columns', [...new Set([...columns, key])].join(', '))
}

function drawTable(database, rows) {
  const columns = columnsOf(rows, database)
  const wrap = make('div', 'database-scroll')
  const table = make('table', 'database-table')
  const head = make('tr')
  const heading = (label, key) => {
    const th = make('th')
    th.scope = 'col'
    const down = database.sort === `-${key}`
    const sorted = key ? database.sort === key || down : !database.sort
    if (sorted) th.setAttribute('aria-sort', down ? 'descending' : 'ascending')
    const next = key === '' ? '' : sorted && !down ? `-${key}` : key
    th.append(action(`${label}${sorted ? (down ? ' ↓' : ' ↑') : ''}`, () => void setSetting('sort', next), `sort:${key}`))
    return th
  }
  head.append(heading('Title', ''), ...columns.map((key) => heading(key, key)))
  const more = make('th')
  more.append(action('Add column', () => void addColumn(database, columns), 'add-column'))
  head.append(more)
  const thead = make('thead')
  thead.append(head)
  const body = make('tbody')
  for (const row of rows) {
    const tr = make('tr')
    const name = make('th')
    name.scope = 'row'
    name.append(rowLink(row))
    tr.append(name)
    columns.forEach((key, index) => {
      const td = make('td')
      td.append(cell(row, key, index, database))
      tr.append(td)
    })
    tr.append(make('td'))
    body.append(tr)
  }
  table.append(thead, body)
  wrap.append(table, valueLists(rows, columns), emptyNote(rows), action('New row', () => void addRow(database), 'new-row'))
  return wrap
}

function emptyNote(rows) {
  return rows.length ? '' : make('p', 'database-empty', 'No notes match this query.')
}

function drawList(database, rows) {
  const columns = columnsOf(rows, database)
  const wrap = make('div')
  const list = make('ul', 'database-list')
  for (const row of rows) {
    const item = make('li')
    item.append(rowLink(row))
    columns.forEach((key, index) => {
      const label = make('label', 'database-field')
      label.append(make('span', '', key), cell(row, key, index, database))
      item.append(label)
    })
    list.append(item)
  }
  wrap.append(list, valueLists(rows, columns), emptyNote(rows), action('New row', () => void addRow(database), 'new-row'))
  return wrap
}

/** Somewhere a row can be dragged to. A file dragged in is the page's to handle. */
function dropTarget(element, rows, onDrop) {
  element.addEventListener('dragover', (event) => {
    if (hasFileDrag(event)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
  })
  element.addEventListener('drop', (event) => {
    if (hasFileDrag(event)) return
    event.preventDefault()
    const id = event.dataTransfer.getData('text/plain')
    if (rows.some((row) => row.id === id)) onDrop(id)
  })
}

function drawBoard(database, rows) {
  const columns = boardColumns(rows, database)
  const board = make('div', 'database-board')
  const places = columns.map(({value, label}) => ({value, label}))
  if (!places.some(({value}) => value === '')) places.push({value: '', label: 'No value'})
  for (const column of columns) {
    const lane = make('section', 'database-lane')
    lane.setAttribute('aria-label', column.label)
    lane.append(make('h2', 'database-lane-title', `${column.label} ${column.rows.length}`))
    dropTarget(lane, rows, (id) => void writeProperty(id, database.group, column.value))
    for (const row of column.rows) {
      const card = make('div', 'database-card')
      card.draggable = true
      card.addEventListener('dragstart', (event) => {
        event.dataTransfer.setData('text/plain', row.id)
        event.dataTransfer.effectAllowed = 'move'
      })
      card.append(rowLink(row))
      for (const [key, value] of row.properties) {
        if (key !== database.group && key !== 'folder') card.append(make('p', 'database-card-line', `${key}: ${value}`))
      }
      // Dragging is one way to move a card; this is the one a keyboard has.
      card.append(
        chooser(`Move ${row.title}`, column.value, places, (value) => void writeProperty(row.id, database.group, value)),
      )
      lane.append(card)
    }
    const values = column.value ? {[database.group]: column.value} : {}
    lane.append(action('New row', () => void addRow(database, values), `new-row:${column.value}`))
    board.append(lane)
  }
  const wrap = make('div')
  wrap.append(action('Add column', () => void addLane(database, columns), 'add-lane'), board)
  return wrap
}

async function addLane(database, columns) {
  const answer = await showDialog({
    title: 'New column',
    description: `A value of ${database.group} for cards to move to.`,
    submitLabel: 'Add',
    fields: [{type: 'text', name: 'value', label: 'Value'}],
  })
  const value = answer?.value?.replace(/,/g, ' ').trim()
  if (!value) return
  const named = columns.filter((column) => column.value).map((column) => column.value)
  await setSetting('options', [...new Set([...named, value])].join(', '))
}

function drawCalendar(database, rows) {
  const now = new Date()
  month ??= {year: now.getFullYear(), month: now.getMonth()}
  const move = (by) => {
    const next = new Date(month.year, month.month + by, 1)
    month = {year: next.getFullYear(), month: next.getMonth()}
    updateDatabase()
  }
  const wrap = make('div', 'database-calendar')
  const bar = make('div', 'database-month')
  const name = new Date(month.year, month.month, 1).toLocaleDateString(undefined, {month: 'long', year: 'numeric'})
  bar.append(
    action('Previous', () => move(-1), 'month-back'),
    make('h2', 'database-month-name', name),
    action('Next', () => move(1), 'month-on'),
    action(
      'This month',
      () => {
        month = null
        updateDatabase()
      },
      'month-now',
    ),
  )

  const byDay = new Map()
  const undated = []
  for (const row of rows) {
    const day = row.properties.get(database.date)
    if (isDay(day)) byDay.set(day, [...(byDay.get(day) ?? []), row])
    else undated.push(row)
  }

  const today = dayOf(now.getTime())
  const grid = make('div', 'database-days')
  for (const label of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']) {
    grid.append(make('span', 'database-weekday', label))
  }
  for (const {day, inMonth} of monthDays(month.year, month.month)) {
    const box = make('div', `database-day${inMonth ? '' : ' database-day-out'}${day === today ? ' database-today' : ''}`)
    box.dataset.day = day
    dropTarget(box, rows, (id) => void writeProperty(id, database.date, day))
    const add = action(day.slice(8).replace(/^0/, ''), () => void addRow(database, {[database.date]: day}), `add:${day}`)
    add.setAttribute('aria-label', `New row on ${day}`)
    box.append(add)
    for (const row of byDay.get(day) ?? []) {
      const chip = rowLink(row)
      chip.classList.add('database-chip')
      chip.draggable = true
      chip.setAttribute('aria-keyshortcuts', 'Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown')
      chip.addEventListener('dragstart', (event) => {
        event.dataTransfer.setData('text/plain', row.id)
        event.dataTransfer.effectAllowed = 'move'
      })
      chip.addEventListener('keydown', (event) => {
        const by = {ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7}[event.key]
        if (!event.altKey || !by) return
        event.preventDefault()
        void writeProperty(row.id, database.date, shiftDay(day, by))
      })
      box.append(chip)
    }
    grid.append(box)
  }
  const hint = make('p', 'database-hint', 'Drag a note to another day, or press Alt and an arrow key on its name.')
  wrap.append(bar, grid, hint)
  if (undated.length) {
    const heading = make('h2', 'database-lane-title', `No ${database.date}`)
    const list = make('ul', 'database-list')
    for (const row of undated) {
      const item = make('li')
      item.append(rowLink(row), cell(row, database.date, 0, database))
      list.append(item)
    }
    wrap.append(heading, list)
  }
  return wrap
}
