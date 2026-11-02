# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project tries
to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The app ships as a single page rather than as releases, so treat "Unreleased" as
what is on `main` right now.

## [Unreleased]

### Added

- **Organise by voice** (Settings, off as it ships): after speech to text, *Organise into a board* sends what you said, with this note or all your notes, through MiniCPM5 2B on your machine. The answer is a new note, `# Organised <date>`, with a `##` topic per card, `- [ ]` and `- [x]` tasks and `- ?` questions, drawn as a board with a progress bar per topic. Ticking a box on the board ticks it in the note. The code is shared byte for byte with Xiao's voice organiser.
- **Sticky note** (Settings, off as it ships; Chrome, Edge and Brave): the note in a small square window that stays on top of other windows. It is the same editor moved there, not a copy.
- In Firefox the writing models run on the processor: its WebGPU ran MiniCPM5 ten times slower (0.45 against 4.7 tokens a second).

- **Two more writing models**, picked in the Writing tools panel:
  [MiniCPM5 2B](https://huggingface.co/openbmb/MiniCPM5-2B) (1.56 GB, the best
  writing of the three) and
  [MiniCPM-V 4.7 1B](https://huggingface.co/openbmb/MiniCPM-V-4.7-1B) (1.57 GB),
  which reads images. With MiniCPM-V picked, **Describe image** and **Read text
  from image** work on a picture you choose or drop on the panel, and the
  answer goes in at the cursor. Both are Apache-2.0 and committed under
  `models/` in checksum-verified chunks, like Gemma. Gemma stays the default.
  `MODEL=minicpm5` or `MODEL=minicpm-v` (with `WEBGPU=1`) runs
  `npm run check:model` against them.

- **Send to a device.** Two menu rows send the open note to Textarea on another
  device on the same Wi-Fi, and receive one. They connect over WebRTC with no
  STUN or TURN server, so nothing leaves the network. Pairing is by QR code,
  read with the camera (`BarcodeDetector`, or the vendored jsQR 1.4.0) or
  pasted. The receiver accepts or declines before any of the note is sent.
  The ideas come from LocalSend and qrcp, with no code from either.
  `Permissions-Policy` now allows the camera for this origin.
- **Whisper large v3 turbo** as a second speech model, picked in the Speech
  to text panel. It runs on WebGPU, with an fp16 encoder and a 4-bit decoder
  (1.65 GB, committed under `models/whisper-large-v3-turbo-efd60f61/` in
  checksum-verified chunks), and is offered only where the GPU does half
  precision. It follows
  [lalax-systems/whisper-browser-gpu](https://github.com/lalax-systems/whisper-browser-gpu),
  with [striimit's conversion](https://huggingface.co/striimit/whisper-large-v3-turbo-webgpu).
  ONNX Runtime's WebGPU build comes from the same pinned package as the CPU
  one. `WHISPER_MODEL=turbo npm run check:whisper` runs it for real.
- **`start.command`**: double-click to serve the app on its own port and
  open it. Opening `index.html` from disk now shows a notice explaining why
  the editor can't start, where before it was a bare page.
- **Speech to text.** A menu row opens a panel that records from the
  microphone or takes an audio file and writes the words down with Whisper
  (small, multilingual, 99 languages), on this device: a vendored
  transformers.js on ONNX Runtime in a worker, and 249 MB of weights committed
  under `models/` in checksum-verified chunks, fetched on the first
  transcription and cached for offline use. The spoken language is chosen in
  the panel and remembered; the transcript is inserted at the cursor and
  undoes in one step. After
  [xenova/whisper-web](https://github.com/xenova/whisper-web), without its
  interface or its downloads from Hugging Face. `npm run check:whisper` runs
  the real chain. The `Permissions-Policy` header now allows the microphone
  for this origin (`microphone=(self)`), and nothing else it did not already.
- **Tags.** `#tag` in a note is tinted, and My documents shows every tag with
  the number of notes carrying it; a chip filters the list, and `#work` also
  finds `#work/taxes`. Tags are read from the text, so nothing new is stored.
  On as it ships, with a **Tags** switch in Settings for how notes draw them.
- **Pin and archive** on every card in My documents. A pinned note comes first
  in every order; an archived one leaves the list until `is:archived` asks for
  it. Neither moves the note's last-edited time, and the autosave and the
  tab-closing save both carry the marks over.
- **Activity calendar** in My documents: twelve weeks of days, shaded by the
  notes made or last edited on each, with a click or the date field filtering
  to one day.
- **Timeline** as a second way to show My documents, and a **quick capture**
  box that saves a jotted note without putting the open one away.
- **Saved filters**: whatever is in the search box, kept as a chip.
- The round menu button is glass too, from the first paint.

### Changed

- The vendored wllama is now 3.11.0 built from `master` (`1a5687ef7c`), the
  first build that loads MiniCPM-V 4.7. It runs the writing models on WebGPU
  when the browser has it.

- Nineteen icons are now [Aiko](https://github.com/tw93/aiko)'s filled
  glyphs. GitHub, unlock, columns, zip, save, the QR code and the Glass drop
  keep their Tabler and Material icons, because Aiko doesn't have them.
  `tests/unit/icons.test.js` pins every Aiko path by hash.
- The speech engine's worker imports its libraries inside the load. A file
  that fails to import is now reported by name, where it used to be "the
  speech engine could not start". The worker stitches each model file only
  when the runtime asks for it and lets go of it once handed over, where it
  used to stitch every file first and hold them all until the load ended.
- A microphone that macOS withholds from the browser is now explained, with
  where to allow it. So is one that's busy in another app. Both used to show
  a bare error.
- **Liquid glass reads as glass.** The panels had the refraction and nothing
  else, which over a plain page looked like a slightly see-through box. They
  now carry a material - a fill that thins towards one corner, a bevel lit
  from the top left, a glare - ported from LiquidGlass-UI's stylesheet, with a
  stronger interior blur and prism fringe from the module. A label still
  reads 4.5:1 with the note's ink directly behind it, which has its own test.
  `prefers-contrast: more` and forced colours get the plain panels back.
- The search box in My documents understands `#tag`, `on:YYYY-MM-DD`,
  `is:pinned` and `is:archived` alongside the phrase it always searched for.

### Improvements over textarea-master

This repository is a rebuild of `textarea-master` at revision `a70829e`. It
began as a byte-for-byte copy; every one of the original's 250 unit tests and
105 browser tests is still here and passing, and
[docs/PARITY.md](docs/PARITY.md) maps each feature to the test that guards
it. Storage keys, database names, cache names and both link formats are
unchanged, so existing notes, settings and links carry over. What changed:

**Lists and tasks**

- A `- ` at the start of a line is no longer drawn as a bullet; `* ` and `+ `
  still are. Typing `-- ` and a space writes `- [ ] ` and switches Tasks on,
  and a task line shows its checkbox without a bullet beside it.

**Structure**

- `app.js` was 2,850 lines holding the editor, the URL, the menu, every
  preference and the boot. It is now a 190-line entry, and the work lives in
  thirteen modules under `lib/` — `note`, `editor`, `features`, `menu`,
  `files`, `shortcuts`, `prefs`, `settings-rows`, `notify`, `signals`, `sync`,
  `filename`, `read-note` — with no module importing the entry and no two
  importing each other.
- The thirty preference get/set pairs share one helper in `lib/prefs.js`,
  which is unit tested; a stored value that is not one the app writes can no
  longer flip a default.

**Performance** (same machine, `node tests/perf.js 1024`)

- Eager JavaScript at boot: 262.7 kB → 182.1 kB, with five features added.
  A session that only types no longer parses the PDF and ZIP readers, the
  nine export formats, the Settings rows or the folder-sync engine: each
  arrives with the first file opened, the first export, the Settings panel,
  or a folder that is remembered or being connected.
- Re-highlighting a 1 MB note: 108.1 ms → 42.4 ms (median of five). The
  renderer used to empty the article and rebuild all of it on every
  highlight; it now swaps only the stretch of nodes that differs.
- `tests/perf.js` also times the highlight after a single keystroke, which
  is what typing actually costs: 36.4 ms on that 1 MB note, almost all of it
  re-reading the text. The note is still parsed whole on every pause; at
  that size it is two frames, and it was left alone.

**Robustness**

- A tab hidden or closed inside the 500 ms autosave pause no longer loses
  what was typed in it: the library row is written and committed in the same
  turn as `pagehide` / `visibilitychange`, which the browser finishes after
  the page is gone. Tested by really closing a tab mid-keystroke.
  Twenty real closes kept the last words twenty times in each of Chromium,
  Firefox and WebKit.
- A tab that comes back on the same address after closing that way reopens
  on the text it had, in the same library row, rather than on the older text
  in its URL with the newer text left as a second note. Verified on reload;
  a restored session depends on the browser reporting itself as one.
- A library that stops accepting writes — a full quota, blocked storage —
  says so once, where it used to fail silently.
- A link is called long at three quarters of the URL limit, while it still
  works, in addition to the existing warning past the limit.
- The reason a writing-tools Run failed stays on screen; it used to be wiped
  the moment the Run ended.

**Accessibility**

- axe-core runs in the browser suite over the note, the menu, every dialog,
  find and the switcher, in both themes, at WCAG 2.x A and AA with no rule
  switched off. Fixed to get there: the page declared no language; hint
  text, placeholders and card dates were under 4.5:1 on the light theme;
  document cards had an accessible name that did not contain their visible
  text.
- Menu rows keep their height and the menu scrolls. On a short window the
  twenty rows were squeezed to 24px each and the last was cut off.
- A `main` landmark around the note, a `prefers-reduced-motion` rule (there
  was none), and tests for keyboard reach and visible focus.

**Other browsers**

- The browser suite runs under Firefox and WebKit as well as Chromium
  (`npm run test:browsers`, and a CI matrix): 94 and 93 tests pass, with the
  tests of Chromium-only features skipped by name. The original was only
  ever run in Chromium.

**New, each behind its own preference**

- A command palette on Cmd/Ctrl+Shift+P (off as it ships) listing every
  visible menu row, plus find and the quick switcher.
- My documents sorts by last edit, creation or title, and remembers.
- A word-count goal, shown in the statistics panel only when one is set.
- Backup can write the whole library as one Markdown file.
- A print stylesheet: the note alone, black on white, with page margins.
  The original only hid the menu button.

**Writing tools**

- The model download reports progress per megabyte instead of per 64 MiB
  chunk, and can be cancelled.

**Documentation**

- `textarea:glass`, the liquid-glass switch's storage key, was documented
  nowhere outside `lib/glass.js`; the README now lists every key.
- `docs/ARCHITECTURE.md` said a save runs "a fifth of a second" after
  typing. The code waits 500 ms, and the document now says so.
- The README covers the alternatives to committing the model (Git LFS,
  release assets).

### Added

- **One Export panel** with four destinations: save to a file, copy to the
  clipboard, a QR code, or an archive. File and clipboard share one format list
  and one converter, so what is copied is byte for byte what a download would
  have written. No new export formats were introduced.
- **Copy to the clipboard** in all nine existing formats, with a fallback for
  browsers where the Clipboard API is unavailable, such as a page served over
  plain `http://`.
- **A QR code** of the note's link, drawn on screen for scanning and downloadable
  as SVG. Carries the link rather than the text, warns when the note is encrypted,
  and reports a payload that is too long instead of drawing an unscannable square.
- **A document library** in IndexedDB, written about half a second after you stop
  typing and listed under **My documents** with search over titles and bodies.
  One row per note rather than one per keystroke, and separate per tab.
- **Folder sync**: a two-way mirror between the library and a folder picked from
  the menu with the File System Access API, one markdown file per note with a
  front matter block (id, timestamps, word count, style). Newest wins between
  the two sides, deletions mirror, files the app never wrote are only read or
  imported — never removed — and the first pass over a folder removes nothing.
  The pass runs on budgets, like every other input: a file over 10 MB is left
  untouched without being read, and a pass stops before a folder with more
  than 1,000 markdown files or 100 MB of them. Runs while the app is open (on
  save, focus and tab return), offered only in Chrome and Edge where the API
  exists, and documented as writing plaintext files: that is what makes them
  editable in any editor.
- **Statistics** for words, characters, characters without spaces, lines,
  sentences and two reading estimates, in a panel that follows the note as you
  type. CJK is counted a character at a time.
- **One Encryption menu entry** offering both sides of the same switch, in place
  of two menu rows one of which was usually hidden.
- Conditional dialog fields and an icon slot in the shared `<dialog>` builder.
- Community health files: `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`,
  `SECURITY.md`, issue and pull request templates, and Dependabot.
- **`llms.txt`** at the site root, following the
  [llmstxt.org](https://llmstxt.org/) proposal: a short summary of what the app
  is and does, then a file list of the documentation in this repository, with
  every link landing on raw markdown rather than on a web page.
  `llms-full.txt` carries the README, the changelog and the contributing guide
  in one file, `index.html` advertises the file with `rel="describedby"`, and a
  unit test checks the shape, the links, and that the full file still matches
  the three documents it is built from.
- **The page declares its icons, and the crawlers are told where the site is**:
  `index.html` links `favicon.ico`, `favicon.png` and the Apple touch icon
  rather than leaving the browser to guess, and `robots.txt` with `sitemap.xml`
  publish the one page there is to index. CI runs lychee over every link in the
  documentation and the pages on every pull request, and a unit test covers
  what a network checker cannot see: relative links, anchors, the service
  worker shell, and the domain `robots.txt`, `sitemap.xml` and `llms.txt` are
  supposed to agree on.
- **Liquid glass** behind a **Glass** row in the menu: the menu, the dialogs and
  the statistics panel refract the page visible through them, via an SVG
  displacement filter built by the vendored
  [deepika-builds/liquid-glass](https://github.com/deepika-builds/liquid-glass)
  (MIT), pinned to a commit since upstream tags nothing. The panels are opaque
  unless the row is on — an opaque panel has nothing behind it to bend — and
  become exactly the boxes they were again when it goes off. A browser that
  cannot use an SVG filter as a backdrop (Safari, Firefox) gets the module's
  frosted blur instead, and a reader whose system asks for reduced transparency
  gets the opaque app with the row not offered at all. The module is imported
  on first use like the other vendored libraries, and `lib/glass.js` joins the
  service worker shell, whose cache version moves with every file added to it.
- **"Sync now"** as a second folder-sync row, hidden while no folder is
  connected: it forces the pass immediately and reports what it did — what was
  written, imported or removed, or plainly that the folder already holds every
  note — in the same bubble as everything else. The row sits directly under
  the folder row, so keyboard and screen-reader order reaches the state it
  acts on next.
- **The folder row says how the mirror is going**: "Syncing…", "Waiting to
  sync", "Sync problem" or "Up to date", read fresh when the menu opens, with
  the problem sticking until a pass succeeds again. A remembered folder whose
  permission was revoked keeps its name in the row and is told politely —
  `Folder sync needs permission for "notes" again` — instead of the row
  falling back to a bare "Folder sync" that reads as sync simply being off.
- **A folder change says how to take it back**: the message on arrival is now
  "Updated from the folder — Ctrl+Z or ⌘Z undoes it", naming both modifier
  keys rather than sniffing for a Mac.
- **docs/ARCHITECTURE.md**: the module map and the data flows — which file
  owns the URL, the library and the mirror, and how a note moves between
  them — linked from the README's Development section and listed in
  `llms.txt`. The contributing guide grew the browser suite's anatomy (its
  waits, `syncRig`, the console gate's placement rule, how to run one test),
  and the issue forms gained "Folder sync" and highlighting as where a
  problem belongs.
- **Links from the note to where they point.** An email address typed into
  the note becomes a `mailto:` link, `google:something` becomes a search
  link, and a path to a file on this computer becomes a link that opens it —
  the last behind its own switch in Settings, because a line that looks like
  a path is often just a line of prose.
- **An appearance of the reader's own**: an accent colour, the note's font,
  its size and its line spacing, each remembered across visits and applied
  as CSS custom properties, so one accent carries through the menu, the
  panels and the note itself.
- **One Settings panel** holding every switch in the app: the rows the menu
  used to carry one at a time (glass, statistics, two columns, file links,
  wikilinks) sit beside the newer ones — backlinks, the quick switcher with
  its scope and chord, and every writing tool with its own row — and each
  keeps its menu row in step with the panel it belongs to.
- **`[[wikilinks]]`**: a title in double brackets becomes a link to that
  note. Rendering them is a switch, off until it is thrown — a note written
  without this fork renders exactly as it always did — and while it is on, a
  click on a title that names nothing creates the note, which is the default
  Obsidian readers expect and the first thing others want taken away. Each
  half has its own switch.
- **A Backlinks panel** listing every note that reaches this one while you
  read it: `[[wikilinks]]` always, plain mentions of the title on a second
  switch. Both the panel and the mentions are off until asked for, and the
  panel follows the note as it changes.
- **A quick switcher on a chord**: Ctrl/Cmd+K opens a palette over the note
  — P or E are the alternative chords, under Settings — and a few letters
  filter every title, or every body under the scope setting, with Enter
  jumping to the match. It is on by default, and its row lives in Settings
  rather than the menu because the feature has no panel to open.
- **Writing tools that run on this machine.** A side panel with five
  one-press tools — improve wording, shorten, summarise, fix grammar, make
  it more casual — each with its own switch, plus one line of the reader's
  instructions appended to every prompt. The answer appears for reading and
  replaces the note only when **Replace** is pressed; undo takes it back.
  The engine is llama.cpp vendored as wllama under `vendor/`, and the model
  ships with the repository: Gemma 3 270M in four chunks under `models/`,
  each verified against a pinned SHA-256 before anything loads. No request
  carries a word of the note anywhere — the prompt is this note, cut in
  plain sight past 24,000 characters — and the first Run caches the model
  for every run after, offline included. The panel is fetched on the click
  that opens it, the engine on the Run that needs it;
  `npm run check:model` presses that button for real, because the test
  suite deliberately will not.
- **Fonts of the reader's own.** The note font list grows past the four
  built-ins: a TTF, OTF, WOFF or WOFF2 file from your disk, or a link to one
  in a public GitHub repository, joins the same select and applies to the note
  like any other family. The picker filters on the four formats every browser
  can load, but the picker is not the gate: the signature is checked first and
  then the browser itself judges the bytes through `FontFace.load()`, so a
  corrupt or lying file is refused with a message instead of stored. The bytes
  live in their own IndexedDB database — five megabytes and ten fonts — and
  registering one needs no policy change, because the buffer is handed to the
  `FontFace` constructor rather than fetched from a URL. The GitHub half reads
  exactly one file, rewritten from a blob link or a raw link and turned down
  before the fetch on any other host; the declared length is checked and the
  bytes are counted as they arrive, so a body over the cap is never held
  whole. The shelf is on until switched off, because it does nothing until a
  file is put on it: switching it off returns a note wearing a custom font to
  a system stack, and removing a font takes the preference with it in the
  same breath. The fixture the browser suite uploads is Silkscreen, OFL-1.1
  from google/fonts.
- **Find and replace** on Ctrl/Cmd+F: a bar over the note with a live count
  of the matches, previous and next walking from either end with wraparound,
  **Replace** for one and **Replace all** with the number it changed — and a
  help line saying what Enter, Shift+Enter and Escape do. The chord is the
  app's while the switch is on, and turning it off hands Ctrl+F back
  unclaimed; Shift and Alt stay out of the comparison either way, so the
  browser's own variants of the shortcut are never swallowed. The engine is
  pure arithmetic over the text, unit tested without a page: the query is
  escaped before it becomes a pattern, so a note full of prices finds `a.b`
  only where a dot was actually typed; matches never overlap and the scan
  always advances; case folding happens in the pattern rather than in the
  note, so the ranges still slice the text the reader is looking at; and a
  replacement that itself matches the query is pasted once and passed over,
  which is what keeps **Replace all** finite. Each replace goes through the
  editor as the keystroke it is — one undo takes a single replace back, and
  one undo takes the whole batch — while match case and whole words ship as
  the bar's own defaults behind one preference with two faces, so an open
  bar and the Settings row cannot disagree. The bar arrives on the first
  press, not at boot.
- **Backup** from the menu, beside **My documents**, behind a switch that
  ships on: the click flushes the pending save — the note on screen is in
  the archive as it stands — and then writes every note into a single ZIP.
  The entries are Folder sync's own output, named against one shared
  collision set, so the archive is that format byte for byte: unzip it,
  point Folder sync at the folder, and the notes come back with their ids,
  timestamps and style intact, which is what makes this a backup rather
  than a second export format. The flow is all or nothing — list, write,
  save, report — because a backup that could stop halfway would be worse
  than no backup at all, and a refused storage or an empty library is said
  plainly instead of guessed at. **Include note metadata** ships on, since
  the front matter block is what makes the archive restorable, and
  **Encrypt with a password** ships off: on, every backup asks for the same
  password twice through the Export panel's dialog before anything is
  written. The module waits behind the click, so a reader who never backs
  up never pays for the code that writes one.
- **A trash for deleted notes**, behind a switch that ships on: a delete
  from the documents panel moves the note whole into a second store of the
  same database — one transaction over both stores, so a note is never in
  neither store or in both — and the bubble says where it went. The
  **Trash** row opens the documents panel's second face: what was deleted,
  newest first, each card showing when it went, with one click putting the
  note back exactly as it was — same id, same text, minus the deletion
  stamp that is the trash's bookkeeping and not part of the note — a
  corner button taking one for good behind a question that says so, and
  **Empty** clearing the rest. Deleted notes are kept for 30 days (7 or 90
  in Settings, a stray value falling back to the shipped 30) and anything
  past its days is purged on the way into the panel, the only place the
  store is read. Switch it off and deletes are for good again, with the
  confirmation describing the true promise either way, because a note
  waiting in the trash and a note removed are different sentences. The
  upgrade that adds the store leaves every note already held exactly where
  it was.
- **The writing tools can run on the selection.** A switch in Settings —
  off as it ships — turns **Run** into a run over whatever the reader
  highlighted: the prompt then carries only that run, so the rest of the
  note never reaches the model, and the answer goes back where the Run
  looked rather than wherever the caret has wandered to since, with the
  button naming which of the two it will replace. A selection of only
  whitespace is not worth taking — a stray drag across a line break should
  not quietly halve what the model is asked about — so it falls through to
  the whole note, the way an empty selection does.
- **Tasks.** A `- [ ]` after a list marker draws as a checkbox, behind a
  switch that ships off — the brackets live on in the text, unhidden and
  editable and copied as typed, so a note written without this fork renders
  as it always did. A click on the box writes the one character the task is
  made of through the editor, so undo, autosave and the library all see the
  keystroke it is. A second switch, also off, adds a **Tasks** row to the
  menu that gathers every open task in the library — newest note first,
  each row opening the note it came from — and what counts as a task there
  is the renderer's own answer, walked through the same tree the note draws
  from, so a bracket inside a fenced block never reaches either half.
  Ticked work stays off the list until its own option is thrown, and an
  open panel is pushed the news where the backlinks panel is pushed it: a
  save, a load, a delete, a restore.

### Changed

- **Licence files for everything that is not this project's own code.** The
  character maps and standard fonts inside the vendored pdf.js now carry their
  own licence files, llama.cpp's MIT notice sits beside the wllama binaries,
  the Tabler and Material Symbols licence texts are in `vendor/icons/`, and the
  Gemma Terms of Use, its Prohibited Use Policy and the notice file the terms
  prescribe are beside the model in `models/`. `LICENSE` says in so many words
  that MIT covers the code and not `vendor/` or `models/`.

- **Save as**, **Save as ZIP** and **Open file** are now one **Export** entry, a
  **Documents** entry and an **Open file** entry. The archive is the fourth
  destination inside the Export panel rather than a row in the menu.
- The menu's GitHub link points at this repository rather than upstream's.
- `Cmd/Ctrl+S` opens the Export panel instead of saving straight to a text file.
- The document library keeps writing while a note is encrypted, so turning
  encryption on does not silently stop the backup.
- **My documents** is a grid of sticky-note cards instead of a list of rows:
  each note is a yellow square with its title, its first lines and the date it
  was last edited, and the whole card opens it. The card for the note on screen
  is ringed and badged rather than tinted, because a tinted card reads as
  "selected" and it is only open. The word count left the face of the card and
  stays in the button's accessible name.
- pdf.js, zip.js and the new QR encoder are all fetched on demand rather than
  precached, so a session that only types downloads none of them.
- **A big note re-renders about ten times faster.** The measured cost of one
  highlight cycle on a 1 MB note fell from 1037ms to 91ms, and a pasted
  single-blob note — no line break anywhere — from 2666ms to 13ms, now
  scaling linearly instead of quadratically. The rendered tree is identical
  before and after; only the main-thread time moved.
  `node tests/perf.js` prints these numbers for anyone who wants to re-take
  them.
- **The boot downloads less.** The panels behind the menu entries a reader
  opens once a month — Export, Documents, Encryption, Settings, Backlinks,
  Backup and Trash — the find bar, the tasks panel, the QR encoder, the
  quick switcher and the writing tools are fetched when their entry is
  first used instead of parsed at boot: 21 modules and 263 kB eager, where
  parsing everything up front would be 35 modules and 395 kB. A startup
  test fails if any deferred file shows up in a fresh load's resource
  timing, and the panel still arrives on the click that needs it.
- **Undo keeps what the note said, not how it happened to be rendered.**
  History records hold the text and caret rather than a DOM snapshot, so
  restoring re-runs the highlighter, identical text dedupes, and a marker
  typed as text (`<img src=x onerror=…>`) stays text through undo and redo.
- **The sync UI reads the way assistive technology reaches it**: the menu
  assertion resolves the row by role and accessible name rather than by its
  label span, and a failed pass lands as an assertive, error-styled message
  with words in it while the row keeps "Sync problem" after the bubble's
  moment has passed.

### Fixed

- A custom font already on the shelf from an earlier session now shows the
  moment it is picked in Settings. Only the font the note opened in was being
  registered, so any other one set the choice and kept the system font until
  a reload. Removing a font, or importing its family again, now takes the old
  face out of the page too.
- The QR code, close and delete icons are Google's own paths in Google's own
  `viewBox`, copied verbatim rather than hand-rescaled. The rescale had mirrored
  the QR code and the trash can about the horizontal axis: the QR code's three
  finder patterns sat at top-left, bottom-left and bottom-right instead of
  top-left, top-right and bottom-left, and the trash can's lid was underneath it.
  A unit test now compares them against the published files byte for byte,
  and a second test states the QR code's layout geometrically so a failure says
  what is wrong rather than only that two strings differ.
- The service worker's cache version is bumped with the shell, so a returning
  tab picks up an `index.html` that has changed rather than answering from the
  cache it installed before.
- The browser test harness records every notification in the page instead of
  polling the bubble, so an action slower than the bubble's two-second display
  can no longer miss a correct message. This was making the encrypted-archive
  test fail intermittently with no visible cause.
- `llms.txt` sent "The app" to upstream's deployment on `pages.dev` rather than
  to this fork's; it now names the deployed domain, and a unit test checks that
  it, `robots.txt` and `sitemap.xml` still agree on it.
- A folder-sync pass is now exclusive from start to finish: it cancels the
  pending save-pause it supersedes, takes a Web Lock so a second tab's pass
  waits its turn instead of interleaving writes in the same folder, gives a
  deletion queued mid-pass the last word over that pass's already-built plan,
  and cannot let a disconnect mid-pass commit the old folder's plan over the
  folder picked to replace it.
- A front matter block full of junk lines is read line by line with the junk
  skipped, and a block that never closes leaves the whole file — fences
  included — as the note instead of failing the pass. A library emptied
  behind the mirror's back (storage cleared, another tab, a crashed hook)
  takes its folder's files with it through the manifest rather than leaving
  orphans the next reader would meet.
- The browser suite waits for what happened instead of guessing how long it
  might take: fixed sleeps became polls for the condition they were
  guessing at, tests that need a save ask for it instead of waiting out the
  debounce, and `reset()` stopped spending round trips it could combine —
  57s to 33s. The console gate listens on every page the context opens, not
  just the first, proves itself with a deliberate rejection, and is
  genuinely the last test in the file again: sixteen folder-sync tests had
  been growing underneath it, unjudged.
- The rules that used to rest on review now have tests where they are
  cheapest to trust: the service worker's decisions drive a unit test
  (install survives a missing file, an activation prunes exactly its
  version's caches, vendored files answer from cache and are never cached
  as a range, an offline navigation falls back to the shell), the folder's
  read budgets run against a folder of plain objects, and the two
  folder-sync races sit behind a gate hook that holds a pass open long
  enough to reproduce them.
- `insert()` and `replace()` put the far side of the change on the undo
  stack now — the text that went in, not only the text they took out. Undo
  lands on the record below the pointer, so with that far side missing the
  first Ctrl+Z after either change answered with whatever the stack held
  underneath it, or with nothing at all on a fresh stack: one undo took
  back more than the change it belonged to, and the first edit of a session
  took back nothing. Both ends of a programmatic change go on the stack
  now, the way a keystroke's keydown and keyup leave both behind.

### Security

- The `style` half of a shared link is no longer applied verbatim. A crafted
  URL could carry declarations that cover the interface (`position: fixed`) or
  fetch a third party on render (`background: url(...)`); the attribute now
  passes through an allowlist in `lib/style.js`, parsed by the CSSOM, so only
  decorative properties survive — the DevTools styling tip keeps working for
  colours, fonts and the like. The same filter runs on the copy restored from
  the document library.
- Links inside the note open with `noopener,noreferrer`, and the two
  `target="_blank"` menu links carry `rel="noopener noreferrer"` explicitly, so
  a page reached from a note never holds `window.opener` on the editor.
- The deployment sends security headers: a Content-Security-Policy
  (`script-src 'self' 'wasm-unsafe-eval'` — the grant is WebAssembly
  compilation only: no `unsafe-eval`, no `unsafe-inline`,
  `frame-ancestors 'none'`),
  `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`,
  `Permissions-Policy`, `Cross-Origin-Opener-Policy` and HSTS.
  `tests/serve.js` serves the same headers so the browser tests run under the
  real policy, and a unit test keeps the two files in step.
- The font shelf's GitHub import gained exactly one door in that policy:
  `connect-src 'self' https://raw.githubusercontent.com` — one origin, named,
  no wildcard — in `vercel.json` and in `tests/serve.js` together. The other
  half of the promise lives in `lib/fonts.js`, which turns every other link
  down before the fetch is made, and a unit test compares the whole
  `connect-src` directive against the string it is supposed to be, so taking
  the grant out, widening it, or letting the two files drift each fail by
  name.
- The model that ships in this repository is checked before it runs: every
  transport chunk under `models/` is verified against the SHA-256 pinned for
  it in `models/manifest.json`, and a mismatch stops the load with the
  file's name in the message rather than running bytes that are not this
  repository's. The chunks round-trip to the exact upstream file, whose
  whole-file digest was independently confirmed against the host's own.
- Opening an archive is bounded: more than 1000 files, or more than 100 MB
  expanded in total, is refused with a message instead of read; a header that
  understates the size is caught by zip.js the moment output overruns it; and
  a file picked from disk over 200 MB is rejected before its bytes are read.
- A note whose hash expands past 64 MB of text is refused by the decoder
  instead of being inflated into the tab.
- CSV exports neutralise leading `=`, `+`, `-`, `@`, tab and CR with a single
  quote, so a spreadsheet cannot evaluate a note line as a formula (CWE-1236).
- The test server neither lists nor serves `.git`.
- No `innerHTML` remains anywhere in the app's code. The exported HTML page
  re-renders the note from its text through the same highlighter the editor
  uses rather than copying live markup; the documents and statistics panels
  build their icon buttons through the shared `icon()` helper; and the QR
  figure parses the encoder's SVG as the XML it says it is. Nothing in the
  app points a parser at generated markup on the reader's behalf.

## [Upstream]

Everything before this fork is [antonmedv/textarea](https://github.com/antonmedv/textarea),
MIT © Anton Medvedev, forked from `master` as of 2026-10-05. Its history is in
the git log before the first commit here; the differences this fork introduces are
listed in the README under **Differences from upstream**.
