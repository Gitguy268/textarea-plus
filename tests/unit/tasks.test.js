import assert from 'node:assert/strict'
import {test} from 'node:test'

import {rowsOf} from '../../lib/database.js'
import {tasksIn} from '../../lib/markdown.js'
import {
  addTaskLine,
  allTasks,
  changeTask,
  cycleLabel,
  cycleOf,
  dueReminders,
  firstDue,
  groupTasks,
  listOf,
  nextCycle,
  nextOccurrence,
  nextPriority,
  parseQuickAdd,
  parseTaskLine,
  reminderKey,
  setDate,
  setPriority,
  setStatus,
  shiftDates,
  sortTasks,
  timelineBars,
  toggleSomeday,
} from '../../lib/tasks.js'

// A Sunday.
const TODAY = '2026-11-01'
const NOW = new Date(2026, 10, 1, 12, 0)

test('a line of Obsidian Tasks syntax comes apart', () => {
  const task = parseTaskLine(
    '  - [/] call mum #home ⏰ 2026-11-02 15:00 🔺 🔁 every week 📅 2026-11-02 ⏳ 2026-11-01 🛫 2026-10-30 ➕ 2026-10-01',
  )
  assert.equal(task.status, 'doing')
  assert.equal(task.description, 'call mum #home')
  assert.equal(task.due, '2026-11-02')
  assert.equal(task.scheduled, '2026-11-01')
  assert.equal(task.start, '2026-10-30')
  assert.equal(task.created, '2026-10-01')
  assert.equal(task.priority, 5)
  assert.equal(task.recurrence, 'every week')
  assert.equal(task.remind, '2026-11-02 15:00')
  assert.equal(parseTaskLine('- [ ] plain').priority, 2, 'no priority sorts between medium and low')
  assert.equal(parseTaskLine('- [X] shouted').status, 'done')
  assert.equal(parseTaskLine('- [-] off').status, 'cancelled')
  assert.equal(parseTaskLine('- [?] mine'), null, 'a status it does not know')
  assert.equal(parseTaskLine('a line'), null)
  assert.ok(parseTaskLine('- [ ] later #someday').someday)
  assert.ok(!parseTaskLine('- [ ] #somedayish').someday)
})

test('setting a field touches that field', () => {
  const line = '- [ ] a  b #tag ^block'
  assert.equal(setDate(line, 'due', '2026-11-02'), '- [ ] a  b #tag 📅 2026-11-02 ^block', 'before a block id')
  const dated = '- [ ] a 📅 2026-11-02 🔼'
  assert.equal(setDate(dated, 'due', '2026-11-03'), '- [ ] a 📅 2026-11-03 🔼', 'in place')
  assert.equal(setDate(dated, 'due', ''), '- [ ] a 🔼', 'taken out')
  assert.equal(setPriority(dated, 5), '- [ ] a 📅 2026-11-02 🔺')
  assert.equal(setPriority(dated, 2), '- [ ] a 📅 2026-11-02', 'none')
  assert.equal(setPriority('- [ ] a', 1), '- [ ] a 🔽')
  assert.equal(toggleSomeday('- [ ] a'), '- [ ] a #someday')
  assert.equal(toggleSomeday('- [ ] a #someday'), '- [ ] a')
  const seen = new Set()
  let rank = 2
  for (let i = 0; i < 6; i++) {
    seen.add(rank)
    rank = nextPriority(rank)
  }
  assert.equal(seen.size, 6, 'every priority comes round')
  assert.equal(rank, 2)
})

test('a repeat knows its next date', () => {
  assert.equal(nextOccurrence('every day', '2026-12-31'), '2027-01-01')
  assert.equal(nextOccurrence('every 2 weeks', '2026-11-01'), '2026-11-15')
  assert.equal(nextOccurrence('every month', '2026-01-31'), '2026-02-28', 'cut to the shorter month')
  assert.equal(nextOccurrence('every year', '2028-02-29'), '2029-02-28')
  assert.equal(nextOccurrence('every 3 months when done', '2026-11-01'), '2027-02-01')
  assert.equal(nextOccurrence('every monday', '2026-11-01'), '2026-11-02')
  assert.equal(nextOccurrence('every sunday', '2026-11-01'), '2026-11-08', 'never the same day')
  assert.equal(nextOccurrence('every weekday', '2026-11-06'), '2026-11-09', 'over a weekend')
  assert.equal(nextOccurrence('every 0 days', TODAY), null)
  assert.equal(nextOccurrence('whenever', TODAY), null)
})

test('finishing writes the date, and a repeat makes the next above it', () => {
  assert.equal(setStatus('- [ ] a', 'x', TODAY), '- [x] a ✅ 2026-11-01')
  assert.equal(setStatus('- [x] a ✅ 2026-10-01', ' ', TODAY), '- [ ] a', 'unfinished')
  assert.equal(setStatus('- [ ] a', '-', TODAY), '- [-] a ❌ 2026-11-01')
  assert.equal(setStatus('- [x] a ✅ 2026-10-01', '/', TODAY), '- [/] a')
  assert.equal(
    setStatus('- [ ] a 🔁 every week 📅 2026-11-02 ⏳ 2026-11-01 ⏰ 2026-11-02 15:00 ➕ 2026-01-01', 'x', TODAY),
    '- [ ] a 🔁 every week 📅 2026-11-09 ⏳ 2026-11-08 ⏰ 2026-11-09 15:00\n' +
      '- [x] a 🔁 every week 📅 2026-11-02 ⏳ 2026-11-01 ⏰ 2026-11-02 15:00 ➕ 2026-01-01 ✅ 2026-11-01',
  )
  assert.equal(
    setStatus('- [ ] a 🔁 every week when done 📅 2026-10-01', 'x', TODAY),
    '- [ ] a 🔁 every week when done 📅 2026-11-08\n- [x] a 🔁 every week when done 📅 2026-10-01 ✅ 2026-11-01',
    'from the day it was done',
  )
  assert.equal(
    setStatus('- [ ] a 🔁 every day', 'x', TODAY),
    '- [ ] a 🔁 every day 📅 2026-11-02\n- [x] a 🔁 every day ✅ 2026-11-01',
    'a repeat with no date gets one',
  )
  assert.equal(setStatus('- [x] a 🔁 every day ✅ 2026-10-01', 'x', TODAY), '- [x] a 🔁 every day ✅ 2026-11-01', 'already done')
  assert.equal(setStatus('- [ ] a 🔁 sometimes', 'x', TODAY), '- [x] a 🔁 sometimes ✅ 2026-11-01', 'a rule it cannot read')
  assert.equal(shiftDates('- [ ] a 📅 2026-11-02 🛫 2026-11-01', 1), '- [ ] a 📅 2026-11-03 🛫 2026-11-02')
})

test('a change finds its line, or leaves the note alone', () => {
  const text = '# T\n\n- [ ] one\n- [ ] two\n'
  const shout = (line) => `${line}!`
  const two = {lineNo: 3, line: '- [ ] two', description: 'two'}
  assert.equal(changeTask(text, two, shout), '# T\n\n- [ ] one\n- [ ] two!\n')
  assert.equal(changeTask(`x\n${text}`, two, shout), 'x\n# T\n\n- [ ] one\n- [ ] two!\n', 'after it moved')
  assert.equal(changeTask(text, {lineNo: 3, line: '- [ ] gone', description: 'gone'}, shout), text, 'no longer there')
  assert.equal(changeTask(text.replace('two', 'two 🔺'), two, shout), text.replace('two', 'two 🔺!'), 'a field changed since')
  // A repeat leaves two lines with one description: the exact line decides.
  const copies = '- [ ] w 📅 2026-11-02\n- [x] w 📅 2026-11-01 ✅ 2026-11-01\n'
  assert.equal(
    changeTask(copies, {lineNo: 0, line: '- [x] w 📅 2026-11-01 ✅ 2026-11-01', description: 'w'}, shout),
    '- [ ] w 📅 2026-11-02\n- [x] w 📅 2026-11-01 ✅ 2026-11-01!\n',
    'by its text, not the line number it had',
  )
  assert.equal(changeTask(copies, {lineNo: 0, line: '- [/] w', description: 'w'}, shout), copies, 'no guessing between two')
  assert.equal(addTaskLine('# T', '- [ ] a'), '# T\n- [ ] a\n')
})

test('tasks are the lines the note draws as tasks', () => {
  const text = '# P\n#project\n\narea:: Home\n\n- [ ] one 📅 2026-11-01\ntext\n```\n- [ ] code\n```\n* [/] two\n1. [x] three\n- [?] no\n- not one\n'
  const entry = {id: 'p', updated: 1, text}
  const tasks = allTasks([entry])
  assert.deepEqual(tasks.map((task) => [task.description, task.lineNo]), [['one', 5], ['two', 10], ['three', 11]])
  assert.equal(tasks.length, tasksIn(text).length, 'the same lines as the renderer')
  assert.equal(tasks[0].area, 'Home')
  assert.equal(tasks[0].project, 'P')
  assert.equal(allTasks([{...entry, archived: true}]).length, 0)
  assert.equal(firstDue(entry), '2026-11-01')
  assert.deepEqual(tasksIn('- [/] a\n- [-] b\n- [x] c').map((task) => task.done), [false, true, true], 'in progress is open')
  const again = allTasks([{...entry, text: `${text}- [ ] four\n`, updated: 2}])
  assert.equal(again.length, 4, 'a written note is read again')
})

test('the lists are Things’ lists', () => {
  const on = (rest) => listOf(parseTaskLine(`- [ ] a ${rest}`), TODAY)
  assert.equal(on(''), 'anytime')
  assert.equal(on('📅 2026-11-01'), 'today')
  assert.equal(on('📅 2026-10-01'), 'today', 'overdue')
  assert.equal(on('⏳ 2026-11-01 📅 2026-12-01'), 'today')
  assert.equal(on('🛫 2026-10-01'), 'today')
  assert.equal(on('📅 2026-11-02'), 'upcoming')
  assert.equal(on('🛫 2026-11-02'), 'upcoming')
  assert.equal(on('#someday 📅 2026-11-01'), 'someday')
  assert.equal(listOf(parseTaskLine('- [x] a'), TODAY), 'logbook')
  assert.equal(listOf(parseTaskLine('- [-] a'), TODAY), 'logbook')
  assert.equal(listOf(parseTaskLine('- [/] a'), TODAY), 'anytime')
})

test('order, groups, cycles and the timeline', () => {
  const tasks = allTasks([
    {id: 'b', updated: 1, text: '# B\n\n- [ ] low 🔽\n- [ ] top 🔺\n- [ ] soon 📅 2026-11-02\n- [ ] sooner 📅 2026-11-01\n'},
    {id: 'a', updated: 1, text: '# A\n\narea:: Home\n\n- [ ] home\n'},
  ])
  assert.deepEqual(sortTasks(tasks.slice(0, 4)).map((task) => task.description), ['top', 'sooner', 'soon', 'low'])
  assert.deepEqual(groupTasks(tasks).map((group) => group.heading), ['Home · A', 'B'], 'areas first')
  assert.equal(cycleOf('2026-11-01'), '2026-10-26')
  assert.equal(cycleOf('2026-11-02'), '2026-11-02')
  assert.equal(nextCycle('2026-11-01'), '2026-11-02')
  assert.equal(cycleLabel('2026-10-26', TODAY), 'This week')
  assert.equal(cycleLabel('2026-11-02', TODAY), 'Next week')
  assert.equal(cycleLabel('2026-10-19', TODAY), 'Last week')
  assert.equal(cycleLabel('2026-11-09', TODAY), 'Week of 2026-11-09')
  const bars = timelineBars(
    [
      parseTaskLine('- [ ] span 🛫 2026-10-20 📅 2026-11-03'),
      parseTaskLine('- [ ] day 📅 2026-11-02'),
      parseTaskLine('- [ ] back ⏳ 2026-11-03 📅 2026-11-02'),
      parseTaskLine('- [ ] past 📅 2026-10-01'),
      parseTaskLine('- [ ] none'),
    ],
    '2026-11-01',
    35,
  )
  assert.deepEqual(bars.map(({task, from, to}) => [task.description, from, to]), [['span', 0, 2], ['day', 1, 1], ['back', 1, 2]])
})

test('reminders fire once, in their day', () => {
  const tasks = allTasks([
    {
      id: 'r',
      updated: 1,
      text: '- [ ] now ⏰ 2026-11-01 11:59\n- [ ] later ⏰ 2026-11-01 12:01\n- [ ] old ⏰ 2026-10-20 09:00\n- [x] done ⏰ 2026-11-01 11:00\n- [ ] date ⏰ 2026-11-01\n',
    },
  ])
  const due = dueReminders(tasks, NOW, new Set())
  assert.deepEqual(due.map((task) => task.description), ['now', 'date'])
  assert.deepEqual(dueReminders(tasks, NOW, new Set(due.map(reminderKey))), [])
})

test('quick add reads what Todoist reads', () => {
  const add = (input) => parseQuickAdd(input, NOW).line
  assert.equal(
    add('call mum tomorrow 3pm #home p1 every week'),
    '- [ ] call mum #home ⏰ 2026-11-02 15:00 🔺 🔁 every week 📅 2026-11-02',
  )
  assert.equal(add('water plants'), '- [ ] water plants')
  assert.equal(add('pay rent today'), '- [ ] pay rent 📅 2026-11-01')
  assert.equal(add('pay rent friday'), '- [ ] pay rent 📅 2026-11-06')
  assert.equal(add('pay rent next friday'), '- [ ] pay rent 📅 2026-11-06', 'Friday of next week from a Sunday')
  assert.equal(add('pay rent on sunday'), '- [ ] pay rent 📅 2026-11-08', 'never today')
  assert.equal(add('pay rent 5 dec'), '- [ ] pay rent 📅 2026-12-05')
  assert.equal(add('pay rent jan 5'), '- [ ] pay rent 📅 2027-01-05', 'past dates are next year')
  assert.equal(add('pay rent in 3 days'), '- [ ] pay rent 📅 2026-11-04')
  assert.equal(add('pay rent in 2 weeks'), '- [ ] pay rent 📅 2026-11-15')
  assert.equal(add('pay rent next week'), '- [ ] pay rent 📅 2026-11-02')
  assert.equal(add('pay rent 2027-01-02'), '- [ ] pay rent 📅 2027-01-02')
  assert.equal(add('standup daily'), '- [ ] standup 🔁 every day')
  assert.equal(add('standup every 2 weeks'), '- [ ] standup 🔁 every 2 weeks')
  assert.equal(add('gym every monday'), '- [ ] gym 🔁 every monday')
  assert.equal(add('dentist p4'), '- [ ] dentist', 'p4 is no priority')
  assert.equal(add('dentist p2'), '- [ ] dentist ⏫')
  assert.equal(add('dentist 12:30'), '- [ ] dentist ⏰ 2026-11-01 12:30 📅 2026-11-01', 'a time still ahead')
  assert.equal(add('dentist 9am'), '- [ ] dentist ⏰ 2026-11-02 09:00 📅 2026-11-02', 'a time gone by is tomorrow')
  assert.equal(add('dentist at 14 today'), '- [ ] dentist ⏰ 2026-11-01 14:00 📅 2026-11-01')
  assert.equal(add('"friday" by rebecca black'), '- [ ] friday by rebecca black', 'quoted words stay')
  assert.equal(add('tomorrow'), '- [ ] tomorrow', 'nothing but a date stays a task')
  assert.equal(add('sat down with may'), '- [ ] sat down with may', 'words that are only words')
  assert.equal(add('read p1ease 3 dogs'), '- [ ] read p1ease 3 dogs')
  assert.equal(add('a\nb'), '- [ ] a b', 'one line')
  assert.equal(add('meet 31 feb'), '- [ ] meet 31 feb', 'no such day')
  const line = add('call mum tomorrow 3pm #home p1 every week')
  const parsed = parseTaskLine(line)
  assert.equal(parsed.description, 'call mum #home', 'what it writes it can read')
  assert.equal(parsed.recurrence, 'every week')
})

test('a database reads a task’s date as due', () => {
  const entries = [
    {id: 'a', updated: 1, created: 1, text: '# A\n\n- [ ] x 📅 2026-11-03\n- [ ] y 📅 2026-11-02\n'},
    {id: 'b', updated: 1, created: 1, text: '# B\n\n- [x] x 📅 2026-11-03\n'},
    {id: 'c', updated: 1, created: 1, text: '# C\n\ndue:: 2026-12-25\n\n- [ ] x 📅 2026-11-03\n'},
  ]
  assert.deepEqual(rowsOf(entries, 'due:<7d', NOW).map((row) => row.id), ['a'], 'open tasks; a due:: line first')
  assert.deepEqual(rowsOf(entries, 'due:2026-11-02', NOW).map((row) => row.id), ['a'], 'the earliest')
})
