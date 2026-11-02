// The rows of the Settings panel, fetched with the panel on the click that
// opens it - never at boot.
//
// The panel carries the switches the menu carries, as get/set pairs against
// the same preferences, so the two can never disagree about which way a
// switch is pointing. Each setter is the menu's own handler, guarded so a
// click that would not change anything does not ring the notification
// bubble either.

import {
  backlinksIsOpen,
  refreshBacklinks,
  refreshFind,
  refreshWriting,
  statsPanel,
  toggleBacklinks,
  toggleFileLinks,
  toggleGlass,
  toggleStats,
  toggleTags,
  toggleTasks,
  toggleTwoColumns,
  toggleWikilinks,
  toggleWriting,
  updateTasks,
  writingIsOpen,
} from './features.js'
import {glassAvailable, glassEnabled} from './glass.js'
import {isAvailable as libraryAvailable} from './library.js'
import {
  backlinkMentionsEnabled,
  backupEnabled,
  backupEncrypt,
  backupMetadata,
  backupSingleFile,
  fileLinksEnabled,
  findCase,
  findEnabled,
  findWords,
  paletteEnabled,
  selectionToolsEnabled,
  setBacklinkMentions,
  setBackupEnabled,
  setBackupEncrypt,
  setBackupMetadata,
  setBackupSingleFile,
  setFindCase,
  setFindEnabled,
  setFindWords,
  setPaletteEnabled,
  setSelectionToolsEnabled,
  setSwitcherEnabled,
  setSwitcherScope,
  setSwitcherShortcut,
  setTasksDoneEnabled,
  setTrashEnabled,
  setTrashKeep,
  setWikiCreate,
  setWordGoal,
  setOrganiseEnabled,
  setStickyEnabled,
  setWritingInstructions,
  setWritingTool,
  organiseEnabled,
  stickyEnabled,
  switcherEnabled,
  switcherScope,
  switcherShortcut,
  tagsEnabled,
  tasksDoneEnabled,
  tasksEnabled,
  trashEnabled,
  trashKeep,
  twoColumnsEnabled,
  wikiCreateEnabled,
  wikilinksEnabled,
  wordGoal,
  writingInstructions,
  writingToolEnabled,
} from './prefs.js'
import {emit} from './signals.js'
// The writing tools' options name their tools, and those names have one
// home: the panel module's own TOOLS, which is what keeps a switch's label
// the button's label.
import {TOOLS} from './writing-tools.js'

export function settingsRows() {
  return [
    {
      id: 'glass',
      label: 'Glass refraction',
      available: glassAvailable,
      get: glassEnabled,
      set: (on) => {
        if (glassEnabled() !== on) toggleGlass()
      },
    },
    {
      id: 'stats',
      label: 'Statistics panel',
      get: () => statsPanel.isOpen(),
      set: (on) => {
        if (statsPanel.isOpen() !== on) toggleStats()
      },
      options: [
        {
          id: 'goal',
          label: 'Word-count goal (leave empty for none)',
          kind: 'text',
          placeholder: 'e.g. 500',
          get: () => (wordGoal() ? String(wordGoal()) : ''),
          set: (value) => {
            setWordGoal(value)
            statsPanel.update(document.querySelector('article').textContent)
          },
        },
      ],
    },
    {
      id: 'backlinks',
      label: 'Backlinks panel',
      get: backlinksIsOpen,
      set: (on) => {
        if (backlinksIsOpen() !== on) void toggleBacklinks()
      },
      options: [
        {
          id: 'mentions',
          label: 'Also count plain mentions of the title',
          get: backlinkMentionsEnabled,
          set: (on) => {
            if (backlinkMentionsEnabled() === on) return
            setBacklinkMentions(on)
            // The title did not move, but the answer did.
            refreshBacklinks()
          },
        },
      ],
    },
    {
      id: 'writing',
      label: 'Writing tools',
      get: writingIsOpen,
      set: (on) => {
        if (writingIsOpen() !== on) void toggleWriting()
      },
      // The switches under the panel are the shelf the panel draws:
      // one row per tool, from the same list, and a line of prose the
      // reader can append to every prompt. A shelf changed here is
      // redrawn in the open panel at once, because both read the same
      // preferences and the panel is pushed the news when they move.
      options: [
        ...TOOLS.map((tool) => ({
          id: tool.id,
          label: tool.label,
          get: () => writingToolEnabled(tool.id),
          set: (on) => {
            setWritingTool(tool.id, on)
            refreshWriting()
          },
        })),
        {
          id: 'selection',
          label: 'Work on the selection when there is one',
          get: selectionToolsEnabled,
          set: (on) => {
            setSelectionToolsEnabled(on)
            refreshWriting()
          },
        },
        {
          id: 'instructions',
          label: 'Extra instructions for every tool',
          kind: 'text',
          placeholder: 'e.g. keep it short, use British English',
          get: writingInstructions,
          set: (value) => {
            setWritingInstructions(value)
            refreshWriting()
          },
        },
      ],
    },
    {
      id: 'switcher',
      label: 'Quick switcher',
      get: switcherEnabled,
      set: (on) => {
        if (switcherEnabled() !== on) setSwitcherEnabled(on)
      },
      options: [
        {
          id: 'scope',
          label: 'Search in',
          kind: 'select',
          choices: [
            {value: 'titles', label: 'Titles only'},
            {value: 'all', label: 'Titles and text'},
          ],
          get: switcherScope,
          set: (value) => {
            if (switcherScope() !== value) setSwitcherScope(value)
          },
        },
        {
          id: 'shortcut',
          label: 'Keyboard shortcut',
          kind: 'select',
          choices: [
            {value: 'k', label: 'Ctrl/Cmd + K'},
            {value: 'p', label: 'Ctrl/Cmd + P'},
            {value: 'e', label: 'Ctrl/Cmd + E'},
          ],
          get: switcherShortcut,
          set: (value) => {
            if (switcherShortcut() !== value) setSwitcherShortcut(value)
          },
        },
      ],
    },
    {
      id: 'palette',
      label: 'Command palette (Ctrl/Cmd + Shift + P)',
      get: paletteEnabled,
      set: (on) => {
        if (paletteEnabled() !== on) setPaletteEnabled(on)
      },
    },
    {
      id: 'find',
      label: 'Find and replace',
      get: findEnabled,
      set: (on) => {
        if (findEnabled() !== on) setFindEnabled(on)
      },
      // The two defaults the bar opens with, in step with the
      // checkboxes in the bar itself - one preference, two faces, and
      // an open bar repaints when a face moves.
      options: [
        {
          id: 'case',
          label: 'Match case by default',
          get: findCase,
          set: (on) => {
            if (findCase() !== on) setFindCase(on)
            refreshFind()
          },
        },
        {
          id: 'words',
          label: 'Whole words by default',
          get: findWords,
          set: (on) => {
            if (findWords() !== on) setFindWords(on)
            refreshFind()
          },
        },
      ],
    },
    {
      id: 'backup',
      label: 'Backup',
      available: () => libraryAvailable(),
      get: backupEnabled,
      set: (on) => {
        if (backupEnabled() !== on) {
          setBackupEnabled(on)
          // The switch and the row it gates travel together: off, the
          // menu has nothing to offer here, so the row leaves at once
          // rather than at the next re-render.
          emit('menu')
        }
      },
      // What goes in the archive, in the same order the flow meets it.
      options: [
        {
          id: 'metadata',
          label: 'Include note metadata (front matter)',
          get: backupMetadata,
          set: (on) => {
            if (backupMetadata() !== on) setBackupMetadata(on)
          },
        },
        {
          id: 'encrypt',
          label: 'Encrypt with a password',
          get: backupEncrypt,
          set: (on) => {
            if (backupEncrypt() !== on) setBackupEncrypt(on)
          },
        },
        {
          id: 'single',
          label: 'Write one Markdown file instead of an archive (never encrypted)',
          get: backupSingleFile,
          set: (on) => {
            if (backupSingleFile() !== on) setBackupSingleFile(on)
          },
        },
      ],
    },
    {
      id: 'trash',
      label: 'Trash (recover deleted notes)',
      available: () => libraryAvailable(),
      get: trashEnabled,
      set: (on) => {
        if (trashEnabled() !== on) {
          setTrashEnabled(on)
          // The switch and the row it gates travel together, the same as
          // Backup's: off, the menu has nothing to offer here.
          emit('menu')
        }
      },
      options: [
        {
          id: 'keep',
          label: 'Keep deleted notes for',
          kind: 'select',
          choices: [
            {value: '7', label: '7 days'},
            {value: '30', label: '30 days'},
            {value: '90', label: '90 days'},
          ],
          get: trashKeep,
          set: (value) => {
            if (trashKeep() !== value) setTrashKeep(value)
          },
        },
      ],
    },
    {
      id: 'columns',
      label: 'Two column PDFs',
      get: twoColumnsEnabled,
      set: (on) => {
        if (twoColumnsEnabled() !== on) toggleTwoColumns()
      },
    },
    {
      id: 'filelinks',
      label: 'File links',
      available: () => 'showOpenFilePicker' in window,
      get: fileLinksEnabled,
      set: (on) => {
        if (fileLinksEnabled() !== on) toggleFileLinks()
      },
    },
    {
      id: 'wikilinks',
      label: 'Wikilinks',
      get: wikilinksEnabled,
      set: (on) => {
        if (wikilinksEnabled() !== on) toggleWikilinks()
      },
      options: [
        {
          id: 'create',
          label: 'Create the note when a title matches nothing',
          get: wikiCreateEnabled,
          set: (on) => {
            if (wikiCreateEnabled() !== on) setWikiCreate(on)
          },
        },
      ],
    },
    {
      id: 'organise',
      label: 'Organise by voice (speech to text sorts your notes into a board; downloads 1.8 GB on first use)',
      get: organiseEnabled,
      set: (on) => {
        setOrganiseEnabled(on)
        // An organised note on screen gains or loses its board.
        emit('note')
      },
    },
    {
      id: 'sticky',
      label: 'Sticky note (the note in a small window that stays on top)',
      // lib/sticky.js's own test, inlined so the module stays off the boot.
      available: () => 'documentPictureInPicture' in window,
      get: stickyEnabled,
      set: (on) => {
        setStickyEnabled(on)
        emit('menu')
      },
    },
    {
      id: 'tags',
      label: 'Tags',
      get: tagsEnabled,
      set: (on) => {
        if (tagsEnabled() !== on) toggleTags()
      },
    },
    {
      id: 'tasks',
      label: 'Tasks',
      get: tasksEnabled,
      set: (on) => {
        if (tasksEnabled() !== on) toggleTasks()
      },
      options: [
        {
          id: 'done',
          label: 'Also show completed tasks in the panel',
          get: tasksDoneEnabled,
          set: (on) => {
            if (tasksDoneEnabled() === on) return
            setTasksDoneEnabled(on)
            // The notes did not move, but the answer did.
            updateTasks()
          },
        },
      ],
    },
  ]
}
