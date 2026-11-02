// The reader's switches, each one a key in localStorage.
//
// Every preference is a get/set pair over one `textarea:*` key, and the menu,
// the Settings panel and the code that acts on a switch all read the same
// pair, so no two of them can disagree about which way it points. The key
// names and the stored values are a contract with every browser profile that
// already holds them: nothing here may be renamed.
//
// Storage that refuses (a private window, a full quota) never throws out of
// here. A read answers the shipped default and a write is dropped, so the
// switch still works until the tab closes.

function read(key) {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Storage refused: the choice is simply not remembered.
  }
}

/**
 * An on/off switch. `shipped` is what a profile that never touched it gets:
 * a switch that ships on is on unless the stored value is 'off', and one that
 * ships off is off unless the stored value is 'on', so a stray value in
 * storage can never flip a default.
 */
function flag(key, shipped) {
  return [
    () => (shipped ? read(key) !== 'off' : read(key) === 'on'),
    (on) => write(key, on ? 'on' : 'off'),
  ]
}

// The three validators are pure and exported for the tests: whatever string
// is in storage, only a value the Settings panel offers ever comes back, so
// no stored string decides which key is intercepted or when a note is purged.

/** @returns {'k' | 'p' | 'e'} */
export const shortcutOf = (stored) => (stored === 'p' || stored === 'e' ? stored : 'k')

/** @returns {'titles' | 'all'} */
export const scopeOf = (stored) => (stored === 'all' ? 'all' : 'titles')

/** @returns {'7' | '30' | '90'} */
export const keepDaysOf = (stored) => (stored === '7' || stored === '90' ? stored : '30')

/** @returns {'updated' | 'created' | 'title'} */
export const sortOf = (stored) => (stored === 'created' || stored === 'title' ? stored : 'updated')

/** @returns {'board' | 'timeline'} */
export const viewOf = (stored) => (stored === 'timeline' ? 'timeline' : 'board')

/**
 * The saved filters as they may be trusted: at most twenty, each a short name
 * and a short query, whatever the stored string actually holds.
 *
 * @returns {Array<{name: string, query: string}>}
 */
export function filtersOf(stored) {
  let list
  try {
    list = JSON.parse(stored ?? '[]')
  } catch {
    return []
  }
  if (!Array.isArray(list)) return []
  return list
    .filter((item) => typeof item?.name === 'string' && typeof item?.query === 'string')
    .map(({name, query}) => ({name: name.trim().slice(0, 40), query: query.trim().slice(0, 200)}))
    .filter((item) => item.name && item.query)
    .slice(0, 20)
}

/** A whole number of words from 1 to a million, or 0 for "no goal". */
export function goalOf(stored) {
  const words = Math.floor(Number(stored))
  return words >= 1 && words <= 1_000_000 ? words : 0
}

// Reading PDFs and drawing the note.
export const [twoColumnsEnabled, setTwoColumns] = flag('textarea:two-columns', true)
export const [fileLinksEnabled, setFileLinks] = flag('textarea:file-links', true)
// Off as it ships, so a note written without this fork renders as it always did.
// textarea-plus ships these on: page links, cards and the graph stand on them.
export const [wikilinksEnabled, setWikilinks] = flag('textarea:wikilinks', true)
export const [wikiCreateEnabled, setWikiCreate] = flag('textarea:wikilink-create', true)
export const [tasksEnabled, setTasksEnabled] = flag('textarea:tasks', true)
export const [tasksDoneEnabled, setTasksDoneEnabled] = flag('textarea:tasks-done', false)

// Panels remember whether they were left open.
export const [statsPreferred, setStatsPreferred] = flag('textarea:stats', false)
export const [backlinksPreferred, setBacklinksPreferred] = flag('textarea:backlinks', false)
// A mention is a weaker claim than a link, so it waits to be asked for.
export const [backlinkMentionsEnabled, setBacklinkMentions] = flag('textarea:backlink-mentions', false)
export const [writingPreferred, setWritingPreferred] = flag('textarea:writing', false)
export const [selectionToolsEnabled, setSelectionToolsEnabled] = flag('textarea:writing-selection', false)

/** Each writing tool has its own switch, on unless the reader threw it off. */
export const writingToolEnabled = (id) => read('textarea:writing-tool-' + id) !== 'off'
export const setWritingTool = (id, on) => write('textarea:writing-tool-' + id, on ? 'on' : 'off')

/** The sentence appended to every prompt, empty until one is written. */
export const writingInstructions = () => read('textarea:writing-instructions') ?? ''
export const setWritingInstructions = (value) => write('textarea:writing-instructions', value)
/** The writing model, by its id in lib/writing-tools.js; null until the reader picks one. */
export const writingModel = () => read('textarea:writing-model')
export const setWritingModel = (id) => write('textarea:writing-model', id)

/** The language speech is transcribed as; null until the reader picks one. */
export const speechLanguage = () => read('textarea:speech-language')
export const setSpeechLanguage = (code) => write('textarea:speech-language', code)
/** The speech model, by its id in lib/speech-panel.js; null until the reader picks one. */
export const speechModel = () => read('textarea:speech-model')
export const setSpeechModel = (id) => write('textarea:speech-model', id)

// The quick switcher: on, because until its chord is pressed it is one listener.
export const [switcherEnabled, setSwitcherEnabled] = flag('textarea:switcher', true)
export const switcherScope = () => scopeOf(read('textarea:switcher-scope'))
export const setSwitcherScope = (scope) => write('textarea:switcher-scope', scopeOf(scope))
export const switcherShortcut = () => shortcutOf(read('textarea:switcher-shortcut'))
export const setSwitcherShortcut = (key) => write('textarea:switcher-shortcut', shortcutOf(key))

// Find claims Ctrl/Cmd+F while it is on, and hands the chord back whole when off.
export const [findEnabled, setFindEnabled] = flag('textarea:find', true)
export const [findCase, setFindCase] = flag('textarea:find-case', false)
export const [findWords, setFindWords] = flag('textarea:find-words', false)

// Backup: the front matter is what lets Folder sync recognise a restored file.
export const [backupEnabled, setBackupEnabled] = flag('textarea:backup', true)
export const [backupMetadata, setBackupMetadata] = flag('textarea:backup-metadata', true)
export const [backupEncrypt, setBackupEncrypt] = flag('textarea:backup-encrypt', false)
// New in this rebuild: every note in one Markdown file instead of an archive.
export const [backupSingleFile, setBackupSingleFile] = flag('textarea:backup-single', false)

// Trash: a delete waits here unless the reader says deletes are for good.
export const [trashEnabled, setTrashEnabled] = flag('textarea:trash', true)
export const trashKeep = () => keepDaysOf(read('textarea:trash-keep'))
export const setTrashKeep = (days) => write('textarea:trash-keep', String(days))

// New in this rebuild, all off (or unchanged behaviour) as they ship.
export const [paletteEnabled, setPaletteEnabled] = flag('textarea:palette', false)
export const librarySort = () => sortOf(read('textarea:library-sort'))
export const setLibrarySort = (sort) => write('textarea:library-sort', sortOf(sort))
// Tags ship on: a `#word` drawn in colour changes no note, and a feature
// that waits behind a switch is one nobody finds.
export const [tagsEnabled, setTagsEnabled] = flag('textarea:tags', true)
export const libraryView = () => viewOf(read('textarea:library-view'))
export const setLibraryView = (view) => write('textarea:library-view', viewOf(view))
export const savedFilters = () => filtersOf(read('textarea:filters'))
export const setSavedFilters = (list) => write('textarea:filters', JSON.stringify(filtersOf(JSON.stringify(list))))
export const wordGoal = () => goalOf(read('textarea:word-goal'))
export const setWordGoal = (words) => write('textarea:word-goal', String(goalOf(words)))

// Organise by voice and the sticky note: off as they ship, and nothing of
// either is fetched until its switch is thrown.
export const [organiseEnabled, setOrganiseEnabled] = flag('textarea:organise', false)
export const [stickyEnabled, setStickyEnabled] = flag('textarea:sticky', false)

// textarea-plus: the sidebar, which view it shows, and the tabs above the
// note. The tabs are note ids as JSON; lib/views.js liveTabs() takes back
// only the ids that are still notes, whatever was stored.
export const [remindersEnabled, setRemindersEnabled] = flag('textarea:reminders', false)
export const [sidebarOpen, setSidebarOpen] = flag('textarea:sidebar', true)
export const sidebarView = () => read('textarea:sidebar-view')
export const setSidebarView = (id) => write('textarea:sidebar-view', id)
export function openTabs() {
  try {
    return JSON.parse(read('textarea:tabs') ?? '[]')
  } catch {
    return []
  }
}
export const setOpenTabs = (ids) => write('textarea:tabs', JSON.stringify(ids))
