import assert from 'node:assert/strict'
import {test} from 'node:test'

import {
  boardColumns,
  columnsOf,
  databaseOf,
  monthDays,
  newDatabaseText,
  newRowText,
  parseRowQuery,
  queryValue,
  rowsOf,
  shiftDay,
  sortRows,
} from '../../lib/database.js'
import {tagsIn} from '../../lib/markdown.js'
import {propertiesOf, setProperty, validKey} from '../../lib/properties.js'

const note = (id, text, extra = {}) => ({id, updated: 1, created: 1, text, ...extra})
const ids = (rows) => rows.map((row) => row.id)
const NOW = new Date(2026, 10, 1, 12)

test('properties are lines of the text, and code is not a property', () => {
  const text = '# T\n\nStatus:: Doing\ndue:: 2026-11-03\nempty::\nstd::vector is a type\n\n```\nowner:: nobody\n```\nstatus:: second\n'
  const properties = propertiesOf(text)
  assert.equal(properties.get('status'), 'Doing', 'first line of a name wins, whatever its case')
  assert.equal(properties.get('due'), '2026-11-03')
  assert.equal(properties.get('empty'), '')
  assert.equal(properties.has('owner'), false, 'a fence is code')
  assert.equal(properties.has('std'), false, 'no space after the colons, no property')
  assert.ok(validKey('due date'))
  assert.ok(!validKey('a:b'))
  assert.ok(!validKey('1st'))
})

test('setting a property changes one line and no other byte', () => {
  const text = '# T\n\nbody  with  spaces\n\nStatus:: Todo\nmore\n'
  assert.equal(setProperty(text, 'status', 'Done'), '# T\n\nbody  with  spaces\n\nStatus:: Done\nmore\n', 'in place, in its own spelling')
  assert.equal(setProperty(text, 'status', ''), '# T\n\nbody  with  spaces\n\nmore\n', 'empty takes the line out')
  assert.equal(setProperty('# T\n', 'due', '2026-11-03'), '# T\n\ndue:: 2026-11-03\n', 'new goes at the end')
  assert.equal(setProperty('# T\n\na:: 1\n', 'b', '2'), '# T\n\na:: 1\nb:: 2\n', 'beside the last property')
  assert.equal(setProperty('', 'a', '1'), 'a:: 1\n')
  assert.equal(setProperty('x\n', 'a', ''), 'x\n', 'nothing to take out')
  assert.equal(setProperty('a:: 1\n', 'a', 'two\nlines'), 'a:: two lines\n', 'a value stays on its line')
  const fenced = '```\nstatus:: code\n```\n'
  assert.equal(setProperty(fenced, 'status', 'real'), `${fenced}\nstatus:: real\n`, 'code is never rewritten')
})

test('a database is a note, and its query does not tag it', () => {
  const text = newDatabaseText('Active', '#project is:task', 'board')
  assert.equal(text, '# Active\n\nview:: board\nquery:: `#project is:task`\n')
  assert.deepEqual(tagsIn(text), [])
  const database = databaseOf(text)
  assert.equal(database.layout, 'board')
  assert.equal(database.query, '#project is:task')
  assert.equal(database.group, 'status')
  assert.equal(database.date, 'due')
  assert.equal(databaseOf('# T\n\nview:: board\n'), null, 'no query')
  assert.equal(databaseOf('# T\n\nview:: pie\nquery:: `x`\n'), null, 'no such layout')
  assert.equal(databaseOf('# T\nquery:: `x`\n'), null, 'no view')
  assert.equal(queryValue('a `b` '), '`a b`')
  assert.equal(databaseOf(setProperty(text, 'query', queryValue('#x'))).query, '#x')
})

test('a query finds notes by tag, property, task, due date and folder', () => {
  const library = [
    note('a', '# A\n#project\nstatus:: Doing\ndue:: 2026-11-03\n'),
    note('b', '# B\n#project\nstatus:: done\ndue:: 2026-12-25\n- [ ] open\n'),
    note('c', '# C\nstatus:: In review\ndue:: 2026-10-01\nfolder:: Work/Plans\n- [x] shut\n'),
    note('d', '# D\n#project\ndue:: not a date\nhttp://example.com\n'),
    note('e', '# E\n#project\n', {archived: true}),
    note('f', newDatabaseText('View', '#project status:doing', 'table')),
  ]
  const find = (query) => ids(rowsOf(library, query, NOW))
  assert.deepEqual(find(''), ['a', 'b', 'c', 'd'], 'archived and databases stay out')
  assert.deepEqual(find('#project'), ['a', 'b', 'd'])
  assert.deepEqual(find('status:doing'), ['a'], 'values ignore case')
  assert.deepEqual(find('status:"in review"'), ['c'], 'a quoted value keeps its space')
  assert.deepEqual(find('#project -status:done'), ['a', 'd'], 'a note with no value is not that value')
  assert.deepEqual(find('is:task'), ['b'], 'an open task, not a ticked one')
  assert.deepEqual(find('due:<7d'), ['a', 'c'], 'within seven days or overdue')
  assert.deepEqual(find('due:>7d'), ['b'])
  assert.deepEqual(find('due:overdue'), ['c'])
  assert.deepEqual(find('due:2026-11-03'), ['a'])
  assert.deepEqual(find('due:<2026-11-03'), ['c'])
  assert.deepEqual(find('due:>2026-11-03'), ['b'])
  assert.deepEqual(find('folder:work'), ['c'], 'a folder and what is under it')
  assert.deepEqual(find('#project due:<7d'), ['a'], 'every token has to hold')
  assert.deepEqual(find('is:archived'), ['e'], 'My documents tokens still work')
  assert.deepEqual(find('http://example.com'), ['d'], 'an address is a phrase')
  assert.deepEqual(parseRowQuery('due:soon').wanted, [{key: 'due', value: 'soon'}], 'not a date rule, so a value')
})

test('relative dates go by the calendar', () => {
  assert.equal(shiftDay('2026-12-31', 1), '2027-01-01')
  assert.equal(shiftDay('2026-03-01', -1), '2026-02-28')
  assert.equal(shiftDay('2026-10-24', 7), '2026-10-31', 'across a clock change')
  const dueToday = [note('a', 'due:: 2026-11-01\n')]
  assert.deepEqual(ids(rowsOf(dueToday, 'due:today', NOW)), ['a'])
  assert.deepEqual(ids(rowsOf(dueToday, 'due:overdue', NOW)), [])
})

test('rows sort by a property, empties last either way', () => {
  const rows = rowsOf(
    [note('a', '# A\nn:: 10\n'), note('b', '# B\nn:: 9\n'), note('c', '# C\n'), note('d', '# 2 D\nn:: 9\n')],
    '',
    NOW,
  )
  assert.deepEqual(ids(sortRows(rows, '')), ['d', 'a', 'b', 'c'], 'by title')
  assert.deepEqual(ids(sortRows(rows, 'n')), ['d', 'b', 'a', 'c'], 'numbers as numbers, then title')
  assert.deepEqual(ids(sortRows(rows, '-n')), ['a', 'd', 'b', 'c'], 'backwards, still empties last')
})

test('columns come from the database, or from what the rows have', () => {
  const rows = rowsOf([note('a', 'b:: 1\nfolder:: x\n'), note('b', 'a:: 2\nb:: 3\n')], '', NOW)
  assert.deepEqual(columnsOf(rows, {columns: []}), ['a', 'b'], 'a folder has its own place')
  assert.deepEqual(columnsOf(rows, {columns: ['z']}), ['z'])
})

test('a board lists named columns, then found values, then none', () => {
  const rows = rowsOf(
    [note('a', 'status:: Doing\n'), note('b', 'status:: doing\n'), note('c', 'status:: Blocked\n'), note('d', '# D\n')],
    '',
    NOW,
  )
  const columns = boardColumns(rows, {group: 'status', options: ['Todo', 'Doing']})
  assert.deepEqual(columns.map((column) => column.label), ['Todo', 'Doing', 'Blocked', 'No value'])
  assert.deepEqual(ids(columns[0].rows), [], 'a named column stands empty')
  assert.deepEqual(ids(columns[1].rows), ['a', 'b'], 'one column whatever the case')
  assert.deepEqual(boardColumns([], {group: 'status', options: []}), [])
})

test('a month is 42 days from a Monday', () => {
  const days = monthDays(2026, 10)
  assert.equal(days.length, 42)
  assert.equal(days[0].day, '2026-10-26')
  assert.equal(new Date(2026, 9, 26).getDay(), 1)
  assert.equal(days[0].inMonth, false)
  assert.equal(days[6].day, '2026-11-01')
  assert.equal(days[6].inMonth, true)
  assert.equal(days[35].day, '2026-11-30')
  assert.equal(days[36].inMonth, false)
})

test('a new row is found by the query that made it', () => {
  const database = databaseOf(newDatabaseText('V', '#Project/x status:"in review" folder:Work is:task -owner:me due:2026-11-03 word', 'table'))
  const text = newRowText(database, ' New ', {priority: 'high'})
  assert.equal(
    text,
    '# New\n\n- [ ] \n\n#project/x\n\nstatus:: in review\nfolder:: Work\ndue:: 2026-11-03\npriority:: high\n',
  )
  const plain = databaseOf(newDatabaseText('V', '#a', 'table'))
  assert.deepEqual(ids(rowsOf([note('n', newRowText(plain, ''))], '#a', NOW)), ['n'])
  assert.ok(newRowText(plain, '').startsWith('# Untitled\n'))
})
