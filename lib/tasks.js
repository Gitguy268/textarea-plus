// textarea-plus: tasks, read from and written to the lines of notes.
//
// The syntax is Obsidian Tasks', so the same folder works there:
//
//   - [ ] call mum #home ⏰ 2026-11-02 15:00 🔺 🔁 every week 📅 2026-11-02
//
// [ ] todo, [/] in progress, [x] done, [-] cancelled. 📅 due, ⏳ scheduled,
// 🛫 start, ➕ created, ✅ done, ❌ cancelled; 🔺 ⏫ 🔼 🔽 ⏬ priority; 🔁 repeats.
// ⏰ is this app's reminder: a date and a time, which Tasks has no field for
// and leaves in the description.
//
// Pure: a line in, a line out, every other byte of it left alone. Today is
// always passed in. lib/tasks-view.js draws what this says.

import {dayOf} from './filter.js'
import {tagsIn, renderMarkdown} from './markdown.js'
import {propertiesOf} from './properties.js'
import {labelOf} from './views.js'

export const STATUSES = [
  {char: ' ', id: 'todo', label: 'Todo'},
  {char: '/', id: 'doing', label: 'In progress'},
  {char: 'x', id: 'done', label: 'Done'},
  {char: '-', id: 'cancelled', label: 'Cancelled'},
]

/** Highest first; 0 means none, which sorts between medium and low. */
export const PRIORITIES = [
  {emoji: '🔺', label: 'Highest', rank: 5},
  {emoji: '⏫', label: 'High', rank: 4},
  {emoji: '🔼', label: 'Medium', rank: 3},
  {emoji: '🔽', label: 'Low', rank: 1},
  {emoji: '⏬', label: 'Lowest', rank: 0},
]
const NO_PRIORITY_RANK = 2

const FIELDS = {due: '📅', scheduled: '⏳', start: '🛫', created: '➕', done: '✅', cancelled: '❌'}
const SIGNS = '📅⏳🛫➕✅❌🔺⏫🔼🔽⏬🔁⏰'
const dateField = (emoji) => new RegExp(`[ \\t]*${emoji}\\uFE0F?[ \\t]*(\\d{4}-\\d{2}-\\d{2})`, 'u')
const PRIORITY = /[ \t]*([🔺⏫🔼🔽⏬])\uFE0F?/u
const RECURRENCE = new RegExp(`[ \\t]*🔁\\uFE0F?[ \\t]*([^${SIGNS}\\n]*)`, 'u')
const REMINDER = /[ \t]*⏰\uFE0F?[ \t]*(\d{4}-\d{2}-\d{2})(?:[ \t]+(\d{2}:\d{2}))?/u
const TASK_LINE = /^([ \t]*(?:[-*+]|\d+[.)])[ \t]+)\[(.)\](.*)$/
const SOMEDAY = /(^|\s)#someday(?=\s|$)/i

/**
 * A task line taken apart.
 *
 * @param {string} line
 * @returns {null | {status: string, char: string, description: string, due?: string, scheduled?: string, start?: string,
 *   created?: string, done?: string, cancelled?: string, priority: number, recurrence: string, remind: string, someday: boolean}}
 *   null for any other line; `remind` is `YYYY-MM-DD HH:MM`
 */
export function parseTaskLine(line) {
  const match = TASK_LINE.exec(line)
  const status = match && STATUSES.find((candidate) => candidate.char === match[2].toLowerCase())
  if (!status) return null
  let rest = match[3]
  const task = {status: status.id, char: match[2]}
  for (const [name, emoji] of Object.entries(FIELDS)) {
    const found = dateField(emoji).exec(rest)
    if (found) {
      task[name] = found[1]
      rest = rest.replace(found[0], '')
    }
  }
  const priority = PRIORITY.exec(rest)
  task.priority = priority ? PRIORITIES.find(({emoji}) => emoji === priority[1]).rank : NO_PRIORITY_RANK
  if (priority) rest = rest.replace(priority[0], '')
  const recurrence = RECURRENCE.exec(rest)
  task.recurrence = recurrence ? recurrence[1].trim() : ''
  if (recurrence) rest = rest.replace(recurrence[0], '')
  const remind = REMINDER.exec(rest)
  task.remind = remind ? `${remind[1]} ${remind[2] ?? '09:00'}` : ''
  if (remind) rest = rest.replace(remind[0], '')
  task.description = rest.replace(/\s+/g, ' ').trim()
  task.someday = SOMEDAY.test(task.description)
  return task
}

/** Before a trailing block id, or Tasks would stop reading the line at it. */
function append(line, field) {
  const block = /[ \t]+\^[\w-]+$/.exec(line)
  return block ? `${line.slice(0, block.index)} ${field}${block[0]}` : `${line.trimEnd()} ${field}`
}

/** One date field set, or taken out for an empty day. */
export function setDate(line, name, day) {
  const pattern = dateField(FIELDS[name])
  if (!day) return line.replace(pattern, '')
  const field = `${FIELDS[name]} ${day}`
  return pattern.test(line) ? line.replace(pattern, () => ` ${field}`) : append(line, field)
}

/** The priority set; a rank with no emoji takes it out. */
export function setPriority(line, rank) {
  const emoji = PRIORITIES.find((candidate) => candidate.rank === rank)?.emoji
  if (!emoji) return line.replace(PRIORITY, '')
  return PRIORITY.test(line) ? line.replace(PRIORITY, () => ` ${emoji}`) : append(line, emoji)
}

/** Highest, high, medium, none, low, lowest, and round. */
export function nextPriority(rank) {
  const order = [NO_PRIORITY_RANK, 5, 4, 3, 1, 0]
  return order[(order.indexOf(rank) + 1) % order.length]
}

/** On the Someday list, or back off it. */
export function toggleSomeday(line) {
  if (SOMEDAY.test(line)) return line.replace(/[ \t]*#someday(?=\s|$)/i, '')
  return append(line, '#someday')
}

const MONTH_LENGTH = (year, month) => new Date(year, month + 1, 0).getDate()

const addDays = (day, days) => {
  const [year, month, date] = day.split('-').map(Number)
  return dayOf(new Date(year, month - 1, date + days).getTime())
}

const addMonths = (day, months) => {
  const [year, month, date] = day.split('-').map(Number)
  const first = new Date(year, month - 1 + months, 1)
  return dayOf(new Date(first.getFullYear(), first.getMonth(), Math.min(date, MONTH_LENGTH(first.getFullYear(), first.getMonth()))).getTime())
}

const daysBetween = (from, to) => {
  const [a, b] = [from, to].map((day) => {
    const [year, month, date] = day.split('-').map(Number)
    return Date.UTC(year, month - 1, date)
  })
  return Math.round((b - a) / 86_400_000)
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const weekdayOf = (day) => {
  const [year, month, date] = day.split('-').map(Number)
  return new Date(year, month - 1, date).getDay()
}

/**
 * The next date of a repeating task.
 *
 * @param {string} rule `every week`, `every 2 months`, `every monday`, `every weekday`, each optionally `when done`
 * @param {string} from the date it repeats from
 * @returns {string | null} null for a rule this does not read
 */
export function nextOccurrence(rule, from) {
  const text = rule.toLowerCase().replace(/\s+when done$/, '').trim()
  const span = /^every(?: (\d+))? (day|week|month|year)s?$/.exec(text)
  if (span) {
    const n = Number(span[1] ?? 1)
    if (n < 1) return null
    if (span[2] === 'day') return addDays(from, n)
    if (span[2] === 'week') return addDays(from, n * 7)
    return addMonths(from, span[2] === 'month' ? n : n * 12)
  }
  if (text === 'every weekday') {
    let next = addDays(from, 1)
    while ([0, 6].includes(weekdayOf(next))) next = addDays(next, 1)
    return next
  }
  const named = /^every ([a-z]+)$/.exec(text)
  const weekday = named ? WEEKDAYS.indexOf(named[1]) : -1
  if (weekday < 0) return null
  return addDays(from, ((weekday - weekdayOf(from) + 6) % 7) + 1)
}

/** Every date on the line moved together, as moving a bar or a repeat does. */
export function shiftDates(line, days) {
  const task = parseTaskLine(line)
  let moved = line
  for (const name of ['due', 'scheduled', 'start']) {
    if (task?.[name]) moved = setDate(moved, name, addDays(task[name], days))
  }
  return moved.replace(REMINDER, (whole, day) => whole.replace(day, addDays(day, days)))
}

/**
 * The line after a change of status. Finishing a repeating task puts the next
 * one on a line above it, where Obsidian Tasks puts it, so what comes back can
 * be two lines.
 *
 * @param {string} line
 * @param {string} char the new status: ' ', '/', 'x' or '-'
 * @param {string} today
 */
export function setStatus(line, char, today) {
  const task = parseTaskLine(line)
  if (!task) return line
  const bracket = (text, to) => text.replace(/\[.\]/, `[${to}]`)
  let done = setDate(setDate(line, 'done', ''), 'cancelled', '')
  if (char === 'x') done = setDate(done, 'done', today)
  if (char === '-') done = setDate(done, 'cancelled', today)
  done = bracket(done, char)
  if (char !== 'x' || task.status === 'done' || !task.recurrence) return done

  const whenDone = /when done\s*$/i.test(task.recurrence)
  const from = whenDone ? today : (task.due ?? task.scheduled ?? task.start ?? today)
  const next = nextOccurrence(task.recurrence, from)
  if (!next) return done
  let fresh = bracket(setDate(setDate(setDate(line, 'done', ''), 'cancelled', ''), 'created', ''), ' ')
  if (task.due || task.scheduled || task.start) {
    if (whenDone) {
      const anchor = task.due ?? task.scheduled ?? task.start
      fresh = shiftDates(fresh, daysBetween(anchor, next))
    } else fresh = shiftDates(fresh, daysBetween(from, next))
  } else fresh = setDate(fresh, 'due', next)
  return `${fresh}\n${done}`
}

/**
 * A note's text with one task line changed. The line is the one drawn, wherever
 * it has moved to; failing that, the only line left with its description, since
 * a field may have changed since. Two lines with that description are not told
 * apart by guessing, and a repeat makes exactly that: the text stays as it is.
 *
 * @param {string} text
 * @param {{lineNo: number, line: string, description: string}} task
 * @param {(line: string) => string} change
 */
export function changeTask(text, task, change) {
  const lines = text.split('\n')
  const only = (test) => {
    const found = lines.flatMap((line, index) => (test(line) ? [index] : []))
    return found.length === 1 ? found[0] : -1
  }
  let at = lines[task.lineNo] === task.line ? task.lineNo : only((line) => line === task.line)
  if (at < 0) at = only((line) => parseTaskLine(line)?.description === task.description)
  if (at < 0) return text
  lines[at] = change(lines[at])
  return lines.join('\n')
}

/** Each task of a note, where the renderer draws one, by line number. */
function linesOfTasks(text) {
  if (!text.includes('[')) return []
  const width = (node) => (node.children ? node.children.reduce((sum, child) => sum + width(child), 0) : node.v.length)
  const found = []
  let offset = 0
  for (const node of renderMarkdown(text, {tasks: true})) {
    if (node.t === 'item' && node.children.some((child) => String(child.c ?? '').split(' ').includes('md-task'))) {
      found.push(offset)
    }
    offset += width(node)
  }
  const lines = text.split('\n')
  let at = 0
  let number = 0
  return found.map((start) => {
    while (at + lines[number].length < start) at += lines[number++].length + 1
    return {lineNo: number, line: lines[number]}
  })
}

/** Remembered per note until it is written again: this runs on every draw. */
const known = new Map()

function noteTasks(entry) {
  const key = `${entry.updated}:${(entry.text ?? '').length}`
  const held = known.get(entry.id)
  if (held?.key === key && entry.id !== undefined) return held.tasks
  const text = entry.text ?? ''
  const properties = propertiesOf(text)
  const noteTitle = labelOf(entry)
  const project = tagsIn(text).some((tag) => tag === 'project' || tag.startsWith('project/')) ? noteTitle : ''
  const tasks = linesOfTasks(text).flatMap(({lineNo, line}) => {
    const task = parseTaskLine(line)
    return task ? [{...task, noteId: entry.id, noteTitle, project, area: properties.get('area') ?? '', lineNo, line}] : []
  })
  known.set(entry.id, {key, tasks})
  return tasks
}

/**
 * Every task in the library, archived notes out.
 *
 * @param {Array<{id: string, text?: string, archived?: boolean, updated?: number}>} entries
 */
export const allTasks = (entries) => entries.filter((entry) => !entry.archived).flatMap(noteTasks)

export const isOpen = (task) => task.status === 'todo' || task.status === 'doing'

/** The earliest date due of a note's open tasks, or '' when there is none. */
export function firstDue(entry) {
  return noteTasks(entry).filter((task) => isOpen(task) && task.due).map((task) => task.due).sort()[0] ?? ''
}

export const LISTS = [
  {id: 'today', label: 'Today'},
  {id: 'upcoming', label: 'Upcoming'},
  {id: 'anytime', label: 'Anytime'},
  {id: 'someday', label: 'Someday'},
  {id: 'logbook', label: 'Logbook'},
]

/** Which of Things' lists a task is on. */
export function listOf(task, today) {
  if (!isOpen(task)) return 'logbook'
  if (task.someday) return 'someday'
  const begins = task.scheduled ?? task.start
  if ((task.due && task.due <= today) || (begins && begins <= today)) return 'today'
  return task.due || begins ? 'upcoming' : 'anytime'
}

/** The date a task is listed under on Upcoming. */
export const nextDate = (task) => task.scheduled ?? task.start ?? task.due ?? ''

/** Most urgent first: priority, then date, then what it says. */
export function sortTasks(tasks) {
  return [...tasks].sort(
    (a, b) =>
      b.priority - a.priority ||
      (a.due ?? '9').localeCompare(b.due ?? '9') ||
      nextDate(a).localeCompare(nextDate(b)) ||
      a.description.localeCompare(b.description),
  )
}

/** Tasks under headings, areas together, a heading's order by name. */
export function groupTasks(tasks) {
  const groups = new Map()
  for (const task of tasks) {
    const heading = task.area ? `${task.area} · ${task.noteTitle}` : task.noteTitle
    if (!groups.has(heading)) groups.set(heading, {heading, area: task.area, tasks: []})
    groups.get(heading).tasks.push(task)
  }
  return [...groups.values()].sort(
    (a, b) => Number(!a.area) - Number(!b.area) || a.heading.localeCompare(b.heading),
  )
}

/** A cycle is a calendar week, named by its Monday. */
export function cycleOf(day) {
  return addDays(day, -((weekdayOf(day) + 6) % 7))
}

/** The Monday after the one a day is in. */
export const nextCycle = (day) => addDays(cycleOf(day), 7)

/** A cycle's name beside today's. */
export function cycleLabel(cycle, today) {
  const offset = daysBetween(cycleOf(today), cycle) / 7
  if (offset === 0) return 'This week'
  if (offset === 1) return 'Next week'
  if (offset === -1) return 'Last week'
  return `Week of ${cycle}`
}

/**
 * A timeline's bars inside a span of days.
 *
 * @param {Array<object>} tasks
 * @param {string} first the span's first day
 * @param {number} days
 * @returns {Array<{task: object, from: number, to: number}>} zero based, inclusive, cut to the span
 */
export function timelineBars(tasks, first, days) {
  const bars = []
  for (const task of tasks) {
    const start = task.start ?? task.scheduled ?? task.due
    const end = task.due ?? task.scheduled ?? task.start
    if (!start) continue
    const [lo, hi] = start <= end ? [start, end] : [end, start]
    const from = daysBetween(first, lo)
    const to = daysBetween(first, hi)
    if (to < 0 || from >= days) continue
    bars.push({task, from: Math.max(0, from), to: Math.min(days - 1, to)})
  }
  return bars
}

/**
 * Reminders whose moment has come. One older than a day is a task missed, which
 * the Today list already says, not news.
 *
 * @param {Array<object>} tasks
 * @param {Date} now
 * @param {Set<string>} fired
 */
export function dueReminders(tasks, now, fired) {
  const two = (n) => String(n).padStart(2, '0')
  const moment = `${dayOf(now.getTime())} ${two(now.getHours())}:${two(now.getMinutes())}`
  const dayAgo = `${dayOf(now.getTime() - 86_400_000)} ${two(now.getHours())}:${two(now.getMinutes())}`
  return tasks.filter(
    (task) => isOpen(task) && task.remind && task.remind <= moment && task.remind >= dayAgo && !fired.has(reminderKey(task)),
  )
}

export const reminderKey = (task) => `${task.noteId}:${task.description}:${task.remind}`

/* -------------------------------------------------------------- quick add */

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const MONTH = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?'
// Three letters only where the word means nothing else: "sat" and "sun" do.
const DAY_NAMES = {
  monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3, thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5, saturday: 6, sunday: 0,
}
const DAY_NAME = Object.keys(DAY_NAMES).join('|')

function dayFromMonth(month, date, today) {
  const index = MONTHS.indexOf(month.slice(0, 3).toLowerCase())
  const year = Number(today.slice(0, 4))
  if (date < 1 || date > MONTH_LENGTH(year, index)) return null
  const day = dayOf(new Date(year, index, date).getTime())
  return day < today ? dayOf(new Date(year + 1, index, date).getTime()) : day
}

// Longest and most particular first, so "next friday" is not read as "friday".
const DATE_WORDS = [
  [/\b(\d{4}-\d{2}-\d{2})\b/, (m) => m[1]],
  [/\b(?:today|tonight)\b/i, (m, today) => today],
  [/\b(?:tomorrow|tmrw)\b/i, (m, today) => addDays(today, 1)],
  [/\bin (\d{1,3}) days?\b/i, (m, today) => addDays(today, Number(m[1]))],
  [/\bin (\d{1,3}) weeks?\b/i, (m, today) => addDays(today, Number(m[1]) * 7)],
  [/\bin (\d{1,3}) months?\b/i, (m, today) => addMonths(today, Number(m[1]))],
  [/\bnext week\b/i, (m, today) => nextCycle(today)],
  [/\bnext month\b/i, (m, today) => addMonths(today, 1)],
  [
    new RegExp(`\\b(?:on )?(\\d{1,2})(?:st|nd|rd|th)? (${MONTH})\\b`, 'i'),
    (m, today) => dayFromMonth(m[2], Number(m[1]), today),
  ],
  [
    new RegExp(`\\b(?:on )?(${MONTH}) (\\d{1,2})(?:st|nd|rd|th)?\\b`, 'i'),
    (m, today) => dayFromMonth(m[1], Number(m[2]), today),
  ],
  [
    new RegExp(`\\bnext (${DAY_NAME})\\b`, 'i'),
    (m, today) => addDays(nextCycle(today), (DAY_NAMES[m[1].toLowerCase()] + 6) % 7),
  ],
  [
    new RegExp(`\\b(?:on |this )?(${DAY_NAME})\\b`, 'i'),
    (m, today) => addDays(today, ((DAY_NAMES[m[1].toLowerCase()] - weekdayOf(today) + 6) % 7) + 1),
  ],
]

const REPEAT_WORDS = {daily: 'every day', weekly: 'every week', monthly: 'every month', yearly: 'every year'}

/**
 * What a typed line says, the way Todoist reads one:
 * "call mum tomorrow 3pm #home p1 every week". What it recognises comes out of
 * the words and what is left is the task. Words in "double quotes" are kept as
 * they are, for a task really about Friday.
 *
 * @param {string} input
 * @param {Date} now
 * @returns {{line: string, description: string, due: string, time: string, priority: number, recurrence: string}}
 */
export function parseQuickAdd(input, now) {
  const today = dayOf(now.getTime())
  const kept = []
  let rest = String(input).replace(/\s+/g, ' ').replace(/"([^"]*)"/g, (_, words) => {
    kept.push(words)
    return `\uE000${kept.length - 1}\uE000`
  })
  const take = (pattern) => {
    const match = pattern.exec(rest)
    if (match) rest = `${rest.slice(0, match.index)} ${rest.slice(match.index + match[0].length)}`
    return match
  }

  let recurrence = ''
  const repeat = take(new RegExp(`\\b(every(?: \\d+)? (?:days?|weeks?|months?|years?)|every (?:weekday|${WEEKDAYS.join('|')}))( when done)?\\b`, 'i'))
  if (repeat) recurrence = `${repeat[1]}${repeat[2] ?? ''}`.toLowerCase()
  else {
    const word = take(/\b(daily|weekly|monthly|yearly)\b/i)
    if (word) recurrence = REPEAT_WORDS[word[1].toLowerCase()]
  }

  const rank = take(/(?:^|\s)p([1-4])(?=\s|$)/i)
  const priority = rank ? [5, 4, 3, NO_PRIORITY_RANK][Number(rank[1]) - 1] : NO_PRIORITY_RANK

  let time = ''
  const two = (n) => String(n).padStart(2, '0')
  const clock = take(/\b(?:at )?(\d{1,2})(?::(\d{2}))? ?(am|pm)\b/i)
  if (clock && Number(clock[1]) >= 1 && Number(clock[1]) <= 12 && Number(clock[2] ?? 0) < 60) {
    const hour = (Number(clock[1]) % 12) + (clock[3].toLowerCase() === 'pm' ? 12 : 0)
    time = `${two(hour)}:${clock[2] ?? '00'}`
  } else if (!clock) {
    const plain = take(/\b(?:at )?(\d{1,2}):(\d{2})\b/) ?? take(/\bat (\d{1,2})\b/)
    if (plain && Number(plain[1]) < 24 && Number(plain[2] ?? 0) < 60) time = `${two(Number(plain[1]))}:${plain[2] ?? '00'}`
  }

  let due = ''
  for (const [pattern, day] of DATE_WORDS) {
    const match = pattern.exec(rest)
    const found = match && day(match, today)
    if (found) {
      take(pattern)
      due = found
      break
    }
  }
  // A time alone is the next time the clock says it.
  if (time && !due) {
    const clockNow = `${two(now.getHours())}:${two(now.getMinutes())}`
    due = time > clockNow ? today : addDays(today, 1)
  }

  const restore = (text) => text.replace(/\uE000(\d+)\uE000/g, (_, index) => kept[Number(index)])
  const description = restore(rest).replace(/\s+/g, ' ').trim()
  // Nothing but a date is still something typed: it stays as the task.
  if (!description) {
    const plain = String(input).replace(/\s+/g, ' ').trim()
    return {line: `- [ ] ${plain}`, description: plain, due: '', time: '', priority: NO_PRIORITY_RANK, recurrence: ''}
  }
  let line = `- [ ] ${description}`
  if (time) line += ` ⏰ ${due} ${time}`
  const emoji = PRIORITIES.find((candidate) => candidate.rank === priority)?.emoji
  if (emoji) line += ` ${emoji}`
  if (recurrence) line += ` 🔁 ${recurrence}`
  if (due) line += ` 📅 ${due}`
  return {line, description, due, time, priority, recurrence}
}

/** A note's text with a task added at its end. */
export const addTaskLine = (text, line) => `${text.replace(/\n*$/, '')}\n${line}\n`

/** The note quick add writes to. */
export const TASKS_NOTE = 'Tasks'
