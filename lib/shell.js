// The app shell: the sidebar of views on the left and the tabs above the note.
//
// Both are drawn around the editor, never into it: <main> and its article
// lay out as they always did, the shell only moves them over by the
// sidebar's width. Ctrl/Cmd+\ takes the shell away again, leaving the one
// note on a white page that textarea started as, and a narrow window keeps
// the sidebar folded until it is asked for.
//
// What each view lists is lib/views.js's answer, read from the library on
// every save the way the tasks panel reads it; this module only draws it.

import {addAttachment} from './attachments.js'
import {databaseOf, newDatabaseText} from './database.js'
import {followNote, initDatabase, LAYOUT_OPTIONS, updateDatabase} from './database-panel.js'
import {showDialog} from './dialog.js'
import {openSwitcher, setShellCommands, toggleTasksPanel} from './features.js'
import {setDropAttach} from './files.js'
import {titleOf} from './front-matter.js'
import {listDocuments, putDocument} from './library.js'
import {notify} from './notify.js'
import {article, canLeaveNote, documentId, editor, newDocument, redrawNote, save, setCardPreview, switchDocument} from './note.js'
import {openTabs, setOpenTabs, setSidebarOpen, setSidebarView, sidebarOpen, sidebarView} from './prefs.js'
import {wikiTitles} from './markdown.js'
import {on} from './signals.js'
import {createSlashMenu} from './slash.js'
import {closeTasks, followTasksNote, initTasksView, openTasks, quickAdd, updateTasksView} from './tasks-view.js'
import {countStats} from './stats.js'
import {
  VIEWS,
  cardPreview,
  closeTab,
  dayText,
  findDay,
  folderOf,
  folderTree,
  labelOf,
  liveTabs,
  openTab,
  setFolder,
  tagTree,
  viewEntries,
  viewLabel,
  viewOf,
} from './views.js'

const root = document.documentElement
const narrow = matchMedia('(max-width: 759px)')

const sidebar = document.createElement('nav')
sidebar.id = 'sidebar'
sidebar.className = 'noprint'
sidebar.setAttribute('aria-label', 'Sidebar')

const strip = document.createElement('div')
strip.id = 'tabs'
strip.className = 'noprint'
strip.setAttribute('role', 'group')
strip.setAttribute('aria-label', 'Open notes')

// The way back when the shell is off: one small button, out of the note's way.
const reopen = document.createElement('button')
reopen.id = 'shell-toggle'
reopen.className = 'noprint'
reopen.type = 'button'
reopen.textContent = '☰'
reopen.setAttribute('aria-label', 'Show the sidebar and tabs')
reopen.title = 'Show the sidebar and tabs (Ctrl/Cmd+\\)'

let entries = []
let tabs = []
let shown = null
let view = viewOf(sidebarView())

function button(className, text, onClick) {
  const element = document.createElement('button')
  element.type = 'button'
  element.className = className
  element.textContent = text
  element.addEventListener('click', onClick)
  return element
}

/** Today's note, made the way `text today` makes it when there is none yet. */
async function openToday() {
  const now = new Date()
  let day = findDay(await listDocuments(), now)
  if (!day) {
    const text = dayText(now)
    day = await putDocument({text, title: titleOf(text), words: 1})
  }
  if (day) await switchDocument(day)
}

async function showView(id) {
  if (id === 'today') {
    closeTasks()
    await openToday()
    return
  }
  view = id
  setSidebarView(id)
  if (narrow.matches) setPeek(id !== 'tasks')
  drawSidebar()
  if (id === 'tasks') await openTasks()
  else closeTasks()
}

/** To a note from a list: the note on screen may be under the Tasks screen. */
function goTo(entry) {
  closeTasks()
  return switchDocument(entry)
}

async function startNote() {
  closeTasks()
  await newDocument({ask: !(await canLeaveNote())})
}

function drawSidebar() {
  const counts = new Map(VIEWS.map(({id}) => [id, viewEntries(entries, id).length]))
  const current = documentId()

  const search = button('sidebar-search', 'Search', () => void openSwitcher())
  const hint = document.createElement('kbd')
  hint.textContent = navigator.platform.startsWith('Mac') ? '⌘K' : 'Ctrl+K'
  search.append(hint)

  const views = document.createElement('ul')
  views.className = 'sidebar-views'
  for (const {id, label} of VIEWS) {
    const item = document.createElement('li')
    const row = button('sidebar-view', label, () => void showView(id))
    row.dataset.view = id
    if (id === view) row.setAttribute('aria-current', 'page')
    if (id !== 'today' && counts.get(id)) {
      const count = document.createElement('span')
      count.className = 'sidebar-count'
      count.textContent = String(counts.get(id))
      row.append(count)
    }
    item.append(row)
    views.append(item)
  }

  const heading = document.createElement('h2')
  heading.className = 'sidebar-heading'
  heading.textContent = viewLabel(view)

  const list = document.createElement('ul')
  list.className = 'sidebar-notes'
  list.setAttribute('aria-label', heading.textContent)
  const listed = viewEntries(entries, view)
  for (const entry of listed) {
    const item = document.createElement('li')
    const row = button('sidebar-note', labelOf(entry), () => {
      if (narrow.matches) setPeek(false)
      void goTo(entry)
    })
    if (entry.id === current) row.setAttribute('aria-current', 'true')
    item.append(row)
    list.append(item)
  }
  const extra = []
  if (!listed.length) {
    const empty = document.createElement('p')
    empty.className = 'sidebar-empty'
    empty.textContent = EMPTY[view] ?? 'No notes yet.'
    extra.push(empty)
  }
  if (view === 'tasks') extra.push(button('sidebar-more', 'Every open task…', () => void toggleTasksPanel()))

  sidebar.replaceChildren(
    search,
    views,
    ...databaseSection(current),
    ...treeSection('Folders', 'folder', folderTree(entries)),
    ...treeSection('Tags', 'tag', tagTree(entries)),
    heading,
    list,
    ...extra,
    button('sidebar-graph', 'Graph', () => void showGraph()),
    button('sidebar-new', 'New note', () => void startNote()),
  )
}

/** The notes that are databases, and the way to make one. */
function databaseSection(current) {
  const heading = document.createElement('h2')
  heading.className = 'sidebar-heading'
  heading.textContent = 'Databases'
  const list = document.createElement('ul')
  list.className = 'sidebar-notes'
  list.setAttribute('aria-label', 'Databases')
  for (const entry of entries) {
    if (!databaseOf(entry.text ?? '')) continue
    const item = document.createElement('li')
    const row = button('sidebar-note', labelOf(entry), () => {
      if (narrow.matches) setPeek(false)
      void goTo(entry)
    })
    if (entry.id === current) row.setAttribute('aria-current', 'true')
    item.append(row)
    list.append(item)
  }
  return [heading, list, button('sidebar-more', 'New database…', () => void startDatabase())]
}

/** Ask for a query and open it as a database. */
async function startDatabase() {
  const answer = await showDialog({
    title: 'New database',
    description: 'It is saved as a note of its own. Rows are the notes the query finds, columns are their key:: value lines.',
    submitLabel: 'Create',
    fields: [
      {type: 'text', name: 'name', label: 'Name', placeholder: 'Active projects'},
      {type: 'text', name: 'query', label: 'Query', placeholder: '#project -status:done due:<7d'},
      {type: 'select', name: 'layout', label: 'Layout', value: 'table', options: LAYOUT_OPTIONS},
    ],
  })
  if (!answer) return
  const text = newDatabaseText(answer.name, answer.query ?? '', answer.layout)
  const made = await putDocument({text, title: titleOf(text), words: countStats(text).words})
  if (made) await switchDocument(made)
}

/** Which branches are folded, for as long as the page lives. */
const folded = new Set()

/** A folder or tag tree: a heading, and rows nested on the slash. */
function treeSection(label, kind, tree) {
  if (!tree.length) return []
  const heading = document.createElement('h2')
  heading.className = 'sidebar-heading'
  heading.textContent = label
  const branch = (nodes) => {
    const list = document.createElement('ul')
    list.className = 'sidebar-tree'
    for (const node of nodes) {
      const id = `${kind}:${node.path}`
      const item = document.createElement('li')
      const row = document.createElement('div')
      row.className = 'sidebar-branch'
      if (node.children.length) {
        const open = !folded.has(id)
        const fold = button('sidebar-fold', open ? '▾' : '▸', () => {
          if (open) folded.add(id)
          else folded.delete(id)
          drawSidebar()
        })
        fold.setAttribute('aria-expanded', String(open))
        fold.setAttribute('aria-label', `${open ? 'Fold' : 'Unfold'} ${node.name}`)
        row.append(fold)
      } else {
        const gap = document.createElement('span')
        gap.className = 'sidebar-fold-gap'
        row.append(gap)
      }
      const pick = button('sidebar-view', node.name, () => void showView(id))
      pick.dataset.view = id
      if (id === view) pick.setAttribute('aria-current', 'page')
      const count = document.createElement('span')
      count.className = 'sidebar-count'
      count.textContent = String(node.count)
      pick.append(count)
      row.append(pick)
      item.append(row)
      if (node.children.length && !folded.has(id)) item.append(branch(node.children))
      list.append(item)
    }
    return list
  }
  return [heading, branch(tree)]
}

async function showGraph() {
  const {openGraph} = await import('./graph-panel.js')
  await openGraph({current: documentId(), onOpen: (entry) => void switchDocument(entry)})
}

/** Keep files and write their tokens where the caret is, one per line. */
async function attachFiles(files) {
  for (const file of files) {
    try {
      const token = await addAttachment(file)
      const {start} = editor.selection()
      const before = article.textContent.slice(0, start)
      editor.insert(`${before === '' || before.endsWith('\n') ? '' : '\n'}${token}\n`)
    } catch (error) {
      notify(error.message || 'That file could not be kept.', {error: true, duration: 6000})
    }
  }
  redrawNote()
  await save()
}

function pickFiles() {
  const input = document.createElement('input')
  input.type = 'file'
  input.multiple = true
  input.addEventListener('change', () => void attachFiles([...input.files]))
  input.click()
}

/** Ask for a folder and file the note on screen under it. */
async function moveToFolder() {
  const path = await showDialog({
    title: 'Move to folder',
    description: 'A path like Work/Taxes. It is written into the note as a folder:: line. Leave it empty to take the note out.',
    submitLabel: 'Move',
    fields: [{type: 'text', name: 'folder', label: 'Folder', value: folderOf(article.textContent)}],
  })
  if (!path) return
  editor.replace(setFolder(article.textContent, path.folder ?? ''))
  await save()
}

/** What an empty view says: how a note gets into it. */
const EMPTY = {
  inbox: 'Nothing waiting. A note with no heading lands here until it gets one.',
  tasks: 'No open tasks. Write - [ ] in any note.',
  projects: 'Tag a note #project to list it here.',
  meetings: 'Tag a note #meeting to list it here.',
  wiki: 'Tag a note #wiki to list it here.',
}

function drawTabs() {
  const current = documentId()
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  const rows = tabs.map((id) => {
    // The note on screen may be newer than the last library read: its
    // label comes from the editor until the read catches up.
    const entry = byId.get(id) ?? (id === current ? {id, text: article.textContent} : undefined)
    const tab = document.createElement('span')
    tab.className = 'tab'
    const open = button('tab-open', entry ? labelOf(entry) : 'Note', () => void goTo(entry))
    open.title = open.textContent
    if (id === current) open.setAttribute('aria-current', 'page')
    tab.append(open)
    // The last tab has no close button: closing it would leave no note on
    // screen, which is what New note is for.
    if (tabs.length > 1) {
      const close = button('tab-close', '×', () => void closeOne(id))
      close.setAttribute('aria-label', `Close ${open.textContent}`)
      tab.append(close)
    }
    tab.addEventListener('auxclick', (event) => {
      if (event.button === 1 && tabs.length > 1) void closeOne(id)
    })
    return tab
  })
  const toggle = button('tabs-toggle', '☰', () => toggleSidebar())
  toggle.setAttribute('aria-label', 'Sidebar')
  toggle.setAttribute('aria-expanded', String(sidebarVisible()))
  toggle.title = 'Sidebar (Ctrl/Cmd+\\)'
  const add = button('tabs-new', '+', () => void startNote())
  add.setAttribute('aria-label', 'New note')
  strip.replaceChildren(toggle, ...rows, add)
}

async function closeOne(id) {
  const result = closeTab(tabs, id, documentId())
  tabs = result.tabs
  setOpenTabs(tabs)
  const next = entries.find((entry) => entry.id === result.next)
  if (next) await goTo(next)
  drawTabs()
}

/** Read the library again and redraw: the news a save sends out. */
async function refresh() {
  entries = await listDocuments()
  setPreviews()
  const current = documentId()
  const ids = new Set(entries.map((entry) => entry.id))
  tabs = liveTabs(tabs, ids, null)
  if (current && ids.has(current)) tabs = openTab(tabs, current, shown)
  shown = current
  setOpenTabs(tabs)
  drawSidebar()
  drawTabs()
  updateDatabase(entries)
  updateTasksView(entries)
}

/** What each title's card says; the note is redrawn only if one of its own moved. */
let previews = new Map()
function setPreviews() {
  const next = new Map()
  for (const entry of entries) {
    const key = entry.title?.toLowerCase()
    if (key && !next.has(key)) next.set(key, cardPreview(entry))
  }
  const before = previews
  previews = next
  const moved = wikiTitles(article.textContent).some((title) => {
    const key = title.toLowerCase()
    return before.get(key) !== next.get(key)
  })
  if (moved) redrawNote()
}

let pending = null
function scheduleRefresh() {
  // The tab goes on at once - a note opened and left inside the pause still
  // gets one - and only the library read waits for the pause.
  const current = documentId()
  if (current && current !== shown) {
    tabs = openTab(tabs, current, shown)
    shown = current
    setOpenTabs(tabs)
  }
  drawTabs()
  followNote()
  followTasksNote()
  clearTimeout(pending)
  pending = setTimeout(() => void refresh(), 150)
}

function sidebarVisible() {
  return root.classList.contains('shell') && (!narrow.matches || root.classList.contains('sidebar-peek'))
}

function setPeek(on) {
  root.classList.toggle('sidebar-peek', on)
  drawTabs()
}

/** The shell on or off; on a narrow window, the sidebar over the note or not. */
export function toggleSidebar() {
  if (narrow.matches && root.classList.contains('shell')) {
    setPeek(!root.classList.contains('sidebar-peek'))
    return
  }
  const on = !root.classList.contains('shell')
  setSidebarOpen(on)
  root.classList.toggle('shell', on)
  drawTabs()
}

export function initShell() {
  tabs = liveTabs(openTabs(), new Set(), null)
  root.classList.toggle('shell', sidebarOpen())
  reopen.addEventListener('click', () => toggleSidebar())
  document.body.prepend(sidebar, strip, reopen)
  initDatabase()
  initTasksView()

  addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.code === 'Backslash') {
      event.preventDefault()
      toggleSidebar()
    }
    if (event.key === 'Escape' && root.classList.contains('sidebar-peek')) setPeek(false)
  })
  narrow.addEventListener('change', () => setPeek(false))

  setDropAttach((files) => void attachFiles(files))
  setCardPreview((title) => previews.get(title.toLowerCase()) ?? 'No note with this title yet')
  const slash = createSlashMenu({article, editor, attach: pickFiles})
  document.body.append(slash.element)
  article.addEventListener('paste', (event) => {
    const files = [...(event.clipboardData?.files ?? [])]
    if (!files.length) return
    event.preventDefault()
    void attachFiles(files)
  })

  // Everything the sidebar can do is in Ctrl/Cmd+K too, beside the notes.
  setShellCommands(() => [
    ...VIEWS.map(({id, label}) => ({title: `Go to ${label}`, run: () => void showView(id)})),
    {title: 'New note', run: () => void startNote()},
    {title: 'Quick add a task…', run: () => void quickAdd()},
    {title: 'New database…', run: () => void startDatabase()},
    {title: 'Move to folder…', run: () => void moveToFolder()},
    {title: 'Open the graph', run: () => void showGraph()},
    {title: 'Attach an image or file…', run: () => pickFiles()},
    {title: 'Show or hide the sidebar', run: () => toggleSidebar()},
  ])

  // Read once with the stored tabs, so the first draw keeps them.
  void listDocuments().then((all) => {
    entries = all
    tabs = liveTabs(openTabs(), new Set(all.map((entry) => entry.id)), null)
    void refresh()
  })
  on('note', scheduleRefresh)
  on('menu', scheduleRefresh)
}
