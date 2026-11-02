// The features around the note: the panels that open beside it, the switches
// that change how it is drawn, and the bars its shortcuts open. Every panel
// module is fetched by the click or the chord that first needs it.

import {dayOf} from './filter.js'
import {glassEnabled, setGlassEnabled, trackGlass} from './glass.js'
import {listDocuments, newId} from './library.js'
import {article, canLeaveNote, documentId, editor, newDocument, openDocument, save, setDocumentId, state, switchDocument} from './note.js'
import {notify} from './notify.js'
import {
  backlinkMentionsEnabled,
  backlinksPreferred,
  fileLinksEnabled,
  findCase,
  findEnabled,
  findWords,
  organiseEnabled,
  selectionToolsEnabled,
  setBacklinksPreferred,
  setFileLinks,
  setFindCase,
  setFindWords,
  setSpeechLanguage,
  setSpeechModel,
  setStatsPreferred,
  setTagsEnabled,
  setTasksEnabled,
  setTwoColumns,
  setWikilinks,
  setWritingModel,
  setWritingPreferred,
  speechLanguage,
  speechModel,
  statsPreferred,
  switcherEnabled,
  switcherScope,
  tagsEnabled,
  tasksDoneEnabled,
  tasksEnabled,
  twoColumnsEnabled,
  wikiCreateEnabled,
  wikilinksEnabled,
  wordGoal,
  writingInstructions,
  writingModel,
  writingPreferred,
  writingToolEnabled,
} from './prefs.js'
import {emit, on} from './signals.js'
import {parseTaskLine, setStatus} from './tasks.js'
import {createStatsPanel} from './stats-panel.js'

export const statsPanel = createStatsPanel(document, {goal: wordGoal})
document.body.append(statsPanel.element)

/**
 * The backlinks panel, built the first time anything asks for it.
 *
 * The feature ships off, so a reader who never opens the panel never pays
 * for the module that draws it: the import lives in ensureBacklinksPanel()
 * below, and the startup guard says the file is not part of the boot.
 */
let backlinksPanel = null

/** The tasks panel, built the first time the menu row asks for it. */
let tasksPanel = null

/**
 * The quick switcher, built the first time its shortcut is pressed.
 *
 * The feature is on by default, so the listener that answers its chord is
 * part of the boot - but the palette is not: the import lives in
 * openSwitcher() below, and the startup guard says the module is not part
 * of the boot all the same.
 */
let switcher = null

/**
 * The find bar, built the first time its chord is pressed.
 *
 * Same bargain as the switcher: on by default, so the listener that
 * answers Ctrl/Cmd+F is part of the boot - but the bar is not, and the
 * startup guard says its module is no part of the boot all the same.
 */
let find = null

export function toggleTwoColumns() {
  const next = !twoColumnsEnabled()
  setTwoColumns(next)
  emit('menu')
  notify(next ? 'Two column PDFs will be detected' : 'Two column PDFs will be read row by row')
}

export function toggleFileLinks() {
  const next = !fileLinksEnabled()
  setFileLinks(next)
  // Re-render from the note's own text so the tokens on screen follow the
  // switch immediately. set() does not touch history or the URL: nothing in
  // the note changed, only what the note is drawn as.
  editor.set(article.textContent)
  emit('menu')
  notify(next ? 'File links will be offered' : 'File links are off; the tokens show as text')
}

export function toggleWikilinks() {
  const next = !wikilinksEnabled()
  setWikilinks(next)
  // Re-render from the note's own text so the tokens on screen follow the
  // switch immediately, the same way the file link switch does.
  editor.set(article.textContent)
  notify(next ? 'Wikilinks will be links' : 'Wikilinks show as text')
}

export function toggleTags() {
  const next = !tagsEnabled()
  setTagsEnabled(next)
  // Re-render from the note's own text, the same bargain as the wikilink
  // switch. My documents reads tags from the text either way: the switch is
  // only how a note draws them.
  editor.set(article.textContent)
  notify(next ? 'Tags are drawn in colour' : 'Tags show as text')
}

export function toggleTasks() {
  const next = !tasksEnabled()
  setTasksEnabled(next)
  // Re-render from the note's own text so the checkboxes appear or leave
  // at once, the same bargain the file link and wikilink switches make.
  editor.set(article.textContent)
  emit('menu')
  // The panel is the feature's face, so it goes with the feature.
  if (!next) tasksPanel?.close()
  notify(next ? 'Tasks are checkboxes' : 'Tasks show as text')
}

/**
 * Tick a task, or untick it, with the click that lands on the checkbox.
 *
 * The whole task is one character - the space or the x between the
 * brackets - so the click becomes the keystroke that writes it, through
 * the editor like any other: the change lands on the undo stack and
 * raises the input event the autosave listens for.
 */
export function toggleTask(span) {
  // Where the bracket begins, measured the way the editor measures a
  // selection: a range from the top of the article to the span. The
  // note's own text is the answer rather than the span's, so a click
  // after the text has moved underneath cannot flip the wrong byte.
  const range = document.createRange()
  range.setStart(article, 0)
  range.setEnd(span, 0)
  const at = range.toString().length
  const text = article.textContent
  const state = text[at + 1]
  if (!' xX/-'.includes(state)) return
  // A repeating task ticked makes the next one, so the whole line is rewritten.
  const lineStart = text.lastIndexOf('\n', at) + 1
  const lineEnd = (text.indexOf('\n', at) + 1 || text.length + 1) - 1
  const line = text.slice(lineStart, lineEnd)
  if (' /'.includes(state) && parseTaskLine(line)?.recurrence) {
    const written = setStatus(line, 'x', dayOf(Date.now()))
    if (written.includes('\n')) {
      editor.select(lineStart, lineEnd)
      editor.insert(written)
      return
    }
  }
  editor.select(at + 1, at + 2)
  editor.insert(' /'.includes(state) ? 'x' : ' ')
}

/**
 * Turn `-- ` at the start of a line into an empty task, on the space.
 *
 * The text becomes the `- [ ] ` every other Markdown reader knows, written
 * through the editor so one undo gives the two dashes back, and the switch
 * is thrown when it was off: a box that showed as brackets would not be
 * the box that was asked for.
 */
export function expandTaskShortcut(event) {
  // editor.insert() raises an input event of its own with no data, so the
  // rewrite below cannot answer itself.
  if (event.inputType !== 'insertText' || event.data !== ' ') return
  const {start, end} = editor.selection()
  if (start !== end) return
  const text = article.textContent
  // shortcut: an email signature line "-- " also becomes a box, add an escape if that bites
  if (!/^[ \t]*-- $/.test(text.slice(text.lastIndexOf('\n', start - 1) + 1, start))) return
  // The switch first: it redraws the note, and the caret would not survive
  // a redraw that came after the insert had placed it.
  if (!tasksEnabled()) toggleTasks()
  editor.select(start - 3, start)
  editor.insert('- [ ] ')
}

/**
 * Build the backlinks panel the first time anything wants it.
 *
 * The import is the point: the whole feature is off until its switch is
 * thrown, and the panel module is fetched on the click that throws it.
 * Two clicks racing the first import would otherwise build it twice - the
 * second continuation finds the panel the first one left behind.
 */
export async function ensureBacklinksPanel() {
  if (backlinksPanel) return backlinksPanel
  const {createBacklinksPanel} = await import('./backlinks-panel.js')
  if (backlinksPanel) return backlinksPanel

  backlinksPanel = createBacklinksPanel({
    onOpen: (entry) => {
      void openDocument(entry)
    },
  })
  // The panel has its own close button, which is not the menu, so the menu
  // row and the panel have to be told about each other in both directions.
  backlinksPanel.onDismiss(() => {
    setBacklinksPreferred(false)
    emit('menu')
  })
  document.body.append(backlinksPanel.element)
  return backlinksPanel
}

export function backlinksIsOpen() {
  return backlinksPanel?.isOpen() ?? false
}

/**
 * Tell the backlinks panel what is on screen, if it has been opened.
 *
 * The panel answers only for its own title, so this is free while nothing
 * moved: a save that did not rename the note costs one comparison.
 *
 * @param {string} [text] the note to answer for; defaults to the editor
 */
export function updateBacklinks(text = article.textContent) {
  backlinksPanel?.update(text, {mentions: backlinkMentionsEnabled()})
}

/**
 * Answer the panel again even though the title did not move - the library
 * lost one of the notes it was showing, or the mentions choice changed.
 */
export function refreshBacklinks() {
  backlinksPanel?.update(article.textContent, {
    mentions: backlinkMentionsEnabled(),
    force: true,
  })
}

export async function applyBacklinksPreference() {
  if (backlinksPreferred()) {
    const panel = await ensureBacklinksPanel()
    panel.open(article.textContent, {mentions: backlinkMentionsEnabled()})
    trackGlass(panel.element)
  }
  emit('menu')
}

export async function toggleBacklinks() {
  const panel = await ensureBacklinksPanel()
  const next = panel.toggle(article.textContent, {mentions: backlinkMentionsEnabled()})
  if (next) trackGlass(panel.element)
  setBacklinksPreferred(next)
  emit('menu')
}

/**
 * Build the tasks panel the first time the menu row asks for it.
 *
 * The same bargain as the backlinks panel: the module arrives on the
 * click that opens it, so a reader who keeps the checkboxes in their
 * notes but never wants the overview never pays for the panel either.
 */
export async function ensureTasksPanel() {
  if (tasksPanel) return tasksPanel
  const {createTasksPanel} = await import('./tasks-panel.js')
  if (tasksPanel) return tasksPanel

  tasksPanel = createTasksPanel({
    onOpen: (entry) => {
      void openDocument(entry)
    },
  })
  // The close button closes the panel, not the feature: the checkboxes
  // in the notes stay either way, so - unlike the backlinks panel -
  // there is no preference to hand back here.
  document.body.append(tasksPanel.element)
  return tasksPanel
}

/**
 * Open the tasks panel, or shut it if it is up.
 *
 * The menu row is a switch-gated action like Backup's: it only exists
 * while the feature is on, and it only builds the panel on the click
 * that first needs it.
 */
export async function toggleTasksPanel() {
  const panel = await ensureTasksPanel()
  const open = panel.toggle({done: tasksDoneEnabled()})
  if (open) trackGlass(panel.element)
}

/**
 * Answer the tasks panel again, if it is showing.
 *
 * The question is the whole library, and a save is how a checkbox click
 * reaches the answer - so this rides along with the same news the
 * statistics panel gets, and costs nothing while the panel is shut.
 */
export function updateTasks() {
  tasksPanel?.update({done: tasksDoneEnabled()})
}

/** The writing tools panel, built the first time anything asks for it. */
let writingPanel = null

/**
 * Build the writing tools panel the first time anything wants it.
 *
 * The same shape as the backlinks panel: the import is the point, the
 * feature sits behind its switch, and the module arrives on the click
 * that throws it. Inside, the engine is a second, deeper lazy step -
 * gemma.js is fetched only when a tool is actually run, and it reaches
 * the vendored wasm only after every committed chunk checks out.
 */
export async function ensureWritingPanel() {
  if (writingPanel) return writingPanel
  const {createWritingTools, TOOLS} = await import('./writing-tools.js')
  if (writingPanel) return writingPanel

  writingPanel = createWritingTools({
    ensureModel: async (onProgress, signal, model) => {
      const {loadEngine} = await import('./gemma.js')
      return loadEngine({model, onProgress, signal})
    },
    getModel: writingModel,
    setModel: setWritingModel,
    getText: () => article.textContent,
    // The reader's own selection, in the same flat offsets the editor and
    // the find bar speak in - read at the moment Run is pressed, from the
    // editor whether or not it still holds focus.
    getSelection: () => editor.selection(),
    selectionAware: selectionToolsEnabled,
    // The ids come from the panel's own TOOLS, captured here where the
    // module is already in hand, so the switches the settings panel
    // draws and the buttons the panel draws can never drift apart.
    getTools: () => TOOLS.filter((tool) => writingToolEnabled(tool.id)).map((tool) => tool.id),
    getInstructions: writingInstructions,
    // The result goes back the way a folder sync's edit does: through the
    // editor, so it lands on the undo stack, then a save so the hash, the
    // library and the mirror follow it. With a selection from the Run, the
    // answer goes where that Run looked - the offsets restored first, then
    // inserted over, the same two calls find's replace makes. Without one,
    // the whole note, as it always was. The notification names the way back
    // rather than asking first - the reader has already read the answer in
    // the panel before pressing the button.
    onReplace: (text, selection) => {
      if (selection) {
        editor.select(selection.start, selection.end)
        editor.insert(text)
      } else {
        editor.replace(text)
      }
      void save()
      notify(
        !selection
          ? 'Note replaced — Ctrl+Z or ⌘Z undoes it'
          : selection.start === selection.end
            ? 'Inserted — Ctrl+Z or ⌘Z undoes it'
            : 'Selection replaced — Ctrl+Z or ⌘Z undoes it',
        {duration: 4000},
      )
    },
  })
  writingPanel.onDismiss(() => {
    setWritingPreferred(false)
    emit('menu')
  })
  document.body.append(writingPanel.element)
  return writingPanel
}

export function writingIsOpen() {
  return writingPanel?.isOpen() ?? false
}

export async function applyWritingPreference() {
  if (writingPreferred()) {
    const panel = await ensureWritingPanel()
    panel.open()
    trackGlass(panel.element)
  }
  emit('menu')
}

export async function toggleWriting() {
  const panel = await ensureWritingPanel()
  const next = panel.toggle()
  if (next) trackGlass(panel.element)
  setWritingPreferred(next)
  emit('menu')
}

/** The speech to text panel, built the first time the menu asks for it. */
let speechPanel = null

/**
 * Open the speech to text panel, building it on the first call.
 *
 * Lazy twice over, like the writing tools: the panel module arrives on the
 * click, and whisper.js - with the worker, the wasm and the weights behind
 * it - only when there is audio to transcribe.
 */
export async function openSpeech() {
  if (!speechPanel) {
    const {createSpeechPanel} = await import('./speech-panel.js')
    speechPanel ??= createSpeechPanel({
      ensureModel: async (onProgress, signal, model) => {
        const {loadEngine} = await import('./whisper.js')
        return loadEngine({model, onProgress, signal})
      },
      decode: async (blob) => {
        const {decodeAudio} = await import('./whisper.js')
        return decodeAudio(blob)
      },
      getLanguage: speechLanguage,
      setLanguage: setSpeechLanguage,
      getModel: speechModel,
      setModel: setSpeechModel,
      // At the caret, or over the selection, wherever the reader left it
      // while the transcript was on its way: through the editor, so it lands
      // on the undo stack, then a save, the way a writing tool's answer goes.
      onInsert: (text) => {
        editor.insert(text)
        void save()
        notify('Transcript inserted — Ctrl+Z or ⌘Z undoes it', {duration: 4000})
      },
      canOrganise: organiseEnabled,
      onOrganise: organise,
    })
    document.body.append(speechPanel.element)
  }
  speechPanel.open()
  trackGlass(speechPanel.element)
}

/**
 * Organise by voice: the transcript and the notes go through the writing
 * model, and the answer becomes a new note drawn as a board. Notes that are
 * boards already are left out except the newest, which is the progress the
 * new update is measured against.
 */
async function organise(spoken, {allNotes, say}) {
  try {
    await save()
    const [{loadEngine}, {boardNote, buildOrganisePrompt}] = await Promise.all([import('./gemma.js'), import('./organise.js')])
    let notes = [{text: article.textContent}]
    if (allNotes) {
      const all = await listDocuments()
      const boards = all.filter((entry) => BOARD.test(entry.text ?? ''))
      notes = [...all.filter((entry) => !BOARD.test(entry.text ?? '')), ...boards.slice(0, 1)]
    }
    const engine = await loadEngine({model: 'minicpm5', onProgress: (message) => say(message)})
    say('Organising…')
    const {messages, truncated} = buildOrganisePrompt(spoken, notes)
    const answer = await engine.run(messages)
    setDocumentId(newId())
    editor.replace(boardNote(answer))
    await save()
    say(truncated ? 'Organised. Only the newest notes fitted, so older ones were left out.' : 'Organised into a board.')
  } catch (error) {
    say(error?.message || String(error), {error: true})
  }
}

/** An organised note, as boardNote() titles it. */
const BOARD = /^# Organised /

/** The board panel, built the first time an organised note is on screen. */
let board = null
/** The note whose board the reader closed: it stays closed for that note. */
let boardClosedFor = null

async function updateBoard() {
  const text = article.textContent
  if (!board && !(organiseEnabled() && BOARD.test(text))) return
  if (!board) {
    const {createBoard} = await import('./board-panel.js')
    board ??= createBoard({
      onChange: (next) => {
        editor.replace(next)
        void save()
      },
      onClose: () => {
        boardClosedFor = documentId()
      },
    })
    document.body.append(board.element)
  }
  const isBoard = organiseEnabled() && BOARD.test(text) && board.update(text)
  if (isBoard && boardClosedFor !== documentId()) board.open()
  else if (!isBoard) board.close()
}

/**
 * Follow a `[[wikilink]]`.
 *
 * The title is matched against the library the way the documents panel
 * would match it: case insensitively, on the first note whose heading says
 * it. No match is either a note made on the spot - a `# heading`, which is
 * what names a note everywhere else here - or a plain word about it,
 * whichever the choice under the switch says.
 *
 * @param {string} title the text between the brackets
 */
export async function openWikiLink(title) {
  const entries = await listDocuments()
  const wanted = title.trim().toLowerCase()
  const found = entries.find((entry) => entry.title?.toLowerCase() === wanted)
  if (found) {
    await switchDocument(found)
    return
  }

  if (!wikiCreateEnabled()) {
    notify(`No note is titled “${title}”`)
    return
  }

  await newDocument({ask: !(await canLeaveNote())})
  // The reader was asked before the editor was emptied and said no, so the
  // click ends here rather than writing a heading over their work.
  if (article.textContent.trim() !== '') return
  editor.replace(`# ${title}`)
  await save()
  notify(`Created “${title}”`)
}

export function applyStatsPreference() {
  if (statsPreferred()) {
    statsPanel.open(article.textContent)
    trackGlass(statsPanel.element)
  } else {
    statsPanel.close()
  }
  emit('menu')
}

export function toggleStats() {
  const next = statsPanel.toggle(article.textContent)
  if (next) trackGlass(statsPanel.element)
  setStatsPreferred(next)
  emit('menu')
}

export function toggleGlass() {
  setGlassEnabled(!glassEnabled())
  emit('menu')
}

export function switcherIsOpen() {
  return switcher?.isOpen() ?? false
}

/**
 * Build the bar if this is the first press, then open it.
 *
 * Two presses racing the import would otherwise build it twice: the check
 * runs again once the module has arrived, and the second caller opens the
 * bar the first one left standing.
 */
export async function openSwitcher() {
  if (!switcher) {
    const {createSwitcher} = await import('./switcher.js')
    if (!switcher) {
      switcher = createSwitcher({
        // Everything in one list: the notes, then what the shell can do,
        // then every menu row - so a few letters reach any of them.
        list: async () => [...(await listDocuments()), ...shellCommands(), ...commands()],
        onOpen: (entry) => {
          if (entry.run) entry.run()
          else void switchDocument(entry)
        },
      })
      document.body.append(switcher.element)
    }
  }
  // Built once and kept: if anything took it out of the page, it goes back.
  if (!switcher.element.isConnected) document.body.append(switcher.element)
  switcher.open({scope: switcherScope()})
}

/**
 * Build the bar if this is the first press, then open it - the switcher's
 * double-checked import, for the same reason: two presses racing the module
 * would otherwise build two bars.
 */
export async function openFind() {
  if (!find) {
    const {createFind} = await import('./find-panel.js')
    if (!find) {
      find = createFind({
        getNote: () => article.textContent || '',
        selection: () => editor.selection(),
        select: (start, end) => editor.select(start, end),
        insert: (text) => editor.insert(text),
        replace: (text) => editor.replace(text),
        notify: (message) => notify(message),
        // The two defaults live here and in Settings, pointing at one
        // preference each - the bar's checkboxes and the panel's rows move
        // the same values, so the two can never disagree about them.
        prefs: {
          getCase: findCase,
          setCase: setFindCase,
          getWords: findWords,
          setWords: setFindWords,
        },
      })
      document.body.append(find.element)
    }
  }
  find.open()
}

/**
 * The sidebar's actions, for the switcher's list. lib/shell.js hands them
 * over at boot rather than being imported here, since it imports this.
 */
let shellCommands = () => []
export function setShellCommands(list) {
  shellCommands = list
}

/** The command palette, built the first time its chord is pressed. */
let palette = null

/**
 * Every action the app has, in one filterable list.
 *
 * The list is read off the menu at the moment the palette opens - each
 * visible row, under the label it is showing, run by clicking it - so the
 * palette cannot offer an action the menu would not, name one differently,
 * or fall behind when a row is added. The two features that live on a chord
 * instead of a row are added by hand.
 */
function commands() {
  emit('menu')
  const rows = [...document.querySelectorAll('#menu .item:not([hidden])')].map((row) => ({
    title: row.textContent.trim().replace(/\s+/g, ' '),
    run: () => row.click(),
  }))
  if (findEnabled()) rows.push({title: 'Find and replace', run: () => void openFind()})
  if (switcherEnabled()) rows.push({title: 'Jump to a note', run: () => void openSwitcher()})
  return rows
}

/** The switcher's own dialog over a different list: commands, not notes. */
export async function openPalette() {
  if (!palette) {
    const {createSwitcher} = await import('./switcher.js')
    if (!palette) {
      palette = createSwitcher({
        list: commands,
        onOpen: (command) => command.run(),
        words: {
          id: 'palette',
          label: 'Command palette',
          placeholder: 'Run a command…',
          filter: 'Filter commands',
          matches: 'Matching commands',
          empty: 'No command matches.',
          help: 'Arrow keys move, Enter runs, Escape closes.',
        },
      })
      document.body.append(palette.element)
    }
  }
  if (palette.isOpen()) palette.close()
  else palette.open()
}

/** The Settings panel moved a preference an open panel or bar is showing. */
export function refreshWriting() {
  writingPanel?.refresh()
}

export function refreshFind() {
  find?.refresh()
}

export function closeSwitcher() {
  switcher?.close()
}

/**
 * Save is the app's own name for exporting, so the menu row and Ctrl/Cmd+S
 * both open the panel rather than picking a format behind the reader's back.
 */
export async function openExport() {
  const {exportInteractive} = await import('./export-panel.js')
  exportInteractive(article, {
    notify: (message, isError) => notify(message, {error: Boolean(isError)}),
    encrypted: state.encrypted,
  })
}

// A save, a load, a new note: every panel that says something about the
// note answers again. Each of these costs nothing while its panel is shut.
on('note', () => {
  statsPanel.update(article.textContent)
  updateBacklinks()
  updateTasks()
  writingPanel?.refresh()
  void updateBoard()
})
