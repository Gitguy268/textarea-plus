# Architecture

Textarea is a single page with no build step: `index.html`, `app.js`, `lib/`,
deployed as static files. The primary copy of a note is the address bar —
compressed into the URL hash — and everything else (the library, the folder
mirror, the exported files) is a copy made from that. This document is the map
of which file owns which part of that story, and how a note moves between them.
For how to work on it, see [CONTRIBUTING.md](../CONTRIBUTING.md).

## The Module Map

```
index.html   markup, the menu, all of the CSS, the inline icon symbols
app.js       the entry: wires lib/ together, boots, exposes the test seam
lib/         one module per concern
models/      the on-device model, in transport chunks, checked before it runs
tests/       unit tests (pure modules, under Node) and the browser suite
vendor/      third-party code, each with its own licence, all lazy
docs/        this file, and PARITY.md: each feature and the test that guards it
```

What used to be one 2,850-line `app.js` is the shell, and it is these modules
now, each importing only the ones above it in this list:

```
signals.js        on() and emit(): 'note' (the text changed or was saved) and
                  'menu' (something a row displays moved)
prefs.js          every textarea:* preference as a get/set pair
editor.js         the contenteditable editor, its undo stack, debounce()
notify.js         the notification bubble
note.js           the note: article, editor, state, save(), load(), the
                  library claim, the autosave and its flush, encrypted links
features.js       the side panels, the find bar, the switcher, the command
                  palette, and the switches that change how a note is drawn
files.js          files coming in: the input, drag and drop, "Open with"
menu.js           the menu, what each row says and does, the theme row
shortcuts.js      the page-wide keyboard chords
shell.js          textarea-plus: the sidebar of views and the tabs above the
                  note, drawn around <main>; hands its actions to the
                  switcher through setShellCommands() in features.js
sync.js           folder sync as the app sees it: the same calls, with the
                  engine (folder-sync.js) fetched only when there is a folder
filename.js       a title made safe to be a filename
read-note.js      the note as every exporter takes it
settings-rows.js  the rows of the Settings panel - fetched with the panel
attachments.js    textarea-plus: pictures and files a note refers to, in a
                  database of their own (`textarea-attachments`)
slash.js          textarea-plus: the / menu; its matching rules are pure
properties.js     textarea-plus: key:: value lines of a note, read and rewritten (pure)
database.js       textarea-plus: a note as a saved query, its rows and columns (pure)
database-panel.js textarea-plus: that database on screen, every edit written to a note
tasks.js          textarea-plus: task lines read and rewritten, quick add, the lists (pure)
tasks-view.js     textarea-plus: the Tasks screen, list, board, timeline and reminders
write-back.js     textarea-plus: writing to a note from outside the editor, one at a time

graph.js          textarea-plus: which notes link where, and their layout (pure)
graph-panel.js    textarea-plus: the graph dialog - fetched on the click
```

The two signals are what keep that list a list. `save()` in `note.js` has
news for four panels and the menu, all of which import `note.js`; rather than
import them back, it emits `'note'` and `'menu'`, and `features.js` and
`menu.js` listen. No module imports `app.js`, and no two import each other.

`lib/` falls into three groups by what they are allowed to touch:

- **Pure modules** — `prefs.js` (the preferences and their validators),
  `formats.js` (note → text/CSV/JSON/XML/RTF/LaTeX/YAML),
  `front-matter.js`, `stats.js`, `markdown.js`, the codecs in `share.js`,
  `switcher.js` (`filterNotes`, the quick switcher's ranking),
  `views.js` (which notes each sidebar view lists, the day's note, and the
  tabs' open and close order),
  `backlinks.js` (which notes reach this one), `filter.js` (what a query in
  My documents means: tags, days, pins, the archive, the tag counts and the
  calendar's days), `find.js` (the match ranges,
  the walk and the one-pass replace-all), the pure half of `fonts.js`
  (the signature sniff, the family and id shapes, and `rawGitHubUrl`, the
  host check the policy depends on), `writing-tools.js`'s `buildPrompt` (what
  the model is asked), and `planSync` inside `folder-sync.js`. Text in, text
  out; unit-tested under Node with no page, which is why the decision tables
  can be trusted.
- **Page modules** — `dialog.js` (the builder every panel is made from), the
  panels (`export`, `qr`, `encryption`, `library`, `stats`, `settings`,
  `backlinks`, `writing`, `find`, `tasks`), `theme.js`, `glass.js`,
  `appearance.js`, `clipboard.js`, `save.js`, `open.js`, `file-links.js`.
  They read and write the DOM.
- **Storage, handles and the engine** — `library.js` (IndexedDB: the
  documents store, the trash beside it, and the two-store move),
  `folder-sync.js` (the directory handle, around its pure `planSync`),
  `backup.js` (the library's one-ZIP archive in folder sync's format,
  fetched on the click), the other half of `fonts.js` (the shelf's own
  database, and `FontFace` as the browser's verdict on the bytes),
  `pdf.js` + `pdf-layout.js` (pdf.js behind a dynamic import), `zip.js`,
  `gemma.js` (the on-device model: verify the chunks, then run them),
  `whisper.js` + `whisper-worker.js` (the speech model, in a worker).

Dependencies point one way: `app.js` imports `lib/`, `lib/` imports `lib/`,
nothing imports `app.js` back. Nothing under `lib/` reaches `vendor/` or
`models/` except through a dynamic `import()` in `gemma.js`, or from inside
the worker `whisper.js` starts — the service
worker precaches the shell, answers `vendor/` and `/models/` cache-first the
first time a feature actually fetches them, and the startup guard test and
the service worker tests pin all of that down.

## The Note and the URL

The editor is a contenteditable article; the note's text is the source of truth
and the rendered markup is derived from it. On every input two things are
debounced: the highlight (30ms) and the history record (300ms), and half a
second after the last keystroke `save()` runs:

1. The text is encoded into the hash —
   `#<base64url(deflate-raw(text [+ "\0" + style]))>` — and the address bar is
   rewritten with `history.replaceState`, never `pushState`, so typing does not
   fill the back stack.
2. The row is written to the library (below).
3. The folder mirror is scheduled (`scheduleSync`), the title follows, and
   `'note'` is emitted, which is how the statistics, backlinks, tasks and
   writing panels hear about it.

The half second must never cost the last words typed, so two events cut it
short: `visibilitychange` to hidden and `pagehide` both call `flushSave()`.
A closing page never comes back from an `await`, and the ordinary save has
three of them (compress, read the row, write it), so the flush first writes
the library row with `putDocumentNow()`: one `put` and an explicit
`commit()` issued in the same turn of the event loop, on a connection that
is already open. That is the kind of write a browser still finishes once the
page is gone: closing a focused tab mid-keystroke twenty times kept the last
words twenty times in each of Chromium, Firefox and WebKit. The row is stamped with a hash no codec writes (`~`),
so a tab restored on the stale URL claims a fresh row instead of writing the
older note over the newer text. The row also records the address it was
typed under (`from`), and when a page load is a tab coming back on that same
address - a reload is the case that is tested; a restored session should
report itself the same way, but that is the browser's to say - `load()`
reopens the marked row itself, so the reader is back where they were with one
note, not two. The address matters because the row id in hand is shared by
every tab of the origin: without it, another tab reloading would open this
one's unfinished note. An
encrypted link is never replaced this way: the library's copy is plaintext
and the password has not been asked for. The ordinary save is then started as well,
for the tab that was only hidden. `save()` marks the note clean when it
finishes, not when it starts: closing a focused tab blurs the editor first,
and a blur-save that had already called the note clean would tell the flush
there was nothing to do.

**The highlight is a patch, not a rebuild.** `parseMarkdown()` builds the
nodes the text asks for, walks the article's children from the top and from
the bottom for as long as each `isEqualNode()` its counterpart, and swaps only
the stretch between. The editor hands it the new text directly instead of
flattening the article first, so an insertion, an undo or a find-and-replace
in a long note leaves every other node where it was. The result is node for
node what a rebuild from nothing draws, and a browser test holds it to that.

Storage that fails does not fail silently: `saveToLibrary()` reports the
first write the library refuses (a full quota, blocked storage) in the
notification bubble, and again only after a write has succeeded in between.

`load()` does the reverse at boot: claim a row for the hash, decode it (or
prompt for the password of a `#!` encrypted link), paint it, and save it to the
library even if nobody types — a link opened and closed is still a note with no
other copy.

## The Library

`lib/library.js` owns one IndexedDB database, `textarea`, with a single
`documents` store (`keyPath: 'id'`). A row holds the text, the title, the style
attribute and the hash it was last seen with.

The row id lives in memory, mirrored to `localStorage` under
`textarea:active-document`. It is claimed by `claimDocumentForHash()`, and the
rule is one row per note, not one row per hash: the hash is rewritten on every
keystroke, so it cannot be the identity — matching rows against it would create
a note per character. The in-memory id is also what keeps two tabs apart;
localStorage is shared, so reading it on every save would let the second tab
take over the first tab's note.

`saveToLibrary()` is called by `save()` and by `load()`. The Documents panel
(`lib/library-panel.js`, fetched when the entry is opened) reads the same rows
through `lib/library.js` and creates, opens and deletes from there.

The same database carries a second store, `trash`, from version 2: a delete
moves the record whole — both stores in one transaction, so a note is never
in neither store or in both — stamped with `deletedAt`, a stamp
`restoreFromTrash()` strips, because it is the trash's bookkeeping rather
than part of the note. `purgeTrash()` takes everything past its keep days
(`textarea:trash-keep`, 30 as it ships) on the way into the panel, the only
reader the store has. Whether a delete is a move or the end of it is
`textarea:trash` (on as it ships), and the panel — `showTrashPanel`, fetched
with the documents panel — puts a note back whole, same id and same text, so
links and folder sync find the note they knew.

## Encrypted Links

An encrypted note is `#!<base64url(header + AES-GCM ciphertext)>` — `'!'` is
not in the base64url alphabet, so the two formats cannot be confused. The
password never leaves the page: `share.js` does the key derivation and the
cipher, `unlock()` asks for the password at load, and `createEncryptedLink()`
in `lib/note.js` replaces the address bar with the encrypted link.

While `state.encrypted` is set, `save()` skips step 1 above — the plaintext
never reappears in the URL behind an encrypted link. The statistics, the
library row and the folder mirror work from the text on screen as they do for
any note.

## Folder Sync

`lib/folder-sync.js` mirrors the library into a directory the reader picks,
one markdown file with front matter per note. Three decisions shape it (the
module header repeats them for anyone reading the source first):

- **A manifest, not guessing.** IndexedDB (`textarea-sync`) remembers which
  file each note was mirrored to. Deletion is only ever safe for tracked
  files; pointing the app at a folder cannot destroy anything it did not
  write, and on a fresh manifest nothing is deleted at all.
- **Newest wins, decided by `planSync`.** The entire decision table — library
  entries vs folder files vs manifest — is a pure function, so the cases where
  a file survives, a note wins or a deletion propagates are unit tests without
  a handle or a browser. `gather`/`apply` around it are the executor.
- **Sync while the app is open.** Triggers are saves, window focus, returning
  to the tab, and the menu's "Sync now" row. There is no daemon; an edit made
  elsewhere lands on the next focus. A failure never touches the note: the pass
  aborts with a message in the notification bubble and keeps the manifest for
  the next one.

The directory handle is re-requested at boot (`restoreFolder()`); when the
permission is gone the reader is told which folder needs it back.

## Files In and Out

- **In:** `open.js` reads what the file input and drag-and-drop hand it —
  plain text, markdown, and the formats `formats.js` can parse — plus PDFs
  through `pdf.js`, which is fetched on first use along with its worker (1.7 MB
  together, never at boot).
- **Out:** the Export panel reads the live page with `readNote()`, formats.js
  turns it into the destination's bytes, and `save.js` writes it through the
  File System Access API where it exists (object URL fallback everywhere
  else). Multi-file and encrypted exports go through `zip.js`.
- **Backup:** `lib/backup.js`, fetched on the menu click, lists the library
  and writes every note into one `zip.js` archive as folder sync's own
  front-mattered file — the same `filenameFor` against a shared collision
  set, the same `renderNote` — so the bytes come back through Folder sync
  rather than through a format of their own. The flow is all or nothing,
  and the password is `askArchivePassword()`, the Export panel's dialog
  lifted out so the two writers cannot drift apart.

## Links

Three kinds of link leave a line of the note, all parsed from the text as it
renders — never from markup the note supplies:

- **Out of the app:** an email address typed into the note becomes a
  `mailto:` link, a `google:` prefix becomes a search link, and a path to a
  file on this computer becomes a link that opens it. The last is behind
  `textarea:file-links`, because a line that looks like a path is often just
  a line of prose; the other two are always on.
- **Between notes:** `[[a title]]` resolves through the same library lookup
  the documents panel uses — case-insensitively, on the first matching
  heading — behind `textarea:wikilinks`, off by default so a note written
  without this fork renders exactly as it always did. A click on a title
  that names nothing creates the note (`textarea:wikilink-create`, on), and
  each half has its own switch in Settings.
- **Back the other way:** `lib/backlinks.js` counts the notes that reach
  this one — `[[wikilinks]]` always, plain mentions of the title on a
  second switch (`textarea:backlink-mentions`) — and the panel behind
  `textarea:backlinks` shows them, pushed a fresh list on every save the
  way the statistics panel is pushed its counts.

The quick switcher is the keyboard side of the same lookup: Ctrl/Cmd+K
(`textarea:switcher`, on by default; the chord and whether the search
covers titles or bodies live in Settings) opens `lib/switcher.js`'s
`filterNotes` over every note. It has no menu row — the feature is the
chord, and the settings row is where it is switched off.

## Find and Replace

`lib/find.js` answers Ctrl/Cmd+F — but only while `textarea:find` is on,
which it is as it ships; off, the handler claims nothing and the browser's
find keeps the chord (Shift and Alt sit outside the comparison either way,
so its variants are never swallowed). The engine is text in and flat
offsets out, pure in the way `stats.js` is pure: the query is escaped
before it becomes a pattern, matches never overlap and the scan always
advances, case folding happens in the pattern rather than in the text so
the ranges slice the note as rendered, and replace-all runs one pass over
the original — a replacement that matches the query itself pasted once and
passed over. `lib/find-panel.js`, fetched on the first press, draws the bar
over the note, and every edit it makes goes through the editor —
`insert()` for one match, `replace()` for the whole batch — so one undo
takes it back and the autosave hears about it in the same breath. Match
case and whole words are one preference with two faces
(`textarea:find-case`, `textarea:find-words`): either face repaints an open
bar, so the bar and the Settings row cannot drift apart.

## Tasks

A `- ` alone is plain text, not a list item; `expandTaskShortcut()` in
`features.js` rewrites `-- ` to `- [ ] ` on the space and throws the switch.
`markdown.js` draws a `- [ ]` after a list marker as a checkbox behind
`textarea:tasks`, off as it ships — the marker and brackets still in the
text, so the note in the URL is what was typed — and `tasksIn()` answers
what a note holds by walking the same tree the renderer draws from, which
is why a bracket inside a fence counts for neither half. A click on the box
writes the one character the task is made of through the editor's own
selection and insert, which is what makes undo, autosave and the library
see a keystroke. `lib/tasks-panel.js`, fetched when the row opens, walks
`tasksIn()` over every note in the library — the ticked work held back
behind `textarea:tasks-done`, also off — and takes the same refreshes the
backlinks panel takes: a save, a load, a delete, a trash restore. The row
hides without its switch and without IndexedDB, since there would be no
library to read.

## The On-device Model

The writing tools run a model that ships in this repository. Four lazy
steps, each fetched only by the step before it:

1. The menu row (or the Settings switch) fetches `lib/writing-tools.js` —
   the panel, its five tools, and `buildPrompt`, which decides what the
   model is asked: the note (cut in plain sight past 24,000 characters),
   the chosen tool's instruction, the reader's own sentence, and a rule
   that the answer is the finished text and nothing else.
2. **Run** fetches `lib/gemma.js`, which reads the picked model's
   `manifest.json` (Gemma's in `models/`, each MiniCPM's in its own
   directory there), pulls the transport chunks of every file it lists,
   checks each one's length and SHA-256 against the pinned values, and only
   then imports the engine. A failed attempt forgets itself, so the same
   button retries; picking another model shuts the running engine down
   before the next one loads. The vision model's image tools send a JPEG,
   scaled to 896 px at most, in place of the note.
3. `vendor/wllama/` — llama.cpp as an ES module, its wasm, and the
   compatibility pair for a browser without JSPI or memory64. Upstream's
   constructor points that pair at jsDelivr; `setCompat` points both files
   at this origin instead, so a first run works with the network off.
4. The chunks are stitched back into the single file they were sliced
   from and loaded with an 8192-token context. From there the panel sees
   only what it was built around: `ensureModel()` answers an engine with a
   `run(messages)`, the same OpenAI-shaped API an online service would
   take — which is the seam the whole design hangs on. The browser suite
   drives the panel through a fake engine, the unit tests drive the
   loader over a stubbed fetch, and `npm run check:model` is the one
   place the real chain runs end to end.

Speech to text is the same shape with a thread added. The menu row fetches
`lib/speech-panel.js`; audio to transcribe fetches `lib/whisper.js`, which
decodes it to 16 kHz mono with an `AudioContext` and starts
`lib/whisper-worker.js` with one entry of `MODELS` (small on the CPU, or large
v3 turbo on WebGPU; another model means another worker, because ONNX Runtime
is set up once per thread). The worker reads that model's `manifest.json`.
When the library asks for each ONNX file, the worker verifies and stitches
its chunks and hands the file over through `env.fetch`, keeping no copy.
The library's own fetching is pointed at this origin
and its own caches are switched off, the service worker's being enough. The
panel's seam is `ensureModel()` answering an engine with a
`transcribe(samples, {language})` for the model picked; the browser suite drives it with a fake,
and `npm run check:whisper` runs the real chain. The model's revision is in
its directory name because `textarea-models` is never versioned.

Nothing is requested from anywhere else. The Content-Security-Policy
allows WebAssembly to compile (`wasm-unsafe-eval`) and no script from
off-origin. The service worker answers `/models/` cache-first from
`textarea-models` — a deliberately unversioned cache name, because a
release bump must not delete 241 MB; the chunks carry their own
versioning in their pinned names, so a cache-first answer is never
stale. The install event never touches that cache.

## Boot

`init()` in `app.js` wires the menu, the theme (which lives in the query string, so it
survives in a shared link), drag-and-drop, the file handling, the statistics
preference, and the folder-sync notice/apply callbacks, then asks for the
folder back. `load()` — after `DOMContentLoaded`, since a module script is
deferred — claims, decodes and paints the note.

The boot fetches 25 modules — 191 kB to parse and eval, against the 263 kB in
21 modules of the single-file shell this replaced — and `tests/perf.js`
prints that graph, the load timings and the typing cost for anyone who wants
to re-take them. The panels behind the menu entries
a reader opens once a month, the Settings rows, the find bar, the tasks
panel, Backup, the quick switcher and the command palette built on it, the
QR encoder, the writing tools and everything under `vendor/`
and `models/` are imported on the click that needs them. So are the file
readers (`open.js`, `pdf.js`, `pdf-layout.js`, `zip.js`), which arrive with
the first file opened; the export formats (`export.js`, `formats.js`,
`save.js`), with the first export; and the folder-sync engine. That last
one sits behind `lib/sync.js`: at boot it asks the browser whether a
`textarea-sync` database exists at all - never on a browser that cannot
sync to a folder - and fetches the engine only if a folder is remembered.
Every action on the folder waits for that question to be answered first, so
a disconnect cannot arrive ahead of an engine that is still loading.
`node tests/perf.js` lists every module that waits behind a click. The startup guard test fails if
any of the deferred files appear in a fresh load's resource timing.

## State, and Where it Is Owned

| State | Owner |
|---|---|
| The note itself | the URL hash, mirrored into the library row |
| The current row id | memory, mirrored to `localStorage: textarea:active-document` |
| The library and its trash | IndexedDB `textarea`: `documents`, with `trash` beside it from version 2 |
| The sync manifest and folder | IndexedDB `textarea-sync` |
| Theme | `?theme=` in the query string |
| Appearance (accent, font, size, spacing) | `localStorage: textarea:accent` and its three siblings; a note font of `custom-…` names a font on the shelf |
| The custom-font shelf and its switch | IndexedDB `textarea-fonts` / `fonts`; `localStorage: textarea:custom-fonts` (`'off'` is the only value that is off) |
| Every feature switch — glass (`textarea:glass`), statistics, two columns, file links, wikilinks, backlinks, the switcher, the command palette, the writing tools, find, backup, trash, tasks | `localStorage: textarea:*`, through the get/set pairs in `lib/prefs.js` (glass keeps its own in `lib/glass.js`), read by the menu row and the Settings panel alike; the README lists every key |
| The word-count goal and the order of My documents | `localStorage: textarea:word-goal`, `textarea:library-sort` |
| The sentence appended to every writing prompt | `localStorage: textarea:writing-instructions` |
| The downloaded model | Cache API `textarea-models` — filled at run time, never by the install event |
| Undo history | the `Editor` object, in the page — a reload resets it |
| Sync status | `folderSyncStatus()` in `lib/folder-sync.js`, read by the menu |

## The Test Seam

`globalThis.textarea` is a deliberately small programmatic surface, set up in
`app.js` and unchanged by the split: the editor,
`save()`, `openDocument`, `readNote`, the statistics panel, `state`,
`documentId`, and the folder-sync entry points (including `connect`, which
takes a handle directly so tests never sit through a native picker). It exists
for the browser suite and the console; nothing in `lib/` reads it.

## Which Test Guards Which Rule

- *Nothing the original did was lost* — `docs/PARITY.md`, one line per
  feature with the test that guards it.
- *Accessibility* — `axe finds no WCAG A or AA failure in either theme`, over
  the note, the menu, every dialog, find and the switcher, with no rule
  switched off; plus the reduced-motion, landmark and keyboard-reach tests.
- *The last words are not lost* — `a tab hidden mid-pause saves at once`, and
  `a library that stops keeping notes says so, once`.
- *The highlight is a patch* — `an edit redraws only the part of the note it
  touched`, which also compares the patched tree with a rebuild from nothing.
- *Other engines* — the same suite under `BROWSER=firefox` and
  `BROWSER=webkit`; `chromiumOnly()` in `tests/browser/run.js` names the
  tests that cannot run there.
- *Folder sync stays out of the way* — `a reader who never asked for folder
  sync never loads it, and gets no database for it`.
- *The preferences* — `tests/unit/prefs.test.js`: the shipped defaults, the
  stored contract, and the validators.
- *The shell is complete* — `tests/unit/sw.test.js` fails when a module in
  `lib/` is missing from the service worker's list.

- *No build, no CDN, boot stays small* — the startup guard test (no
  `vendor/`, no `/models/`, no deferred panel in a fresh load's resource
  timing) and the service worker tests (every shell file exists, no vendor
  or model file is precached, `/models/` answers cache-first at run time).
- *The prompt the model is asked* — `tests/unit/writing-tools.test.js`
  (tool shelf, message order, the reader's sentence, the 24,000-character
  cut) and the browser suite's fake-engine run of the panel (which tools
  the switches put on the shelf, where the progress and the answer land,
  what Replace hands back).
- *The model that ships* — `tests/unit/gemma.test.js` puts the manifest
  this repository has on disk through the loader's rules and hashes the
  first chunk against it, then drives the loader over a stubbed fetch to
  the point where only the wasm import remains. The real chain — download,
  verify, compile, answer — is `npm run check:model`, deliberately outside
  the gate because it moves 241 MB and runs inference.
- *The speech model that ships* — `tests/unit/whisper.test.js` hashes every
  chunk on disk against the manifest and the stitched whole against the
  published digest, and checks the panel's language list against the
  model's own; the browser suite drives the panel through a fake engine.
  The real chain — file, microphone, offline — is `npm run check:whisper`.
- *The console stays clean* — `nothing logged an error along the way`, the
  last declaration in the browser suite, judging every test above it.
- *The sync decision table* — `tests/unit/folder-sync.test.js` against
  `planSync` with no handles involved.
- *The docs do not drift* — `tests/unit/llms.test.js` fails when
  `llms-full.txt` is stale (`npm run llms-full`) or `llms.txt` points at a
  file that is not there.
- *The font shelf* — `tests/unit/fonts.test.js` for the sniffing, the
  naming, the limits, the switch, and the three GitHub shapes with every
  refusal and a download capped against a stubbed `fetch`; and the browser
  suite's two runs over the real panel — a file joined, applied and taken
  off again, and a link rewritten, fetched through the one host the policy
  names, and refused anywhere else.
- *Find* — `tests/unit/find.test.js` for the escaped query, the
  non-overlapping walk, case folding in the pattern, whole words and the
  finite one-pass replace-all; and the browser suite's two runs over the
  bar (Ctrl+F claimed while the switch is on, the walk and one undo per
  replace, then the switch and both defaults persisting).
- *The trash and the backup* — `tests/unit/library.test.js` asks the
  two-store move, the restore and the purge of a database that is not
  there (the private window, honestly), `tests/unit/backup.test.js`
  proves the naming and the verbatim round trip through `parseNote`, and
  the browser suite reads an archive back through the app's own `readZip`
  and walks the whole delete-and-restore round trip, switch both ways.
- *Tasks* — `tests/unit/markdown.test.js` for the renderer's bracket and
  `tasksIn()` over the same tree (fences, options, the text as typed), and
  the browser suite's two runs: a click ticked and undone through the
  editor, and the panel gathering every open task behind its option and
  jumping to the note it came from.
