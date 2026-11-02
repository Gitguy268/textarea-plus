# Vendored third-party code

These files are checked in on purpose: this project has no build step and is
deployed as plain static files straight from the repository root. Keeping the
libraries here means the app works offline and does not depend on a CDN.

Nothing in this directory is loaded on the initial page load. Every library here
is fetched with a dynamic `import()` / `<script>` injection the first time a PDF
is opened, a ZIP is written, a QR code is drawn, a glass panel appears, the
on-device model is asked for or audio is transcribed, and the service worker caches them on first use.

## `zip.js/`

| | |
|---|---|
| Project | [gildas-lormeau/zip.js](https://github.com/gildas-lormeau/zip.js) |
| Package | [`@zip.js/zip.js`](https://www.npmjs.com/package/@zip.js/zip.js) |
| Version | 2.23.0 |
| License | BSD-3-Clause (see `zip.js/LICENSE`) |

`zip.min.js` is the prebuilt UMD bundle. It exposes the API as the `zip` global
and embeds its own web worker code and WebAssembly deflate implementation.

Used for writing and reading ZIP archives, including **WinZip AES AE-2
encryption** (`password` + `encryptionStrength: 3` → AES-256). The output opens
in 7-Zip, Keka, WinZip and Windows Explorer.

Why this and not a separate AES library: WinZip AE-2 is the only widely
interoperable password-protected ZIP format, and zip.js implements it natively.
A standalone AES implementation would produce a `.aes256` blob that no other
tool can open.

`Urban82/Aes256` was evaluated and rejected: it is a C++/CMake library (LGPL),
not JavaScript, so it cannot run in a browser.

## `pdfjs/`

| | |
|---|---|
| Project | [mozilla/pdf.js](https://github.com/mozilla/pdf.js) |
| Package | [`pdfjs-dist`](https://www.npmjs.com/package/pdfjs-dist) |
| Version | 6.4.299 |
| License | Apache-2.0 (see `pdfjs/LICENSE`) |

| Path | Size | Purpose |
|---|---|---|
| `pdf.min.mjs` | 459 KB | API: parsing, `streamTextContent()` |
| `pdf.worker.min.mjs` | 1.26 MB | Parsing worker |
| `cmaps/*.bcmap` | 1.6 MB (168 files) | Required for CJK encodings; without them those PDFs extract blank or mojibake |
| `standard_fonts/*.pfb` | 816 KB (10 files) | Fallback metrics for the 14 standard fonts |

The `wasm/` directory from the package is deliberately **not** vendored: it holds
JPEG 2000 and JBIG2 image decoders, which are only needed to render images in a
PDF, never to extract its text.

### Why pdf.js

Two Java libraries were evaluated for PDF text extraction and rejected as
unusable in a browser:

- [JonathanLink/PDFLayoutTextStripper](https://github.com/JonathanLink/PDFLayoutTextStripper)
  — a Java class extending Apache PDFBox's `PDFTextStripper`.
- [p2r3/convert](https://github.com/p2r3/convert) — a Bun + Vite application
  licensed GPL-2.0, not an embeddable library.

`lib/pdf-layout.js` re-implements the *idea* behind PDFLayoutTextStripper —
group text runs by their baseline, sort each line left to right, infer word
breaks from horizontal gaps and paragraph breaks from vertical gaps — on top of
the positioned text items pdf.js returns. That algorithm is a few dozen lines
of geometry and does not need the PDFBox machinery.

### Browser note

`page.getTextContent()` is **not** used. pdf.js implements it with
`for await (... of readableStream)`, and Safari has no
`ReadableStream.prototype[Symbol.asyncIterator]` before Safari 27, so the call
throws for every PDF there (mozilla/pdf.js#21557). `lib/pdf.js` consumes
`page.streamTextContent()` through `getReader()` instead, which works
everywhere.

## `qr/`

| | |
|---|---|
| Project | [kazuhikoarase/qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) |
| Package | [`qrcode-generator`](https://www.npmjs.com/package/qrcode-generator) |
| Version | 2.0.4 |
| License | MIT (see `qr/LICENSE`) |

| Path | Size | Purpose |
|---|---|---|
| `qrcode.mjs` | 52 KB | Reed-Solomon encoder and the module matrix |
| `qrcode_UTF8.mjs` | 1.6 KB | Replaces the default byte encoder with UTF-8 |

### Why qrcode-generator

A QR encoder is a few hundred lines of bit twiddling against the ISO/IEC 18004
tables, and getting the mask penalty scores or the format information bits wrong
produces a symbol that *looks* right and scans as nothing. Vendoring a
permissively licensed implementation is cheaper than owning that.

Two candidates were compared:

- [`qrcode-generator`](https://github.com/kazuhikoarase/qrcode-generator) —
  chosen. No dependencies, 52 KB of plain ESM, and it hands back the raw module
  matrix through `isDark(row, column)`, which means `lib/qr.js` owns the SVG
  output instead of emitting the library's opinionated markup. Its byte encoder
  is patched with `qrcode_UTF8.mjs`; without that patch any character above
  U+00FF is silently mangled, since the default encoder masks each code unit with
  `& 0xFF`.
- [`node-qrcode`](https://github.com/soldair/node-qrcode) — rejected. Correct, and
  it does UTF-8 itself, but the browser build is roughly twice the size, pulls in
  graph traversal and a PNG encoder to produce output this project does not want
  (SVG), and its browser entry point is not a native ES module.

Because `qrcode.mjs` is ordinary ESM with no DOM references, the encoder is
importable under Node, so `tests/unit/qr.test.js` asserts the module matrix of
`HELLO WORLD` against the published reference symbol instead of merely checking
that a string came back.

## `jsqr/`

| | |
|---|---|
| Project | [cozmo/jsQR](https://github.com/cozmo/jsQR) |
| Package | [`jsqr`](https://www.npmjs.com/package/jsqr) |
| Version | 1.4.0 |
| License | Apache-2.0 (see `jsqr/LICENSE`) |

| Path | Size | Purpose |
|---|---|---|
| `jsQR.js` | 257 KB | QR decoder over raw RGBA pixels, `dist/jsQR.js` from the package, unmodified |

`lib/qr-scan.js` reads the nearby-device panel's codes from the camera with the
browser's own `BarcodeDetector` where there is one (Chromium on macOS and
Android). Firefox, Safari and the other desktop Chromiums have none, and jsQR
is the fallback there, fetched only when a scan starts. The file is a webpack
UMD bundle: imported as a module for its side effect, it sets `self.jsQR`.

## `liquid-glass/`

| | |
|---|---|
| Project | [deepika-builds/liquid-glass](https://github.com/deepika-builds/liquid-glass) |
| Version | commit [`98ed97bd`](https://github.com/deepika-builds/liquid-glass/tree/98ed97bd99def529493fd37177228810f6422f6d) (upstream has no tags) |
| License | MIT (see `liquid-glass/LICENSE`) |

`liquid-glass.js` is the entire project: one dependency-free file exposing a
single `liquidGlass(element, options)` function. It draws a displacement map
on a canvas, wires it into an SVG filter, and points the element's
`backdrop-filter` at that filter so the page behind a panel visibly bends at
the rim — the defining trick of Apple's liquid glass, which a plain blur
cannot produce. The module owns the optics only; the tint, highlights and
shadows that make a panel read as glass are ordinary CSS in `index.html`.
Where the browser cannot use an SVG filter as a backdrop (Safari, Firefox),
it falls back to a frosted blur, which is close to the blur the menu had
before.

Used by `lib/glass.js` for the menu, the dialogs and the statistics panel,
behind the **Glass** row in the menu. Loaded on demand, like everything else
here.

The technique follows [Aave's write-up](https://aave.com/design/building-glass-for-the-web)
and [rizroze/liquid-glass](https://github.com/rizroze/liquid-glass), credited
in the file's own header.

### Why this one

Two other implementations were evaluated:

- [shuding/liquid-glass](https://github.com/shuding/liquid-glass) — a console
  demo, not a library: it spawns one hardcoded 300×200 draggable rectangle at
  the centre of the screen rather than styling an element you choose, and logs
  to the console on creation.
- [DevBehindYou/LiquidLens](https://github.com/DevBehindYou/LiquidLens) — a
  multi-platform monorepo whose web core is two CSS files plus one JS file
  behind a global `init()`, with no release history to pin.

`deepika-builds/liquid-glass` was the only one of the three shaped like the
libraries already vendored here: a single file, no dependencies, a per-element
API with `refresh()`/`destroy()` for open/close lifecycles, an automatic
fallback, and an MIT licence with a standalone `LICENSE` file.

## `liquid-glass-ui/`

| | |
|---|---|
| Project | [hwyuanzi/LiquidGlass-UI](https://github.com/hwyuanzi/LiquidGlass-UI) |
| License | MIT (see `liquid-glass-ui/LICENSE`) |

A licence and no code. LiquidGlass-UI is a set of web components, and its
refraction only works inside them, so it could not sit on the `<dialog>`s and
the menu this app already has - and it would have fought `liquid-glass/` for
the same `backdrop-filter`. What this app lacked was the other half of its
work: the material. Its stylesheet's recipe (a gradient fill, a rim, specular
and occlusion highlights, a sheen, and the fallbacks for more contrast and
forced colours) is ported into the `html.glass` block of `index.html`, which is
why its licence is here. The bending stays with `liquid-glass/`.

[iyinchao/liquid-glass-studio](https://github.com/iyinchao/liquid-glass-studio)
(MIT) was asked for too and is not here at all: it is a React and WebGL2
playground that needs a build step and refracts an image or a video it is
handed, never the page behind an element. Two of its parameters are borrowed
by eye - the angled glare and the rim brightest at two opposite corners - and
its dispersion is the `chroma` option `lib/glass.js` already passes.

## `wllama/`

| | |
|---|---|
| Project | [ngxson/wllama](https://github.com/ngxson/wllama) |
| Package | [`@wllama/wllama`](https://www.npmjs.com/package/@wllama/wllama) and [`@wllama/wllama-compat`](https://www.npmjs.com/package/@wllama/wllama-compat) |
| Version | 3.11.0, built from [`1a5687ef7c`](https://github.com/ngxson/wllama/commit/1a5687ef7c8b349a8bded4db334ae9c687c09b8c) on `master` (llama.cpp `5c8854f`), because the 3.8.1 release cannot load MiniCPM-V 4.7 |
| License | MIT (see `wllama/LICENSE`) |

| Path | Size | Purpose |
|---|---|---|
| `wllama.js` | 327 KB | The ESM bundle: `Wllama`, its OpenAI-compatible completion API, the cache and model managers |
| `wllama.wasm` | 8.6 MB | llama.cpp compiled for wasm with JSPI, memory64 and the WebGPU backend — the build modern browsers run |
| `wllama-compat.js` | 167 KB | Worker for the compatibility build |
| `wllama-compat.wasm` | 16 MB | wasm32 llama.cpp for browsers without JSPI or memory64 (older Safari and Firefox), handed to `setCompat()` so those browsers work without a CDN |

How it was built: `git clone https://github.com/ngxson/wllama && git checkout 1a5687ef7c && git submodule update --init`,
then `npm ci && npm run build:wasm && npm run build` (the wasm step runs emscripten in Docker). `wllama.js` is
`esm/index.min.js`, `wllama.wasm` is `src/wasm/wllama.wasm`, and the compat pair is `compat/wasm/wllama.{js,wasm}`.

Nothing here loads until the reader presses **Run** in the writing tools:
that press fetches `lib/gemma.js`, which fetches and verifies the model in
`../models/` and only then imports `wllama.js`, its worker and its wasm. The worker code
for the modern build lives inside the bundle itself and runs from a blob URL,
which the CSP's `worker-src 'self' blob:` already allowed before this arrived.

The wasm is why the service worker's content security policy gained
`'wasm-unsafe-eval'`: compiling a `WebAssembly.Module` counts as script
execution, and `'wasm-unsafe-eval'` grants exactly that and nothing weaker —
plain `'unsafe-eval'` stays banned, which the header tests assert both before
and after the amendment.

### Why wllama

The requirement was a model that ships *in the repository*: no download step, no
Hugging Face fetch at runtime, nothing that stops working offline. Two larger
names were evaluated against that:

- [`@huggingface/transformers`](https://github.com/huggingface/transformers.js)
  — runs ONNX models through onnxruntime-web with its own graph runners. It
  would work, but the model would have to be converted out of GGUF into ONNX
  (shards, external data, a second conversion of the tokenizer), the runtime is
  several megabytes more, and GGUF is the format this model is published and
  checksummed in.
- [`web-llm`](https://github.com/mlc-ai/web-llm) — excellent engine, but its
  whole design assumes models are fetched from a CDN catalog of hosted
  quantizations; a model committed to a repository is a thing it has no path
  for, and its scheduler machinery is far beyond "run one prompt".

wllama is one MIT-licensed ESM file plus llama.cpp as wasm, it loads `Blob[]`
straight from disk-shaped URLs, and it exposes the same `createChatCompletion`
shape as the online APIs — so `lib/gemma.js` stays a thin adapter and the
quantization the reader gets is byte-for-byte the GGUF in `models/`.

`wllama.wasm` and `wllama-compat.wasm` are
[llama.cpp](https://github.com/ggml-org/llama.cpp) compiled to WebAssembly.
llama.cpp is MIT licensed by the ggml authors, and its notice has to travel
with the binaries: it is `wllama/LICENSE-llama.cpp`.

### The model itself

The weights are **not** vendored here — they live in `../models/` as transport
chunks with their own README (source, quantization, SHA-256, licence). This
directory is code only; that directory is the 253 MB the code runs on.

## `transformers/`

| | |
|---|---|
| Project | [huggingface/transformers.js](https://github.com/huggingface/transformers.js) |
| Package | [`@huggingface/transformers`](https://www.npmjs.com/package/@huggingface/transformers) |
| Version | 4.3.1 |
| License | Apache-2.0 (see `transformers/LICENSE`) |
| Runtime inside it | [ONNX Runtime Web](https://github.com/microsoft/onnxruntime), `onnxruntime-web@1.31.0-dev.20260914-8d85527a0`, the exact build 4.3.1 pins; MIT (see `transformers/LICENSE-onnxruntime`) |

| Path | Size | Purpose |
|---|---|---|
| `transformers.min.js` | 586 KB | The self-contained ESM bundle: pipelines, tokenizers, Whisper's feature extractor and decoding, and ONNX Runtime's JavaScript half |
| `ort-wasm-simd-threaded.mjs` | 24 KB | ONNX Runtime's wasm loader |
| `ort-wasm-simd-threaded.wasm` | 14.3 MB | ONNX Runtime compiled to WebAssembly, the plain CPU build |
| `ort-wasm-simd-threaded.asyncify.mjs` | 53 KB | The loader of the WebGPU-capable build |
| `ort-wasm-simd-threaded.asyncify.wasm` | 26.9 MB | ONNX Runtime with its WebGPU backend, for Whisper large v3 turbo |

All four runtime files are byte for byte the ones in that exact
`onnxruntime-web` package (`dist/`).

Nothing here loads until the **Speech to text** panel has audio to
transcribe: that starts `lib/whisper-worker.js`, a module worker, which is the
only file that imports the bundle. The weights it runs are in
`../models/whisper-small-2d67713f/` and `../models/whisper-large-v3-turbo-efd60f61/`,
each with a README of its own. A worker loads one of the two runtime builds
and keeps it: the plain pair for small, the asyncify pair for turbo.

Three of the library's defaults reach off this origin, and the worker turns
each one around before the first call: models from `huggingface.co`
(`env.allowRemoteModels = false`, `env.localModelPath = '/models/'`), the
wasm from jsDelivr (`env.backends.onnx.wasm.wasmPaths`, both file names
spelled out), and two caches of its own that would store a second copy of
what the service worker already keeps (`env.useBrowserCache`,
`env.useWasmCache`). `npm run check:whisper` fails if a request leaves this
origin or if any runtime file but the bundle and the chosen model's pair is
asked for.

### Which files, and why not the others

- `transformers.min.js`, not `transformers.web.min.js`. The "web" bundle is
  smaller because it leaves ONNX Runtime out as bare imports
  (`onnxruntime-web/webgpu`, `onnxruntime-common`) for a bundler to resolve.
  There is no bundler here, and an import map does not reach into a worker.
- The plain wasm pair for Whisper small, whose 8-bit weights are for the
  CPU. The asyncify pair (27 MB) only for large v3 turbo, which is fp16 and
  4-bit on the GPU and is only offered where WebGPU can do half precision;
  it is downloaded the first time turbo is chosen, never for small. The
  recipe for turbo - transformers.js on WebGPU, an fp16 encoder with a 4-bit
  decoder - follows [lalax-systems/whisper-browser-gpu](https://github.com/lalax-systems/whisper-browser-gpu)
  (MIT) and the model card of
  [striimit/whisper-large-v3-turbo-webgpu](https://huggingface.co/striimit/whisper-large-v3-turbo-webgpu);
  no code is taken from either.
- One thread. The page is not cross-origin isolated (there is no
  `Cross-Origin-Embedder-Policy` header), so the browser gives wasm no
  shared memory and ONNX Runtime no thread pool. Whisper small still keeps
  up with speech, roughly, on a laptop.

### Why transformers.js

It was passed over for the writing tools because Gemma is published as GGUF.
Whisper is the other way round: the browser-ready conversion that exists is
ONNX, and transformers.js carries the parts of Whisper that are not the
network - the log-mel spectrogram, the tokenizer, the thirty-second windows
and the stitching of their overlaps. whisper.cpp compiled to wasm was the
alternative; it would have meant vendoring a build this project would have to
compile itself.

## `whisper-web/`

| | |
|---|---|
| Project | [xenova/whisper-web](https://github.com/xenova/whisper-web) |
| License | MIT (see `whisper-web/LICENSE`) |

A licence and no code. whisper-web is the application the **Speech to text**
panel was asked for by name, and it is a React, Vite and Tailwind app that
needs a build step and downloads its models from Hugging Face while it runs -
two things this project does not do. What is taken from it is the recipe:
Whisper through transformers.js in a web worker, the audio decoded by an
`AudioContext` at 16 kHz and mixed to mono before it crosses over, thirty
second windows with five seconds of overlap. Its interface, its model picker,
its transcription from a URL (which the Content-Security-Policy here forbids)
and its timestamps are not ported.

## `icons/`

No code lives here, only licence files. The icons themselves are inline
SVG in `index.html`:

| Set | Used for | License |
|---|---|---|
| [Aiko](https://github.com/tw93/aiko) (`assets/icons.svg` at `6ae2c093`) | Nineteen of the icons: the menu, close, delete, pin and archive | MIT (see `icons/LICENSE-aiko`) |
| [Tabler Icons](https://github.com/tabler/tabler-icons) | GitHub, unlock, columns, zip and save, which Aiko has no icon for | MIT (see `icons/LICENSE-tabler`) |
| [Material Symbols](https://github.com/google/material-design-icons) | QR code and the Glass drop | Apache-2.0 (see `icons/LICENSE-material-symbols`) |

## Refreshing

```sh
npm pack @zip.js/zip.js@<version> pdfjs-dist@<version> qrcode-generator@<version>
tar xzf zip.js-zip.js-<version>.tgz -C zip --strip-components=1
tar xzf pdfjs-dist-<version>.tgz -C pdfjs --strip-components=1
tar xzf qrcode-generator-<version>.tgz
cp zip/dist/zip.min.js zip/LICENSE vendor/zip.js/
cp pdfjs/build/pdf.min.mjs pdfjs/build/pdf.worker.min.mjs pdfjs/LICENSE vendor/pdfjs/
cp pdfjs/cmaps/*.bcmap pdfjs/cmaps/LICENSE vendor/pdfjs/cmaps/
cp pdfjs/standard_fonts/*.pfb pdfjs/standard_fonts/LICENSE_FOXIT vendor/pdfjs/standard_fonts/
cp package/dist/qrcode.mjs package/dist/qrcode_UTF8.mjs vendor/qr/
```

`qrcode-generator` ships no `LICENSE` file, only the MIT notice in the header of
each source file, so `vendor/qr/LICENSE` is transcribed from that header rather
than copied.

`liquid-glass` is not fetched from npm; it is pinned to a commit on GitHub:

```sh
curl -o vendor/liquid-glass/liquid-glass.js \
  https://raw.githubusercontent.com/deepika-builds/liquid-glass/<commit>/liquid-glass.js
curl -o vendor/liquid-glass/LICENSE \
  https://raw.githubusercontent.com/deepika-builds/liquid-glass/<commit>/LICENSE
```

wllama is two npm packages, since the main build and the compatibility build
version together:

```sh
npm pack @wllama/wllama@<version> @wllama/wllama-compat@<version>
tar xzf wllama-wllama-<version>.tgz -C wllama --strip-components=1
tar xzf wllama-wllama-compat-<version>.tgz -C wllama-compat --strip-components=1
cp wllama/esm/index.min.js vendor/wllama/wllama.js
cp wllama/esm/wasm/wllama.wasm vendor/wllama/wllama.wasm
cp wllama-compat/wasm/wllama.js vendor/wllama/wllama-compat.js
cp wllama-compat/wasm/wllama.wasm vendor/wllama/wllama-compat.wasm
```

Neither wllama tarball ships a licence file — the repository spells it
`LICENCE` — so `vendor/wllama/LICENSE` is transcribed from
[the repository's copy](https://github.com/ngxson/wllama/blob/master/LICENCE).

`vendor/wllama/LICENSE-llama.cpp` is
[llama.cpp's own licence file](https://github.com/ggml-org/llama.cpp/blob/master/LICENSE),
copied as it stands; refresh it with wllama, since the copyright years move.

transformers.js is one npm package, and the wasm comes from the ONNX Runtime
build that package depends on - read the version out of its `package.json`
rather than taking the latest:

```sh
npm pack @huggingface/transformers@<version>
tar xzf huggingface-transformers-<version>.tgz -C transformers --strip-components=1
cp transformers/dist/transformers.min.js transformers/LICENSE vendor/transformers/
npm pack onnxruntime-web@<the version transformers/package.json names>
tar xzf onnxruntime-web-<that version>.tgz -C ort --strip-components=1
cp ort/dist/ort-wasm-simd-threaded.mjs ort/dist/ort-wasm-simd-threaded.wasm vendor/transformers/
```

`vendor/transformers/LICENSE-onnxruntime` is
[ONNX Runtime's licence file](https://github.com/microsoft/onnxruntime/blob/main/LICENSE),
copied as it stands. Finish with `npm run check:whisper`.

The character maps and the standard fonts inside pdf.js have licences of their
own (Adobe's for the cmaps, Foxit's for the `.pfb` fonts), which is why those
two files are copied along with the data. The package's Liberation fonts are
`.ttf` files that are not vendored here, so their licence is not either.

Update the version tables above and the cache version in `sw.js` in the same
commit.
