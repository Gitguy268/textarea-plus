# Contributing

Thanks for taking the time. This is a small project with a short feedback loop,
and most of the work is well suited to a first contribution.

Everyone taking part is expected to follow the [Code of
Conduct](CODE_OF_CONDUCT.md).

## Getting set up

You need Node 22 or newer. There is no build step and nothing to install beyond
the test dependencies.

```sh
git clone https://github.com/gitguy268/textarea.git
cd textarea
npm ci
npm run serve
```

That serves the project at <http://127.0.0.1:8080>. Open it, type in the page,
and reload: the note comes back out of the URL.

The browser tests need one download:

```sh
npx playwright install --with-deps chromium
```

## The commands

| | |
|---|---|
| `npm run serve` | Serve the project for local use |
| `npm run lint` | ESLint: correctness rules only, no style |
| `npm run check` | Lint, then syntax-check every file |
| `npm test` | Unit tests, pure modules under Node |
| `npm run test:browser` | Playwright tests against the real app |
| `npm run test:all` | All three, in the order CI runs them |
| `npm run llms-full` | Rebuild `llms-full.txt` from README, CHANGELOG and CONTRIBUTING |
| `npm run check:model` | Press Run against the real shipped model — outside the gate, on purpose |

`npm run test:all` is what a pull request has to pass. It takes about 40 seconds
on a laptop; the browser suite is slower on CI, where it downloads Chromium.

`llms-full.txt` is committed, and `tests/unit/llms.test.js` fails when it has
drifted from README.md, CHANGELOG.md and CONTRIBUTING.md — so an edit to any of
those three ends with `npm run llms-full` and the rebuilt file in the same
commit.

## Two hard rules

**1. No build step.** The app is `index.html`, `app.js` and `lib/`, deployed as
plain static files. If your change needs a bundler, a transpiler, a preprocessor
or a generated file, it is the wrong change. It has to work when someone opens
`index.html` from a file server and nothing else happens.

**2. Nothing is fetched at runtime from a CDN.** Every dependency is either a
Web Platform API or a file checked in under `vendor/` (or, for the two
models, under `models/`), loaded with a dynamic `import()` — or, for
the models' chunks, a fetch — the first time it is needed. pdf.js, zip.js,
the QR encoder, wllama and transformers.js are all loaded on demand for the same reason: a
session that only types should not download two megabytes of PDF parser,
let alone a quarter of a gigabyte of weights.

Adding a dependency is a discussion, not a pull request. Open an issue first. The
bar is a permissive licence, no transitive surprises, and a job small enough that
writing it yourself would not have been faster.

## Where things live

```
index.html        markup, the menu, and all of the CSS
app.js            the entry: wires lib/ together, boots, exposes the test seam
lib/              one module per concern, all pure where it can be
  note.js           the note: the editor's text, the URL hash, the library row, the autosave
  editor.js         the contenteditable editor and its undo stack
  features.js       the side panels, the bars and the switches around the note
  menu.js           the menu, its rows and the theme row
  files.js          files coming in: the input, drag and drop, "Open with"
  shortcuts.js      the page-wide keyboard chords
  prefs.js          every textarea:* preference as a get/set pair, pure over localStorage
  settings-rows.js  the rows of the Settings panel, fetched with it
  notify.js         the notification bubble
  signals.js        the two pieces of news the modules pass each other
  sync.js           folder sync as the app calls it; fetches folder-sync.js only when a folder exists
  filename.js       a title made safe to be a filename, pure
  read-note.js      the note as every exporter takes it
  dialog.js         the <dialog> builder every panel is built from
  formats.js        note -> text/CSV/JSON/XML/RTF/LaTeX/YAML, no DOM
  export.js         reading the note out of the live page and writing a file
  export-panel.js   the Export panel
  qr-panel.js       the QR panel
  encryption-panel.js
  library.js        IndexedDB
  library-panel.js  My documents
  folder-sync.js    the mirror into a folder you pick: planSync pure, the rest is handles
  front-matter.js   the markdown + front matter file format, pure
  stats.js          counting, pure
  stats-panel.js    the readout
  appearance.js     accent, font, size, spacing as CSS custom properties
  fonts.js          the note's own fonts: sniffing and naming pure, then FontFace and a shelf in IndexedDB
  settings-panel.js every switch and every knob, in one dialog
  file-links.js     mailto:, google: and file paths out of the note
  backlinks.js      which notes reach this one, pure
  backlinks-panel.js  their readout
  switcher.js       the quick switcher on Ctrl/Cmd+K (filterNotes pure)
  writing-tools.js  the writing panel and its prompt (buildPrompt pure)
  gemma.js          the on-device engine: verify the chunks, then run them
  speech-panel.js   the speech to text panel: record or pick a file, insert the transcript
  whisper.js        its engine's page side: start the worker, decode audio to 16 kHz mono
  whisper-worker.js the worker: verify and stitch the chunks, then transformers.js
  clipboard.js      copying, with a fallback
  markdown.js       the syntax highlighter
  pdf.js, pdf-layout.js
  open.js, save.js, share.js, theme.js, zip.js
models/           the two models, in transport chunks with pinned SHA-256s
tests/unit/       pure modules, under node --test
tests/browser/    the real app in Chromium
tests/fixtures/   the font the browser suite uploads (Silkscreen, OFL-1.1, with its licence),
                  and jfk.wav for check:whisper (11 s of a 1961 US presidential address, public domain)
vendor/           third-party code, each with its own licence, all lazy
```

The split that matters: **anything that can be a pure function should be**, so it
can be tested under Node with no browser. `lib/stats.js` and `lib/qr.js` are
examples — the arithmetic and the drawing have nothing to do with a page.

## Tests

Unit tests go in `tests/unit/` and use `node:assert/strict` and `node:test`.
Name the file after the module.

Browser tests go in `tests/browser/run.js`, which starts its own server and
drives one page through Playwright. A few conventions matter:

- **Wait for what the app says, not for a delay.** `notification()` waits for the
  message bubble and returns it. `until()` waits for a predicate in the page,
  for the cases `page.waitForFunction` will not do: it treats a returned promise
  as truthy rather than awaiting it, so anything reading IndexedDB has to use
  `until`.
- **The two fixed waits are for delays that really are delays.** `settleHistory()`
  waits out the history debounce before an undo/redo, and `freshEditor()` reloads
  so the undo stack starts empty — history lives in the page, so the stack would
  otherwise carry the earlier tests' edits.
- **Stub the native file picker.** The suite removes `showSaveFilePicker` before
  every page, because it opens a dialog no automation can dismiss. One test
  re-adds a stub to cover it.
- **The clipboard context has no permission on purpose**, because one test asserts
  what the app does when the browser refuses. Tests that need to read the
  clipboard back use `clipboardContext()`.
- `reset()` clears the document library between tests, because it is designed to
  outlive the page.
- **Folder sync tests go through `syncRig()` rather than the picker.** The real
  File System Access API opens a dialog no automation can dismiss, so the rig
  hands `connectToDirectory()` an OPFS directory: the same handle interface, the
  same gather/plan/execute path, only the picker skipped. Everything stays
  inside the page — a handle is not something `evaluate()` should move around.
- **Never read the `textarea-sync` IndexedDB store directly.** While a permission
  handle is stored in it, opening the store crashes headless Chromium; an empty
  read (which every boot performs) is fine. Tests that need the record patch
  `indexedDB.open` with a stand-in for that one table and remove the patch in a
  `finally`.
- **The console gate is the last declaration in the file.** Every `console.error`
  and uncaught page error is collected from the first page on, and
  `nothing logged an error along the way` judges them all — which is why it has
  to stay last, and new tests go above it, never after it.

While iterating, run one test by name (node's filter matches whole names, so a
few words of the sentence are enough):

```sh
node --test --test-concurrency=1 --test-name-pattern='the documents panel' tests/browser/run.js
```

Before a commit the full gate is `npm run lint && npm run test:all`. When adding
a browser test, check it discriminates: break the behavior it guards on purpose
and confirm the test fails, because a test that passes against a mutated
version of what it guards is not guarding anything.

The gate never runs inference — that would move 241 MB and burn a minute on
every commit. What it proves instead is everything up to the point of a run:
the prompt the panel builds, the loader's manifest and checksum rules over a
stubbed fetch, the panel driven through a fake engine, the caches. When
touching `lib/gemma.js`, `lib/writing-tools.js`, or anything under
`vendor/wllama/` or `models/`, finish with `npm run check:model`: it presses
the real Run button against the committed bytes and fails loudly if a chunk
comes down twice, a fetch leaves this origin, or no answer arrives.

Speech to text has the same split and the same last step. When touching
`lib/whisper.js`, `lib/whisper-worker.js`, `lib/speech-panel.js`, or anything
under `vendor/transformers/` or `models/whisper-small-2d67713f/`, finish with
`npm run check:whisper`: it transcribes a real recording through the file
button, through Record with Chromium's fake microphone, and again with the
network cut.

## Style

Match what is already there rather than what you would pick:

- Two spaces, no semicolons, single quotes, trailing commas in multiline literals.
  `npm run lint` enforces correctness rules only (ESLint's recommended set);
  style is this list and `.editorconfig`, because a style rule here would just
  restate them.
- **Comments explain why, not what.** The existing code is unusually careful about
  this on purpose: a comment records a decision, a constraint, or a bug that
  already happened once. `// Increment i` is noise. `// The '#' is part of the URL,
  not of the payload the codec returns` is the kind of thing worth keeping.
- Prefer a named constant to a magic number in a condition, and say where the
  number came from if it is not obvious.
- Feature names in comments are lowercase and refer to menu labels
  (`# Title`, `My documents`), so they can be found with grep.

## Commit messages

Imperative, sentence case, no type prefix, one line:

```
Add the document library and list it from the menu
Find the flake: the tests were polling on frames that had stopped
Make the ZIP password test say what went wrong
```

One concern per commit. A commit that needs "and" in its summary wants splitting.

## Considered and rejected

Some ideas look right twice and are still wrong. They are listed here so the
next person does not have to re-derive why, and so an issue proposing one
starts from the reason rather than from zero.

- **A trash folder or a rename marker for deleted files.** The trash the app
  has now gained lives in the library database, never in the folder; this
  entry is about the mirrored files themselves. Folder sync deletes
  only files the manifest says the app wrote, and never on a first connect. A
  `.trash` or `.deleted` name would need its own cleanup policy, would still
  sit in a folder the reader opens in other editors, and every pass would have
  to learn to ignore it. Deleting the tracked file is the mirror doing what a
  mirror does.
- **A different layout for the mirror — subfolders by date or title, slug
  renames, or names chosen to be easy to `.gitignore` or to commit.** One flat
  directory of `Title.md` files with front matter is already both of those:
  one line ignores it, committing it gives diffs any editor can read. Any
  other shape turns every rename into a delete plus a create in the plan.
- **The note's title in the "updated from the folder" message.** The message
  appears next to the note it changed — the one on screen. Naming it added a
  second thing to read and no information.
- **A per-note conflict marker in the text.** Newest wins, and the arrival
  message says what happened and how to take it back (Ctrl+Z / ⌘Z). A marker
  would be written into plaintext files other editors open, and would then
  need its own story for ever being removed.
- **Deferring the statistics panel like the other panels.** It is wired into
  every save path at boot rather than sitting behind a menu entry, so
  deferring it would buy nothing and add a seam over work that already
  happens on every keystroke pause.
- **Chunked or async rendering for big notes.** The cost of a 1 MB note was
  two algorithmic bugs — text runs merged one neighbour at a time, and an
  inline scan that restarted six searches from every position. Fixing the
  roots made the cycle ten times faster on a byte-identical tree; yielding
  would have added visible artifacts to work around a problem that was gone.
- **Persisting the oversized-file count across sessions.** A count read back
  at boot could claim something that is no longer true — the folder may have
  shrunk, the file may be gone. A pass announces an oversized file when it
  finds it; the stale claim was not worth the saving.

## Pull requests

Fill in `.github/PULL_REQUEST_TEMPLATE.md`. In short:

- `npm run test:all` passes.
- Anything user-visible is described in **Differences from upstream** in the
  README. That section is the project's memory of its own decisions, and a
  feature that is not in it reads as an accident.
- Anything vendored arrives with its licence file and a line in
  `vendor/README.md`.
- New behaviour has a test that would fail without it.

## Reporting bugs

Open an issue with `.github/ISSUE_TEMPLATE/bug_report.yml`. The editor, the
browser and the operating system all matter — this is a page, so most bugs are
somebody's browser doing something specific.

If you think it is a security problem, do **not** open an issue. Follow
[SECURITY.md](SECURITY.md).

## Questions

Open an issue. Discussion is disabled here to keep one place for the answers, but
a question that comes up twice is usually a documentation gap worth fixing.
