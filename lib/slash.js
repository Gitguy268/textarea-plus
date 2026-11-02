// textarea-plus: the slash menu.
//
// Type / at the start of a word and pick what to insert. Everything it inserts
// is plain Markdown, typed into the note the way the reader could have typed
// it, so it round-trips through every app that reads the folder. Escape leaves
// the / and what follows it as typed.
//
// The pure half (what counts as a slash, which rows match) is exported for
// the unit tests; createSlashMenu() is the popup.

/** `|` in a snippet is where the caret lands. */
export const SLASH_ITEMS = [
  {id: 'h1', label: 'Heading 1', keys: 'title', snippet: '# |'},
  {id: 'h2', label: 'Heading 2', keys: 'subtitle', snippet: '## |'},
  {id: 'h3', label: 'Heading 3', keys: '', snippet: '### |'},
  {id: 'todo', label: 'To-do', keys: 'task checkbox', snippet: '- [ ] |'},
  {id: 'bullet', label: 'Bulleted list', keys: 'ul', snippet: '* |'},
  {id: 'numbered', label: 'Numbered list', keys: 'ol', snippet: '1. |'},
  {id: 'toggle', label: 'Toggle', keys: 'collapse fold', snippet: '> [!note]- |\n> '},
  {id: 'callout', label: 'Callout', keys: 'quote note', snippet: '> [!note] |'},
  {id: 'table', label: 'Table', keys: 'grid', snippet: '| Column | Column |\n|---|---|\n|  |  |'},
  {id: 'code', label: 'Code block', keys: 'fence', snippet: '```\n|\n```'},
  {id: 'image', label: 'Image or file…', keys: 'picture attachment upload', run: 'attach'},
  {id: 'divider', label: 'Divider', keys: 'rule line', snippet: '---\n|'},
  {id: 'page', label: 'Page link', keys: 'wikilink note', snippet: '[[|]]'},
]

/** Split a snippet at its caret mark. */
export function snippetParts(snippet) {
  // A table's pipes are its own, so its caret is simply the end.
  if (snippet.startsWith('| ')) return {text: snippet, caret: snippet.length}
  const at = snippet.indexOf('|')
  return at < 0 ? {text: snippet, caret: snippet.length} : {text: snippet.replace('|', ''), caret: at}
}

/**
 * The open slash before the caret, if there is one: a / at the start of a
 * line or after a space, followed by letters only, and not inside a code
 * fence. `1/2`, `http://` and a path are left alone.
 *
 * @param {string} text the note
 * @param {number} caret
 * @returns {{start: number, query: string} | null}
 */
export function slashAt(text, caret) {
  const lineStart = text.lastIndexOf('\n', caret - 1) + 1
  const match = /(?:^|[ \t])\/([\p{L}\p{N} -]{0,24})$/u.exec(text.slice(lineStart, caret))
  if (!match) return null
  if (match[1].startsWith(' ')) return null
  const before = text.slice(0, lineStart)
  if (((before.match(/^(?:```|~~~)/gm) ?? []).length & 1) === 1) return null
  return {start: caret - match[1].length - 1, query: match[1]}
}

/** The rows a query matches, by label first and other names after. */
export function matchSlash(query) {
  const q = query.trim().toLowerCase()
  if (!q) return SLASH_ITEMS
  const named = SLASH_ITEMS.filter((item) => item.label.toLowerCase().includes(q))
  const other = SLASH_ITEMS.filter((item) => !named.includes(item) && item.keys.includes(q))
  return [...named, ...other]
}

/**
 * The popup, over an editor.
 *
 * @param {object} deps
 * @param {HTMLElement} deps.article
 * @param {{selection: () => {start: number, end: number}, select: (s: number, e: number) => void, insert: (t: string) => void}} deps.editor
 * @param {() => void} deps.attach what the Image or file row does
 */
export function createSlashMenu({article, editor, attach}) {
  const menu = document.createElement('ul')
  menu.id = 'slash-menu'
  menu.className = 'noprint'
  menu.setAttribute('role', 'listbox')
  menu.setAttribute('aria-label', 'Insert')
  menu.hidden = true

  let open = null
  let rows = []
  let active = 0

  function close() {
    open = null
    menu.hidden = true
  }

  function draw() {
    menu.replaceChildren(
      ...rows.map((item, index) => {
        const row = document.createElement('li')
        row.setAttribute('role', 'option')
        row.setAttribute('aria-selected', String(index === active))
        row.textContent = item.label
        // mousedown, not click: a click would blur the note and lose the caret.
        row.addEventListener('mousedown', (event) => {
          event.preventDefault()
          choose(item)
        })
        return row
      }),
    )
    menu.children[active]?.scrollIntoView({block: 'nearest'})
  }

  function place() {
    const selection = getSelection()
    if (!selection?.rangeCount) return
    const box = selection.getRangeAt(0).getBoundingClientRect()
    menu.style.left = `${Math.min(box.left, innerWidth - 240)}px`
    const below = box.bottom + 6
    menu.style.top = below + 280 > innerHeight ? `${Math.max(8, box.top - 286)}px` : `${below}px`
  }

  function choose(item) {
    const {start} = open
    const {end} = editor.selection()
    close()
    editor.select(start, end)
    if (item.run === 'attach') {
      editor.insert('')
      attach()
      return
    }
    const {text, caret} = snippetParts(item.snippet)
    editor.insert(text)
    editor.select(start + caret, start + caret)
  }

  function update() {
    const {start, end} = editor.selection()
    const found = start === end ? slashAt(article.textContent, end) : null
    rows = found ? matchSlash(found.query) : []
    if (!found || !rows.length) {
      close()
      return
    }
    open = found
    active = Math.min(active, rows.length - 1)
    menu.hidden = false
    draw()
    place()
  }

  article.addEventListener('input', (event) => {
    if (open || event.data === '/') {
      if (!open) active = 0
      update()
    }
  })
  // Capture: these keys belong to the menu while it is up, before the editor
  // or the page's own shortcuts see them.
  article.addEventListener(
    'keydown',
    (event) => {
      if (!open) return
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        active = (active + (event.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length
        draw()
      } else if (event.key === 'Enter' || event.key === 'Tab') {
        choose(rows[active])
      } else if (event.key === 'Escape') {
        close()
      } else return
      event.preventDefault()
      event.stopPropagation()
    },
    true,
  )
  article.addEventListener('blur', close)

  return {element: menu, isOpen: () => Boolean(open)}
}
