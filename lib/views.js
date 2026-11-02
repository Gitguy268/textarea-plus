// The sidebar's views, and the tabs above the note.
//
// Each view is a question asked of the library rather than a place a note
// is filed: Projects is every note tagged #project, Inbox every note nobody
// has named or filed yet. A note belongs to whichever views its own text
// says it does, so the same folder read by textarea-cli or Obsidian sorts
// itself the same way, and nothing about a view is ever written into a note.
//
// Pure, in the shape filter.js and switcher.js are pure: entries in, entries
// out, no document and no storage - which is how the views and the tab
// bookkeeping are unit tested without a browser. lib/shell.js draws them.

import {matchNote, parseQuery, tagsOf} from './filter.js'
import {titleOf} from './front-matter.js'
import {tasksIn} from './markdown.js'
import {propertiesOf, setProperty} from './properties.js'

/**
 * The sidebar, top to bottom. A view with a query lists the notes it
 * matches; Today opens a note instead of listing any.
 */
export const VIEWS = [
  {id: 'today', label: 'Today', key: 't'},
  {id: 'inbox', label: 'Inbox', key: 'i'},
  {id: 'notes', label: 'Notes', key: 'n'},
  {id: 'tasks', label: 'Tasks', key: 'k'},
  {id: 'projects', label: 'Projects', key: 'p', query: '#project'},
  {id: 'meetings', label: 'Meetings', key: 'm', query: '#meeting'},
  {id: 'wiki', label: 'Wiki', key: 'w', query: '#wiki'},
]

/** @returns {string} a view id the sidebar knows, 'notes' for anything else */
export const viewOf = (stored) =>
  VIEWS.some((view) => view.id === stored) || /^(tag|folder):./.test(stored ?? '') ? stored : 'notes'

/**
 * The day's note title, on the reader's own calendar: `toISOString` would
 * give tomorrow's date to anyone east of Greenwich after midnight UTC. The
 * same YYYY-MM-DD textarea-cli's `text today` writes, so both find one note.
 *
 * @param {Date} date
 */
export function dayTitle(date) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** A new day's note, as textarea-cli starts one. */
export const dayText = (date) => `# ${dayTitle(date)}\n`

/**
 * The day's note, if there is one: the newest note whose heading is the
 * date. Archived notes count - archiving today's note does not make a
 * second one.
 *
 * @param {Array<{text?: string}>} entries newest first, as listDocuments gives them
 * @param {Date} date
 */
export function findDay(entries, date) {
  const title = dayTitle(date)
  return entries.find((entry) => titleOf(entry.text ?? '') === title) ?? null
}

/** A note's name in a list: its title, or its first words when it has none. */
export function labelOf(entry) {
  const text = entry.text ?? ''
  if (titleOf(text) !== 'Textarea') return titleOf(text)
  const line = text.split('\n').find((candidate) => candidate.trim() !== '')
  return line ? line.replace(/^#+\s*/, '').trim() : 'Empty note'
}

/** A note nobody has named: no `# heading`, so titleOf falls back. */
const untitled = (entry) => titleOf(entry.text ?? '') === 'Textarea'

const hasOpenTask = (entry) => tasksIn(entry.text ?? '').some((task) => !task.done)

/**
 * The notes one view lists, in the order they came in. Archived notes are
 * out of every view, the way they are out of My documents until asked for.
 *
 * @param {Array<{text?: string, archived?: boolean}>} entries
 * @param {string} id a view id
 */
export function viewEntries(entries, id) {
  const live = entries.filter((entry) => !entry.archived)
  if (id.startsWith('tag:')) {
    const query = parseQuery(`#${id.slice(4)}`)
    return live.filter((entry) => matchNote(entry, query))
  }
  if (id.startsWith('folder:')) {
    const path = id.slice(7)
    return live.filter((entry) => {
      const folder = folderOf(entry.text)
      return folder === path || folder.startsWith(`${path}/`)
    })
  }
  const view = VIEWS.find((candidate) => candidate.id === id)
  if (view?.query) {
    const query = parseQuery(view.query)
    return live.filter((entry) => matchNote(entry, query))
  }
  switch (id) {
    case 'inbox':
      // Captures land here - `text buy milk`, a line typed into a new note -
      // and leave once they get a heading or are tagged into a view.
      return live.filter((entry) => {
        // A blank page is not a capture: every new note starts as one.
        if (!(entry.text ?? '').trim()) return false
        const tags = tagsOf(entry)
        if (tags.includes('inbox')) return true
        if (folderOf(entry.text)) return false
        return untitled(entry) && !tags.some((tag) => FILED.has(tag.split('/')[0]))
      })
    case 'tasks':
      return live.filter(hasOpenTask)
    case 'today':
      return []
    default:
      return live
  }
}

/** The tags that file a note into a view of its own, and so out of Inbox. */
const FILED = new Set(VIEWS.filter((view) => view.query).map((view) => view.query.slice(1)))

// A note's folder is a line of its own text, `folder:: Work/Taxes`. The files
// stay side by side in one flat folder, because textarea and textarea-cli take
// a tracked file that moved into a subfolder for a deleted note.

/** A path made safe: no empty parts, no stray spaces, no line breaks. */
export function cleanFolder(path) {
  return String(path ?? '')
    .replace(/[\r\n]+/g, ' ')
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean)
    .join('/')
}

/** @returns {string} the note's folder path, '' when it has none */
export const folderOf = (text) => cleanFolder(propertiesOf(text).get('folder'))

/**
 * The note's text filed under a folder, or taken out for an empty path.
 *
 * @param {string} text
 * @param {string} path
 */
export const setFolder = (text, path) => setProperty(text, 'folder', cleanFolder(path))

/**
 * Each note's paths, folded into a tree on '/'. A node counts the notes at or
 * below it, each note once however many of its tags sit under that node, and
 * a parent exists even when no note sits directly in it.
 *
 * @param {Array<string[]>} perNote one list of paths per note
 * @returns {Array<{name: string, path: string, count: number, children: Array<object>}>} sorted by name
 */
function treeOf(perNote) {
  const root = {children: new Map()}
  for (const paths of perNote) {
    const counted = new Set()
    for (const path of paths) {
      let node = root
      const walked = []
      for (const part of path.split('/').filter(Boolean)) {
        walked.push(part)
        const here = walked.join('/')
        if (!node.children.has(part)) node.children.set(part, {name: part, path: here, count: 0, children: new Map()})
        node = node.children.get(part)
        if (!counted.has(here)) {
          counted.add(here)
          node.count++
        }
      }
    }
  }
  const list = (node) =>
    [...node.children.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((child) => ({...child, children: list(child)}))
  return list(root)
}

const live = (entries) => entries.filter((entry) => !entry.archived)

/** The library's tags as a tree, Bear's way: `#work/taxes` sits inside `work`. */
export const tagTree = (entries) => treeOf(live(entries).map((entry) => tagsOf(entry)))

/** The library's folders as a tree. */
export const folderTree = (entries) => treeOf(live(entries).map((entry) => [folderOf(entry.text)].filter(Boolean)))

/**
 * A page link card's second line: the first line of the note that is not its
 * heading, its tags or a property.
 *
 * @param {{text?: string}} entry
 */
export function cardPreview(entry) {
  const lines = String(entry.text ?? '').split('\n')
  const line = lines.find((candidate) => {
    const trimmed = candidate.trim()
    return trimmed && !trimmed.startsWith('# ') && !/^[\p{L}][^:\n]*::/u.test(trimmed) && !/^(#\S+\s*)+$/.test(trimmed)
  })
  const clean = (line ?? '').trim()
  return clean.length > 90 ? `${clean.slice(0, 89)}…` : clean
}

/** The heading a view's list goes under. */
export function viewLabel(id) {
  if (id.startsWith('tag:')) return `#${id.slice(4)}`
  if (id.startsWith('folder:')) return id.slice(7)
  return VIEWS.find((view) => view.id === id)?.label ?? 'Notes'
}

/**
 * The open tabs: note ids, in the order the reader opened them.
 *
 * Opening a note adds its tab after the current one, the way a browser opens
 * a link; a note already open keeps its place.
 *
 * @param {string[]} tabs
 * @param {string} id the note being opened
 * @param {string | null} current the note on screen before it
 */
export function openTab(tabs, id, current = null) {
  if (tabs.includes(id)) return tabs
  const at = current ? tabs.indexOf(current) : -1
  if (at < 0) return [...tabs, id]
  return [...tabs.slice(0, at + 1), id, ...tabs.slice(at + 1)]
}

/**
 * Close a tab. When it was the note on screen, the tab that takes its place
 * is the one to its right, or the left when it was the last - the browser's
 * rule again.
 *
 * @param {string[]} tabs
 * @param {string} id
 * @param {string | null} current
 * @returns {{tabs: string[], next: string | null}} next is null when the screen stays as it is
 */
export function closeTab(tabs, id, current) {
  const at = tabs.indexOf(id)
  if (at < 0) return {tabs, next: null}
  const left = tabs.filter((tab) => tab !== id)
  if (id !== current) return {tabs: left, next: null}
  return {tabs: left, next: left[Math.min(at, left.length - 1)] ?? null}
}

/**
 * The tabs whose notes still exist, plus the one on screen: a note trashed
 * here or removed by sync loses its tab, and a tab list read from storage
 * can only ever name notes.
 *
 * @param {unknown} tabs whatever storage held
 * @param {Set<string>} ids every note in the library
 * @param {string | null} current
 */
export function liveTabs(tabs, ids, current) {
  const list = Array.isArray(tabs) ? tabs.filter((tab) => typeof tab === 'string' && ids.has(tab)) : []
  const unique = [...new Set(list)]
  if (current && ids.has(current) && !unique.includes(current)) unique.push(current)
  return unique
}
