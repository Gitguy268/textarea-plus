// The document library panel: every note this browser has held.
//
// The list is rebuilt from IndexedDB each time the panel opens rather than kept
// in memory, because the notes in it are written by the autosave in the
// background while it is shut, and a stale list is worse than a slow one.
//
// There is no rename control, and that is a decision rather than an omission. A
// note's title is its first level one heading, everywhere else in the app: it is
// what names the tab and what the exported file is called. A separate stored
// title would be a second name for the same document that could disagree with the
// first, so the panel says how to rename instead.

import {icon} from './dialog.js'
import {activityByDay, matchNote, parseQuery, recentDays, tagCounts, toggleToken} from './filter.js'
import {titleOf} from './front-matter.js'
import {
  deleteDocument,
  deleteForever,
  emptyTrash,
  listDocuments,
  listTrash,
  moveToTrash,
  purgeTrash,
  putDocument,
  restoreFromTrash,
  setDocumentFlags,
} from './library.js'
import {countStats} from './stats.js'

/**
 * The library in the order the reader asked for: last edited first (the
 * order it is stored in), newest first, or by title - with the pinned notes
 * ahead of the rest, in that same order among themselves.
 *
 * @param {Array<{title?: string, created?: number, pinned?: boolean}>} entries
 * @param {'updated' | 'created' | 'title'} sort
 */
export function sortNotes(entries, sort) {
  const order = {
    created: (a, b) => (b.created ?? 0) - (a.created ?? 0),
    title: (a, b) =>
      String(a.title ?? '').localeCompare(String(b.title ?? ''), undefined, {sensitivity: 'base', numeric: true}),
  }[sort]
  // 'updated', or anything else, is the order the library already reads in.
  const sorted = order ? [...entries].sort(order) : entries
  if (!sorted.some((entry) => entry.pinned)) return sorted
  // Array.prototype.sort is stable, so each half keeps the order above.
  return [...sorted].sort((a, b) => Boolean(b.pinned) - Boolean(a.pinned))
}

/**
 * Show the library.
 *
 * @param {object} options
 * @param {string} [options.activeId]  the note currently open, marked in the list
 * @param {(entry: object) => void} options.onOpen
 * @param {() => void} [options.onNew]  a "New note" action for the empty list
 * @param {(id: string) => void} [options.onDelete]  after a note is gone, for
 *   the folder mirror, which owns the file half of the deletion
 * @param {boolean} [options.trash]  delete through the trash rather than for
 *   good; the reader's switch, read when the panel opens
 * @param {'updated' | 'created' | 'title'} [options.sort]  the order to open in
 * @param {(sort: string) => void} [options.onSort]  the reader picked another
 * @param {'board' | 'timeline'} [options.view]  cards on a board, or the notes
 *   themselves in a column
 * @param {(view: string) => void} [options.onView]  the reader picked the other
 * @param {Array<{name: string, query: string}>} [options.filters]  the saved
 *   searches, as they were when the panel opened
 * @param {(filters: Array<{name: string, query: string}>) => void} [options.onFilters]
 *   one was saved or removed
 * @param {(record: object) => void} [options.onFlag]  after a note was pinned
 *   or archived, with the row as it now is
 * @param {(message: string, isError?: boolean) => void} [options.notify]
 * @returns {Promise<void>}
 */
export async function showDocumentsPanel({
  activeId,
  onOpen,
  onNew,
  onDelete,
  trash = false,
  sort = 'updated',
  onSort,
  view = 'board',
  onView,
  filters = [],
  onFilters,
  onFlag,
  notify,
} = {}) {
  const say = notify ?? (() => {})
  let saved = [...filters]

  const dialog = document.createElement('dialog')
  dialog.className = 'dialog dialog-library'
  dialog.setAttribute('aria-label', 'My documents')

  const form = document.createElement('form')
  form.method = 'dialog'
  form.className = 'dialog-form'

  const heading = document.createElement('h2')
  heading.className = 'dialog-title'
  heading.textContent = 'My documents'
  form.append(heading)

  const description = document.createElement('p')
  description.className = 'dialog-description'
  description.textContent =
    'Every note you have written in this browser, newest first. Nothing leaves this device. ' +
    'Pick a card to open it; a note is named by its first # heading.'
  form.append(description)

  const error = document.createElement('p')
  error.className = 'dialog-error'
  error.setAttribute('role', 'alert')
  error.hidden = true
  form.append(error)

  // Quick capture: a thought goes into the library from here, without the
  // note on screen being put away first. It is a note like any other from
  // then on - open it to give it a heading.
  const capture = document.createElement('div')
  capture.className = 'library-capture'
  const jot = document.createElement('textarea')
  jot.className = 'library-jot'
  jot.rows = 2
  jot.placeholder = 'Jot a note. #tags work here too.'
  jot.setAttribute('aria-label', 'Quick note')
  const keep = document.createElement('button')
  keep.type = 'button'
  keep.className = 'dialog-button'
  keep.textContent = 'Save note'
  capture.append(jot, keep)
  form.append(capture)

  async function captureNote() {
    const text = jot.value.trim()
    if (!text) return
    keep.disabled = true
    const written = await putDocument({text, title: titleOf(text), words: countStats(text).words})
    keep.disabled = false
    if (!written) {
      showError('That note could not be saved.')
      return
    }
    jot.value = ''
    say('Saved the note to your documents')
    render()
  }
  keep.addEventListener('click', captureNote)
  jot.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      captureNote()
    }
  })

  const search = document.createElement('input')
  search.type = 'search'
  search.className = 'dialog-search'
  search.placeholder = 'Search, or filter: #tag  on:2026-10-11  is:pinned'
  search.setAttribute('aria-label', 'Search documents')
  search.spellcheck = false
  form.append(search)

  /** Put a filter in the search box, or take it out, and redraw. */
  function toggleFilter(token) {
    search.value = toggleToken(search.value, token)
    render()
  }

  // The shelf: the activity calendar beside the tags and the saved searches.
  // All three only ever write into the search box above, so what the list is
  // showing is always spelled out there.
  const shelf = document.createElement('div')
  shelf.className = 'library-shelf'

  const activity = document.createElement('div')
  activity.className = 'library-activity'
  // The picture is for the eye and the pointer; its squares are too small to
  // be buttons. The date field under it is the same filter for a keyboard.
  const calendar = document.createElement('div')
  calendar.className = 'library-calendar'
  calendar.setAttribute('role', 'img')
  calendar.addEventListener('click', (event) => {
    const {day, level} = event.target.dataset ?? {}
    if (day && level !== '0') toggleFilter('on:' + day)
  })
  const dayField = document.createElement('input')
  dayField.type = 'date'
  dayField.className = 'library-day'
  dayField.setAttribute('aria-label', 'Show the notes of one day')
  dayField.addEventListener('change', () => {
    const asked = parseQuery(search.value).day
    if (asked) search.value = toggleToken(search.value, 'on:' + asked)
    if (dayField.value) search.value = toggleToken(search.value, 'on:' + dayField.value)
    render()
  })
  activity.append(calendar, dayField)

  const chips = document.createElement('div')
  chips.className = 'library-chips'
  shelf.append(activity, chips)
  form.append(shelf)

  /** A chip: a button that switches one filter, pressed while it is on. */
  function chip(label, pressed, onClick) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'library-chip'
    button.textContent = label
    button.setAttribute('aria-pressed', String(pressed))
    button.addEventListener('click', onClick)
    return button
  }

  /**
   * Redraw the calendar and the chips from the notes and the query. The
   * calendar and the tag counts speak for the whole library, not for the
   * search: they are what there is to filter by.
   */
  function renderShelf(all) {
    const query = parseQuery(search.value)
    const raw = search.value.trim()

    const days = activityByDay(all)
    const shown = recentDays(Date.now())
    const active = shown.filter((day) => days.has(day)).length
    calendar.setAttribute(
      'aria-label',
      `Notes written or edited per day over the last 12 weeks: ${active} active ${active === 1 ? 'day' : 'days'}`,
    )
    calendar.replaceChildren(
      ...shown.map((day) => {
        const count = days.get(day) ?? 0
        const cell = document.createElement('span')
        cell.dataset.day = day
        cell.dataset.level = String(Math.min(count, 4))
        if (day === query.day) cell.dataset.current = 'true'
        cell.title = `${day}: ${count} ${count === 1 ? 'note' : 'notes'}`
        return cell
      }),
    )
    dayField.value = query.day ?? ''

    chips.replaceChildren(
      chip('Pinned', query.pinned, () => toggleFilter('is:pinned')),
      chip('Archived', query.archived, () => toggleFilter('is:archived')),
      ...tagCounts(all).map(([tag, count]) =>
        chip(`#${tag} ${count}`, query.tags.includes(tag), () => toggleFilter('#' + tag)),
      ),
      ...saved.flatMap((filter) => {
        const apply = chip(filter.name, raw === filter.query, () => {
          search.value = raw === filter.query ? '' : filter.query
          render()
        })
        apply.classList.add('library-chip-saved')
        const forget = document.createElement('button')
        forget.type = 'button'
        forget.className = 'library-chip-remove'
        forget.setAttribute('aria-label', `Remove the saved filter ${filter.name}`)
        forget.append(icon('icon-close', 14))
        forget.addEventListener('click', () => {
          saved = saved.filter((item) => item !== filter)
          onFilters?.(saved)
          render()
        })
        return [apply, forget]
      }),
    )

    // A search worth keeping is one that is not kept already.
    if (raw && !saved.some((filter) => filter.query === raw)) {
      const save = document.createElement('button')
      save.type = 'button'
      save.className = 'library-chip library-chip-save'
      save.textContent = 'Save this search'
      save.addEventListener('click', () => {
        // The search is its own name: it is short, and it is what the chip does.
        saved = [...saved, {name: raw.slice(0, 40), query: raw}]
        onFilters?.(saved)
        render()
      })
      chips.append(save)
    }
  }

  // The order of the cards, remembered between openings. Nothing is renamed
  // or moved by it: it is only which card comes first.
  const order = document.createElement('select')
  order.className = 'dialog-sort'
  order.setAttribute('aria-label', 'Sort notes by')
  for (const [value, label] of [
    ['updated', 'Last edited first'],
    ['created', 'Newest first'],
    ['title', 'By title'],
  ]) {
    const choice = document.createElement('option')
    choice.value = value
    choice.textContent = label
    order.append(choice)
  }
  order.value = sort

  // Board or timeline: the same notes, as cards to recognise or as their own
  // text to read down.
  const layout = document.createElement('select')
  layout.className = 'dialog-sort'
  layout.setAttribute('aria-label', 'Show notes as')
  for (const [value, label] of [
    ['board', 'Board'],
    ['timeline', 'Timeline'],
  ]) {
    const choice = document.createElement('option')
    choice.value = value
    choice.textContent = label
    layout.append(choice)
  }
  layout.value = view

  const tools = document.createElement('div')
  tools.className = 'library-tools'
  tools.append(layout, order)
  form.append(tools)

  const list = document.createElement('ul')
  list.className = 'document-list'
  list.dataset.view = layout.value
  form.append(list)

  const actions = document.createElement('div')
  actions.className = 'dialog-actions'

  const newNote = document.createElement('button')
  newNote.type = 'button'
  newNote.className = 'dialog-button'
  newNote.textContent = 'New note'
  newNote.addEventListener('click', () => {
    close()
    onNew?.()
  })

  const closeButton = document.createElement('button')
  closeButton.type = 'button'
  closeButton.className = 'dialog-button dialog-button-primary'
  closeButton.textContent = 'Close'

  actions.append(newNote, closeButton)
  form.append(actions)
  dialog.append(form)

  const showError = (message) => {
    error.textContent = message
    error.hidden = false
  }

  const close = () => {
    dialog.close()
    dialog.remove()
  }

  /**
   * Reading the library is asynchronous, so two renders can be in flight at once
   * while someone types in the search box. Each render takes a number, and only
   * the newest one is allowed to write to the list, or a slow earlier read lands
   * last and shows the results for a search that has already moved on.
   */
  let renderNumber = 0

  function render() {
    const mine = ++renderNumber
    list.replaceChildren()

    listDocuments().then((all) => {
      if (mine !== renderNumber) return
      const entries = sortNotes(all, order.value)

      const query = parseQuery(search.value)
      const matches = entries.filter((entry) => matchNote(entry, query))

      search.disabled = entries.length === 0
      list.replaceChildren()
      renderShelf(all)

      if (!entries.length) {
        list.append(emptyRow('No notes yet.', 'Everything you write is kept here as you type.'))
        return
      }

      if (!matches.length) {
        // An empty search that finds nothing has only one way to happen.
        list.append(
          search.value.trim()
            ? emptyRow('Nothing matches that search.', null)
            : emptyRow('Every note is archived.', 'The Archived chip shows them.'),
        )
        return
      }

      for (const entry of matches) list.append(renderRow(entry))
    })
  }

  search.addEventListener('input', render)
  order.addEventListener('change', () => {
    onSort?.(order.value)
    render()
  })
  layout.addEventListener('change', () => {
    onView?.(layout.value)
    list.dataset.view = layout.value
    render()
  })

  /** One card: the whole card opens the note, and the corner button forgets it. */
  function renderRow(entry) {
    const row = document.createElement('li')
    row.className = 'document-row'
    if (entry.id === activeId) row.dataset.current = 'true'

    const open = document.createElement('button')
    open.type = 'button'
    open.className = 'document-open'

    const title = document.createElement('span')
    title.className = 'document-title'
    title.textContent = entry.title || 'Untitled note'

    const preview = document.createElement('span')
    preview.className = 'document-preview'
    // On the timeline the card is the note, as far as a card can be: its text
    // with its line breaks, where the board has room for one flattened line.
    preview.textContent = layout.value === 'timeline' ? bodyOf(entry.text) : previewOf(entry.text)

    // Only the date is printed on the card. The word count stays out of it for
    // the same reason, and lives in the description below instead: a card
    // has to be scannable, and a second line of numbers is what stops it
    // being one.
    const meta = document.createElement('span')
    meta.className = 'document-meta'
    meta.textContent = formatWhen(entry.updated)

    // The name is the verb and then the card's own text, so what a
    // voice-control user reads off the screen is in what the button answers
    // to (WCAG 2.5.3); the word count the card has no room for rides along
    // as the description.
    open.append(srOnly('Open '), title, preview, meta)
    open.setAttribute('aria-description', `${entry.words} words`)
    open.addEventListener('click', () => {
      close()
      onOpen?.(entry)
    })

    const forget = document.createElement('button')
    forget.type = 'button'
    forget.className = 'document-delete'
    forget.setAttribute('aria-label', `Delete ${entry.title || 'Untitled note'}`)
    forget.append(icon('icon-delete', 18))
    forget.addEventListener('click', async () => {
      // Ask before deleting. The note is still in the URL, so it is not gone the
      // moment the row disappears, but after closing the tab it would be.
      const confirmed = await confirmInPanel(
        dialog,
        `Delete “${entry.title || 'Untitled note'}”?`,
        trash
          ? 'The note will wait in the trash, where it can be put back, until its keep days are up.'
          : 'The note is removed from this browser. If its link is still in the address bar it can be reopened from there.',
      )
      if (!confirmed) return
      forget.disabled = true
      const removed = trash ? await moveToTrash(entry.id) : await deleteDocument(entry.id)
      if (!removed) {
        forget.disabled = false
        showError('That note could not be deleted.')
        return
      }
      row.remove()
      if (!list.children.length) render()
      // The file half of a mirrored note goes with it. After the row is gone,
      // so a failure there cannot bring the note back into the panel.
      onDelete?.(entry.id)
      say(trash ? `Moved ${entry.title || 'the note'} to the trash` : `Deleted ${entry.title || 'the note'}`)
    })

    /** A corner button that sets or clears one of the reader's marks. */
    const mark = (flag, glyph, [set, clear, wasSet, wasCleared]) => {
      const name = entry.title || 'Untitled note'
      const button = document.createElement('button')
      button.type = 'button'
      button.className = `document-mark document-${flag}`
      button.setAttribute('aria-label', `${entry[flag] ? clear : set} ${name}`)
      button.setAttribute('aria-pressed', String(Boolean(entry[flag])))
      button.append(icon(glyph, 18))
      button.addEventListener('click', async () => {
        button.disabled = true
        const record = await setDocumentFlags(entry.id, {[flag]: !entry[flag]})
        if (!record) {
          button.disabled = false
          showError('That note could not be changed.')
          return
        }
        onFlag?.(record)
        say(`${entry[flag] ? wasCleared : wasSet} ${name}`)
        render()
      })
      return button
    }

    if (entry.pinned) row.dataset.pinned = 'true'
    row.append(
      open,
      mark('pinned', 'icon-pin', ['Pin', 'Unpin', 'Pinned', 'Unpinned']),
      mark('archived', 'icon-archive', ['Archive', 'Unarchive', 'Archived', 'Unarchived']),
      forget,
    )
    return row
  }

  closeButton.addEventListener('click', close)
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault()
    close()
  })
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) close()
  })

  document.body.append(dialog)
  dialog.showModal()
  render()
  search.focus()
}

/**
 * Show the trash: the notes that were deleted, newest first, each with the
 * days it has left - and the two ways out, put the note back or take it for
 * good. The purge runs on the way in: the trash is read nowhere else, so this
 * is all the housekeeping it needs.
 *
 * @param {object} options
 * @param {number} [options.keepDays]  how long a note earns in the trash
 * @param {() => void} [options.onRestore]  after a note is back in the
 *   library, for the folder mirror and the backlinks, which both just gained
 * @param {(message: string, isError?: boolean) => void} [options.notify]
 * @returns {Promise<void>}
 */
export async function showTrashPanel({keepDays = 30, onRestore, notify} = {}) {
  const say = notify ?? (() => {})

  const dialog = document.createElement('dialog')
  dialog.className = 'dialog dialog-library'
  dialog.setAttribute('aria-label', 'Trash')

  const form = document.createElement('form')
  form.method = 'dialog'
  form.className = 'dialog-form'

  const heading = document.createElement('h2')
  heading.className = 'dialog-title'
  heading.textContent = 'Trash'

  const description = document.createElement('p')
  description.className = 'dialog-description'
  description.textContent =
    'Notes you deleted from My documents, newest first. Each waits here for its keep days - set in ' +
    'Settings - and is then gone for good. Pick a card to put a note back.'

  const error = document.createElement('p')
  error.className = 'dialog-error'
  error.setAttribute('role', 'alert')
  error.hidden = true

  const list = document.createElement('ul')
  list.className = 'document-list'

  const actions = document.createElement('div')
  actions.className = 'dialog-actions'

  const empty = document.createElement('button')
  empty.type = 'button'
  empty.className = 'dialog-button'
  empty.textContent = 'Empty trash'
  empty.disabled = true
  empty.addEventListener('click', async () => {
    const confirmed = await confirmInPanel(
      dialog,
      'Empty the trash?',
      'Every note in it is removed from this browser for good. This cannot be undone.',
    )
    if (!confirmed) return
    const cleared = await emptyTrash()
    if (!cleared) {
      showError('The trash could not be emptied.')
      return
    }
    await render()
    say('The trash is empty')
  })

  const closeButton = document.createElement('button')
  closeButton.type = 'button'
  closeButton.className = 'dialog-button dialog-button-primary'
  closeButton.textContent = 'Close'

  actions.append(empty, closeButton)
  form.append(heading, description, error, list, actions)
  dialog.append(form)

  const showError = (message) => {
    error.textContent = message
    error.hidden = false
  }

  const close = () => {
    dialog.close()
    dialog.remove()
  }

  /** One card: the whole card puts the note back, the corner button forgets it. */
  function renderRow(entry) {
    const row = document.createElement('li')
    row.className = 'document-row'

    const restore = document.createElement('button')
    restore.type = 'button'
    restore.className = 'document-open'

    const title = document.createElement('span')
    title.className = 'document-title'
    title.textContent = entry.title || 'Untitled note'

    const preview = document.createElement('span')
    preview.className = 'document-preview'
    preview.textContent = previewOf(entry.text)

    const meta = document.createElement('span')
    meta.className = 'document-meta'
    meta.textContent = `deleted ${formatWhen(entry.deletedAt)}`

    restore.append(srOnly('Restore '), title, preview, meta)
    restore.addEventListener('click', async () => {
      const putBack = await restoreFromTrash(entry.id)
      if (!putBack) {
        showError('That note could not be put back.')
        return
      }
      row.remove()
      if (!list.children.length) render()
      onRestore?.()
      say(`Restored ${entry.title || 'Untitled note'}`)
    })

    const forever = document.createElement('button')
    forever.type = 'button'
    forever.className = 'document-delete'
    forever.setAttribute('aria-label', `Delete ${entry.title || 'Untitled note'} for good`)
    forever.append(icon('icon-delete', 18))
    forever.addEventListener('click', async () => {
      const confirmed = await confirmInPanel(
        dialog,
        `Delete “${entry.title || 'Untitled note'}” for good?`,
        'The note is removed from this browser for good. This cannot be undone.',
      )
      if (!confirmed) return
      forever.disabled = true
      const gone = await deleteForever(entry.id)
      if (!gone) {
        forever.disabled = false
        showError('That note could not be deleted.')
        return
      }
      row.remove()
      if (!list.children.length) render()
      say(`Deleted ${entry.title || 'the note'} for good`)
    })

    row.append(restore, forever)
    return row
  }

  async function render() {
    await purgeTrash(keepDays * 86_400_000)
    const entries = await listTrash()
    list.replaceChildren()
    empty.disabled = entries.length === 0
    if (!entries.length) {
      list.append(emptyRow('The trash is empty.', 'Notes wait here until their keep days are up.'))
      return
    }
    for (const entry of entries) list.append(renderRow(entry))
  }

  closeButton.addEventListener('click', close)
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault()
    close()
  })
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) close()
  })

  document.body.append(dialog)
  dialog.showModal()
  await render()
}

/** A row with no actions, for the empty and no-match states. */
function emptyRow(title, detail) {
  const row = document.createElement('li')
  row.className = 'document-row document-row-empty'
  const label = document.createElement('p')
  label.className = 'document-title'
  label.textContent = title
  row.append(label)
  if (detail) {
    const hint = document.createElement('p')
    hint.className = 'document-meta'
    hint.textContent = detail
    row.append(hint)
  }
  return row
}

/** The first line or two of a note, flattened so a card can show a little of it. */
/** A word for the accessible name that the card itself has no room for. */
function srOnly(text) {
  const span = document.createElement('span')
  span.className = 'sr-only'
  span.textContent = text
  return span
}

/** A note's text for a timeline card: everything under the title, cut at a length a card can hold. */
function bodyOf(text) {
  const body = String(text ?? '')
    .replace(/^(?:[ \t]*\n)*[ \t]*#[ \t]+[^\n]*/, '')
    .trim()
  return body.length > 600 ? body.slice(0, 600).trimEnd() + '…' : body || 'Empty note'
}

function previewOf(text) {
  // The level one heading is dropped rather than flattened into the preview:
  // it is the title already printed on the card, and repeating it is the one
  // thing a preview should not do.
  const flat = String(text ?? '')
    .replace(/^(?:[ \t]*\n)*[ \t]*#[ \t]+[^\n]*/, '')
    .replace(/\s+/g, ' ')
    .trim()
  return flat.length > 110 ? flat.slice(0, 110).trimEnd() + '…' : flat || 'Empty note'
}

/**
 * A yes/no question on top of an open panel.
 *
 * `showDialog` cannot stack on top of another modal dialog, so this is a
 * `<dialog>` opened while the first one is still up: nested modals are allowed
 * and the topmost one owns Escape.
 *
 * @param {HTMLElement} parent  the panel the question sits on
 * @param {string} message  the question itself
 * @param {string} detail  what a yes actually does - it differs between a
 *   note that waits in the trash and one gone for good
 */
function confirmInPanel(parent, message, detail) {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog')
    dialog.className = 'dialog dialog-confirm'

    const form = document.createElement('form')
    form.method = 'dialog'
    form.className = 'dialog-form'

    const heading = document.createElement('h2')
    heading.className = 'dialog-title'
    heading.textContent = message

    const description = document.createElement('p')
    description.className = 'dialog-description'
    description.textContent = detail

    const actions = document.createElement('div')
    actions.className = 'dialog-actions'

    const no = document.createElement('button')
    no.type = 'button'
    no.className = 'dialog-button'
    no.textContent = 'Cancel'

    const yes = document.createElement('button')
    yes.type = 'button'
    yes.className = 'dialog-button dialog-button-danger'
    yes.textContent = 'Delete'

    actions.append(no, yes)
    form.append(heading, description, actions)
    dialog.append(form)

    const finish = (value) => {
      dialog.close()
      dialog.remove()
      resolve(value)
    }

    no.addEventListener('click', () => finish(false))
    yes.addEventListener('click', () => finish(true))
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault()
      finish(false)
    })
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) finish(false)
    })

    parent.append(dialog)
    dialog.showModal()
    yes.focus()
  })
}

const RELATIVE = [
  [60, 1, 'second'],
  [3600, 60, 'minute'],
  [86_400, 3600, 'hour'],
  [604_800, 86_400, 'day'],
]

/**
 * "3 hours ago", "yesterday", or a date once it stops being news.
 *
 * `Intl.RelativeTimeFormat` handles the grammar, so a translated browser says
 * "vor 3 Stunden" rather than the English string this would otherwise produce.
 */
function formatWhen(timestamp) {
  const seconds = Math.round((timestamp - Date.now()) / 1000)
  const magnitude = Math.abs(seconds)

  if (magnitude < 45) return 'just now'

  for (const [limit, divisor, unit] of RELATIVE) {
    if (magnitude < limit) {
      const value = Math.round(seconds / divisor)
      if (typeof Intl?.RelativeTimeFormat === 'function') {
        return new Intl.RelativeTimeFormat(undefined, {numeric: 'auto'}).format(value, unit)
      }
      return unit === 'day' && Math.abs(value) === 1 ? 'yesterday' : `${Math.abs(value)} ${unit}s ago`
    }
  }

  return new Date(timestamp).toLocaleDateString(undefined, {day: 'numeric', month: 'short', year: 'numeric'})
}
