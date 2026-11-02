// textarea-plus: the Tasks screen. Takes the article's place the way a database
// does, and every action is a rewrite of one line of a note through lib/tasks.js.
//
// From the keyboard, with a row in focus: j and k or the arrows move, x finishes,
// s moves it through the statuses, p through the priorities, t makes it today's,
// n puts it in next week's cycle, z on Someday, Enter opens its note; c or / goes
// to quick add from anywhere on the screen, and Escape back to the note.

import {action, chooser, make} from './database-panel.js'
import {dayOf} from './filter.js'
import {titleOf} from './front-matter.js'
import {getDocument, listDocuments} from './library.js'
import {notify} from './notify.js'
import {article, documentId, editor, save, switchDocument} from './note.js'
import {remindersEnabled, setRemindersEnabled} from './prefs.js'
import {
  addTaskLine,
  allTasks,
  changeTask,
  cycleLabel,
  cycleOf,
  dueReminders,
  groupTasks,
  isOpen,
  LISTS,
  listOf,
  nextCycle,
  nextDate,
  nextPriority,
  parseQuickAdd,
  parseTaskLine,
  PRIORITIES,
  reminderKey,
  setDate,
  setPriority,
  setStatus,
  shiftDates,
  sortTasks,
  STATUSES,
  TASKS_NOTE,
  timelineBars,
  toggleSomeday,
} from './tasks.js'
import {addNote, writeNote} from './write-back.js'

const root = document.documentElement
const LAYOUT_OPTIONS = [
  {value: 'list', label: 'List'},
  {value: 'board', label: 'Board'},
  {value: 'timeline', label: 'Timeline'},
]
const ALL = ''
const TIMELINE_DAYS = 35
// A board of everything ever finished would be a list of the past.
const DONE_ON_BOARD = 30

const panel = make('section')
panel.id = 'tasks'
panel.setAttribute('aria-label', 'Tasks')
const body = make('div')

let entries = []
let showing = false
let shownNote = null
let list = 'today'
let layout = 'list'
let area = ALL
let project = ALL
let cycle = ALL
let timelineFrom = null

const today = () => dayOf(Date.now())

/** One task line changed, wherever its note is. */
function writeTask(task, change) {
  return writeNote(task.noteId, (text) =>
    changeTask(text, task, (line) => {
      const written = change(line)
      // The row stays on screen until the redraw, and its next key has to find
      // this line: a repeat has just put another with the same words above it.
      const parts = written.split('\n')
      task.lineNo = text.split('\n').indexOf(line) + parts.length - 1
      task.line = parts.at(-1)
      return written
    }),
  )
}

const setTaskStatus = (task, char) => writeTask(task, (line) => setStatus(line, char, today()))

async function openTask(task) {
  closeTasks()
  const entry = await getDocument(task.noteId)
  if (!entry) return
  await switchDocument(entry)
  const offset = article.textContent.split('\n').slice(0, task.lineNo).join('\n').length + (task.lineNo ? 1 : 0)
  article.focus()
  editor.select(offset, offset)
}

/* ---------------------------------------------------------------- quick add */

// One at a time and from a fresh read: two added before the first is written
// must not make two notes called Tasks.
let adding = Promise.resolve()
function addTask(line) {
  adding = adding.then(async () => {
    const held = (await listDocuments()).find((entry) => !entry.archived && titleOf(entry.text ?? '') === TASKS_NOTE)
    if (held) await writeNote(held.id, (text) => addTaskLine(text, line))
    else await addNote(`# ${TASKS_NOTE}\n\n${line}\n`)
  })
  return adding
}

function describe(parsed) {
  const parts = []
  if (parsed.due) parts.push(`due ${parsed.due}`)
  if (parsed.time) parts.push(`reminder at ${parsed.time}`)
  const priority = PRIORITIES.find(({rank}) => rank === parsed.priority)
  if (priority) parts.push(priority.label.toLowerCase())
  if (parsed.recurrence) parts.push(parsed.recurrence)
  return parts.length ? `${parsed.description}: ${parts.join(', ')}` : ''
}

function drawQuickAdd() {
  const form = make('form', 'tasks-add')
  const input = make('input', 'tasks-add-input')
  input.setAttribute('aria-label', 'Quick add a task')
  input.placeholder = 'Add a task: call mum tomorrow 3pm #home p1 every week'
  input.autocomplete = 'off'
  const preview = make('p', 'tasks-add-preview')
  preview.setAttribute('role', 'status')
  input.addEventListener('input', () => {
    preview.textContent = input.value.trim() ? describe(parseQuickAdd(input.value, new Date())) : ''
  })
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      input.value = ''
      preview.textContent = ''
      body.querySelector('.task-row')?.focus()
    }
  })
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    if (!input.value.trim()) return
    const {line} = parseQuickAdd(input.value, new Date())
    input.value = ''
    preview.textContent = ''
    void addTask(line)
  })
  form.append(input, preview)
  return form
}

/* ------------------------------------------------------------------ drawing */

/** The filters every layout shares. */
function filtered(tasks) {
  return tasks.filter(
    (task) =>
      (area === ALL || task.area === area) &&
      (project === ALL || task.project === project) &&
      (cycle === ALL || (task.scheduled && cycleOf(task.scheduled) === cycle)),
  )
}

function drawBar(tasks) {
  const bar = make('div', 'tasks-bar')
  if (layout === 'list') {
    const lists = make('div', 'tasks-lists')
    lists.setAttribute('role', 'group')
    lists.setAttribute('aria-label', 'Lists')
    const counted = filtered(tasks)
    for (const {id, label} of LISTS) {
      const count = counted.filter((task) => listOf(task, today()) === id).length
      const button = action(id === 'logbook' || !count ? label : `${label} ${count}`, () => {
        list = id
        draw()
      }, `list:${id}`)
      button.dataset.list = id
      if (id === list) button.setAttribute('aria-current', 'page')
      lists.append(button)
    }
    bar.append(lists)
  }
  const choices = make('div', 'tasks-choices')
  const redraw = (set) => (value) => {
    set(value)
    draw()
  }
  choices.append(chooser('Layout', layout, LAYOUT_OPTIONS, redraw((value) => (layout = value))))
  const areas = [...new Set(tasks.map((task) => task.area).filter(Boolean))].sort()
  if (areas.length) {
    choices.append(
      chooser('Area', area, [{value: ALL, label: 'All areas'}, ...areas.map((value) => ({value, label: value}))], redraw((value) => (area = value))),
    )
  }
  const projects = [...new Set(tasks.map((task) => task.project).filter(Boolean))].sort()
  if (projects.length) {
    choices.append(
      chooser('Project', project, [{value: ALL, label: 'All projects'}, ...projects.map((value) => ({value, label: value}))], redraw((value) => (project = value))),
    )
  }
  const now = cycleOf(today())
  const cycles = [...new Set([now, nextCycle(now), ...tasks.flatMap((task) => (task.scheduled ? [cycleOf(task.scheduled)] : []))])].sort()
  choices.append(
    chooser('Cycle', cycle, [{value: ALL, label: 'All cycles'}, ...cycles.map((value) => ({value, label: cycleLabel(value, today())}))], redraw((value) => (cycle = value))),
  )
  if ('Notification' in window) {
    choices.append(
      action(remindersEnabled() ? 'Reminders on' : 'Turn on reminders', () => void toggleReminders(), 'reminders'),
    )
  }
  bar.append(choices)
  return bar
}

function metaOf(task) {
  const now = today()
  const parts = []
  if (task.status === 'doing') parts.push('In progress')
  if (task.status === 'cancelled') parts.push('Cancelled')
  const priority = PRIORITIES.find(({rank}) => rank === task.priority)
  if (priority) parts.push(priority.label)
  if (task.due) parts.push(task.due < now && isOpen(task) ? `Overdue ${task.due}` : `Due ${task.due}`)
  if (task.scheduled) parts.push(`Scheduled ${task.scheduled}`)
  if (task.start) parts.push(`Starts ${task.start}`)
  if (task.remind) parts.push(`Reminder ${task.remind}`)
  if (task.recurrence) parts.push(task.recurrence)
  if (task.done) parts.push(`Done ${task.done}`)
  return parts.join(' · ')
}

const taskKey = (task) => `task:${task.noteId}:${task.lineNo}`

function drawRow(task) {
  const row = make('li', 'task-row')
  row.tabIndex = 0
  row.dataset.focus = taskKey(task)
  row.dataset.note = task.noteId
  row.dataset.line = String(task.lineNo)
  if (!isOpen(task)) row.classList.add('task-closed')
  const box = make('input', 'task-box')
  box.type = 'checkbox'
  box.checked = task.status === 'done'
  box.setAttribute('aria-label', `Finish ${task.description}`)
  box.dataset.focus = `box:${task.noteId}:${task.lineNo}`
  box.addEventListener('change', () => void setTaskStatus(task, box.checked ? 'x' : ' '))
  const words = make('div', 'task-words')
  words.append(action(task.description, () => void openTask(task)))
  const meta = metaOf(task)
  if (meta) words.append(make('p', 'task-meta', meta))
  row.append(box, words)
  row.addEventListener('keydown', (event) => onRowKey(event, task))
  return row
}

function drawList(tasks) {
  const now = today()
  const onList = filtered(tasks).filter((task) => listOf(task, now) === list)
  const wrap = make('div')
  if (!onList.length) wrap.append(make('p', 'database-empty', EMPTY[list]))
  const section = (heading, rows) => {
    wrap.append(make('h2', 'database-lane-title tasks-heading', heading))
    const ul = make('ul', 'task-rows')
    ul.append(...rows.map(drawRow))
    wrap.append(ul)
  }
  if (list === 'upcoming') {
    const days = new Map()
    for (const task of sortTasks(onList)) {
      const day = nextDate(task)
      days.set(day, [...(days.get(day) ?? []), task])
    }
    for (const day of [...days.keys()].sort()) section(day, days.get(day))
  } else if (list === 'logbook') {
    const newest = [...onList].sort((a, b) => (b.done ?? b.cancelled ?? '').localeCompare(a.done ?? a.cancelled ?? ''))
    section('Finished', newest.slice(0, 200))
  } else {
    for (const group of groupTasks(onList)) section(group.heading, sortTasks(group.tasks))
  }
  wrap.append(make('p', 'database-hint', 'j k move · x finish · s status · p priority · t today · n next cycle · z someday · Enter open · c add'))
  return wrap
}

const EMPTY = {
  today: 'Nothing for today.',
  upcoming: 'Nothing dated ahead.',
  anytime: 'No tasks without a date.',
  someday: 'Nothing here. Press z on a task, or tag it #someday.',
  logbook: 'Nothing finished yet.',
}

function drawBoard(tasks) {
  const board = make('div', 'database-board')
  const places = STATUSES.map(({char, label}) => ({value: char, label}))
  const shown = filtered(tasks)
  for (const {id, char, label} of STATUSES) {
    let rows = sortTasks(shown.filter((task) => task.status === id))
    if (!' /'.includes(char)) {
      rows = rows.sort((a, b) => (b.done ?? b.cancelled ?? '').localeCompare(a.done ?? a.cancelled ?? '')).slice(0, DONE_ON_BOARD)
    }
    const lane = make('section', 'database-lane')
    lane.setAttribute('aria-label', label)
    lane.append(make('h2', 'database-lane-title', `${label} ${rows.length}`))
    lane.addEventListener('dragover', (event) => {
      if (![...event.dataTransfer.types].includes('application/x-textarea-task')) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
    })
    lane.addEventListener('drop', (event) => {
      const key = event.dataTransfer.getData('application/x-textarea-task')
      const task = shown.find((candidate) => taskKey(candidate) === key)
      if (!key) return
      event.preventDefault()
      if (task && task.status !== id) void setTaskStatus(task, char)
    })
    for (const task of rows) {
      const card = make('div', 'database-card')
      card.draggable = true
      card.addEventListener('dragstart', (event) => {
        event.dataTransfer.setData('application/x-textarea-task', taskKey(task))
        event.dataTransfer.effectAllowed = 'move'
      })
      card.append(action(task.description, () => void openTask(task), `open:${taskKey(task)}`))
      card.append(make('p', 'database-card-line', task.noteTitle))
      const meta = metaOf({...task, status: 'todo'})
      if (meta) card.append(make('p', 'database-card-line', meta))
      card.append(chooser(`Status of ${task.description}`, task.char.toLowerCase(), places, (value) => void setTaskStatus(task, value)))
      lane.append(card)
    }
    board.append(lane)
  }
  return board
}

function drawTimeline(tasks) {
  timelineFrom ??= cycleOf(today())
  const open = filtered(tasks).filter(isOpen)
  const bars = timelineBars(sortTasks(open), timelineFrom, TIMELINE_DAYS)
  const move = (weeks) => {
    const [year, month, date] = timelineFrom.split('-').map(Number)
    timelineFrom = dayOf(new Date(year, month - 1, date + weeks * 7).getTime())
    draw()
  }
  const wrap = make('div')
  const nav = make('div', 'database-month')
  nav.append(action('Earlier', () => move(-5), 'time-back'), action('Later', () => move(5), 'time-on'), action('This week', () => {
    timelineFrom = null
    draw()
  }, 'time-now'))
  const scroll = make('div', 'database-scroll')
  const grid = make('div', 'timeline')
  grid.style.gridTemplateColumns = `minmax(140px, 200px) repeat(${TIMELINE_DAYS}, minmax(16px, 1fr))`
  const [year, month, date] = timelineFrom.split('-').map(Number)
  const now = today()
  for (let index = 0; index < TIMELINE_DAYS; index++) {
    const day = dayOf(new Date(year, month - 1, date + index).getTime())
    const head = make('span', `timeline-day${day === now ? ' timeline-now' : ''}`, day.slice(8).replace(/^0/, ''))
    head.title = day
    head.style.gridColumn = String(index + 2)
    grid.append(head)
  }
  bars.forEach(({task, from, to}, index) => {
    const label = make('span', 'timeline-label', task.description)
    label.style.gridRow = String(index + 2)
    const bar = action(`${task.description}`, () => void openTask(task), `bar:${taskKey(task)}`)
    bar.classList.add('timeline-bar')
    bar.title = metaOf(task)
    bar.style.gridRow = String(index + 2)
    bar.style.gridColumn = `${from + 2} / ${to + 3}`
    bar.setAttribute('aria-keyshortcuts', 'Alt+ArrowLeft Alt+ArrowRight')
    bar.addEventListener('keydown', (event) => {
      const by = {ArrowLeft: -1, ArrowRight: 1}[event.key]
      if (!event.altKey || !by) return
      event.preventDefault()
      void writeTask(task, (line) => shiftDates(line, by))
    })
    grid.append(label, bar)
  })
  scroll.append(grid)
  wrap.append(nav, scroll)
  const undated = open.filter((task) => !task.due && !task.scheduled && !task.start).length
  const hint = 'Alt and an arrow key on a bar moves its dates.'
  wrap.append(make('p', 'database-hint', undated ? `${hint} ${undated} with no date are not shown.` : hint))
  return wrap
}

function draw() {
  if (!showing) return
  const active = panel.contains(document.activeElement) ? document.activeElement : null
  const focus = body.contains(active) ? active?.dataset.focus : null
  const rows = active?.classList.contains('task-row') ? [...body.querySelectorAll('.task-row')] : []
  const at = rows.indexOf(active)

  const tasks = allTasks(entries)
  const draws = {list: drawList, board: drawBoard, timeline: drawTimeline}
  body.replaceChildren(drawBar(tasks), draws[layout](tasks))

  if (focus) {
    const again = [...body.querySelectorAll('[data-focus]')].find((element) => element.dataset.focus === focus)
    // A row finished has left the list: the next one takes the focus.
    const next = again ?? (at >= 0 ? (body.querySelectorAll('.task-row')[Math.min(at, body.querySelectorAll('.task-row').length - 1)] ?? null) : null)
    next?.focus()
  }
}

/* ----------------------------------------------------------------- keyboard */

function moveFocus(row, by) {
  const rows = [...body.querySelectorAll('.task-row')]
  rows[rows.indexOf(row) + by]?.focus()
}

function onRowKey(event, task) {
  if (event.target !== event.currentTarget || event.metaKey || event.ctrlKey || event.altKey) return
  const row = event.currentTarget
  const now = today()
  const keys = {
    j: () => moveFocus(row, 1),
    ArrowDown: () => moveFocus(row, 1),
    k: () => moveFocus(row, -1),
    ArrowUp: () => moveFocus(row, -1),
    // Read from the line as it now is, not as drawn: a key can come before the redraw.
    // Once per drawing of the row: a key held down must not undo itself.
    x: () => {
      if (task.finishing) return
      task.finishing = true
      void writeTask(task, (line) => setStatus(line, parseTaskLine(line).status === 'done' ? ' ' : 'x', now))
    },
    s: () =>
      void writeTask(task, (line) => {
        const index = STATUSES.findIndex(({id}) => id === parseTaskLine(line).status)
        return setStatus(line, STATUSES[(index + 1) % STATUSES.length].char, now)
      }),
    p: () => void writeTask(task, (line) => setPriority(line, nextPriority(parseTaskLine(line).priority))),
    t: () => void writeTask(task, (line) => setDate(line, 'scheduled', now)),
    n: () => void writeTask(task, (line) => setDate(line, 'scheduled', nextCycle(now))),
    z: () => void writeTask(task, toggleSomeday),
    Enter: () => void openTask(task),
  }
  const run = keys[event.key]
  if (!run) return
  event.preventDefault()
  run()
}

/* ---------------------------------------------------------------- reminders */

const FIRED = 'textarea:reminders-fired'

function firedSet() {
  try {
    return new Set(JSON.parse(localStorage.getItem(FIRED) ?? '[]'))
  } catch {
    return new Set()
  }
}

/** Say whichever reminders have come due. Only while a page is open. */
export async function checkReminders() {
  if (!remindersEnabled() || !('Notification' in window)) return
  const fired = firedSet()
  const due = dueReminders(allTasks(await listDocuments()), new Date(), fired)
  if (!due.length) return
  for (const task of due) {
    fired.add(reminderKey(task))
    notify(`Reminder: ${task.description}`, {duration: 8000})
    if (Notification.permission === 'granted') new Notification(task.description, {body: task.noteTitle})
  }
  try {
    localStorage.setItem(FIRED, JSON.stringify([...fired].slice(-200)))
  } catch {
    // No storage to remember in: it may say so again next time.
  }
}

async function toggleReminders() {
  if (remindersEnabled()) {
    setRemindersEnabled(false)
    draw()
    return
  }
  const answer = await Notification.requestPermission()
  if (answer !== 'granted') {
    notify('The browser said no to notifications, so reminders show only inside this page.', {duration: 6000})
  }
  setRemindersEnabled(true)
  draw()
  void checkReminders()
}

/* -------------------------------------------------------------------- shell */

export function initTasksView() {
  panel.append(drawQuickAdd(), body)
  article.after(panel)
  panel.addEventListener('keydown', (event) => {
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(event.target.tagName)
    if (event.key === 'Escape' && !typing) {
      closeTasks()
      article.focus()
      return
    }
    if (!typing && !event.metaKey && !event.ctrlKey && !event.altKey && (event.key === 'c' || event.key === '/')) {
      event.preventDefault()
      panel.querySelector('.tasks-add-input').focus()
    }
  })
  setInterval(() => void checkReminders(), 30_000)
  void checkReminders()
}

/** The screen up, the note on screen saved first so its tasks are in the list. */
export async function openTasks() {
  await save()
  entries = await listDocuments()
  showing = true
  shownNote = documentId()
  root.classList.add('tasks-open')
  draw()
  ;(body.querySelector('.task-row') ?? panel.querySelector('.tasks-add-input')).focus()
}

export function closeTasks() {
  showing = false
  root.classList.remove('tasks-open')
}

/** Draw again from a fresh read of the library. */
export function updateTasksView(all) {
  entries = all
  if (showing && documentId() !== shownNote) closeTasks()
  draw()
}

/** A note opened from elsewhere, before the library is read again. */
export function followTasksNote() {
  if (showing && documentId() !== shownNote) closeTasks()
}

/** Straight to the box, from Ctrl/Cmd+K. */
export async function quickAdd() {
  await openTasks()
  panel.querySelector('.tasks-add-input').focus()
}
