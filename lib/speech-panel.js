// The speech to text panel: what the Whisper in ../models/ is actually for.
//
// A reader presses Record and talks, or hands over an audio file, and the
// words come back as text to put in the note - transcribed on this device,
// with no request leaving the machine. The panel draws the buttons and the
// result; it never touches the model or the audio decoder itself. Everything
// it needs arrives as a function, the same seam lib/writing-tools.js has:
// `ensureModel` builds (or answers from cache) an engine with a `transcribe`,
// `decode` turns a recording into samples, `getLanguage`/`setLanguage`
// remember the one choice the panel offers, and `onInsert` puts a transcript
// into the note - where, and how it is undone, being the app's business.
//
// The panel is not modal, deliberately: a long recording takes minutes to
// transcribe, and the note stays readable and editable for all of them.
//
// The browser test drives the whole panel through a fake engine and a fake
// decoder, so 249 MB of weights and a wasm runtime are not what stands
// between a broken panel and a green suite. The real ones live in
// lib/whisper.js and arrive through the same door.

import {icon} from './dialog.js'
import {MAX_FILE_BYTES} from './open.js'

/**
 * The languages this Whisper knows, by the codes it knows them under.
 *
 * Codes only: the names a reader sees come from the browser, in the reader's
 * own language, so there is no table of ninety-nine translations to keep.
 */
export const LANGUAGES = (
  'af am ar as az ba be bg bn bo br bs ca cs cy da de el en es et eu fa fi fo fr gl gu haw ha ' +
  'he hi hr ht hu hy id is it ja jw ka kk km kn ko la lb ln lo lt lv mg mi mk ml mn mr ms mt ' +
  'my ne nl nn no oc pa pl ps pt ro ru sa sd si sk sl sn so sq sr su sv sw ta te tg th tk tl ' +
  'tr tt uk ur uz vi yi yo zh'
).split(' ')

/**
 * The two Whispers on offer, by the ids lib/whisper.js loads them under.
 *
 * Named here and not there, so the panel can list them without pulling the
 * engine in: nothing of the engine arrives before there is audio.
 * Large v3 turbo is fp16 on the GPU and nothing else - on the CPU it would be
 * minutes per sentence - so it is only offered where WebGPU can run it.
 */
export const MODELS = [
  {id: 'small', name: 'Small · 249 MB · runs everywhere'},
  {id: 'turbo', name: 'Large v3 turbo · 1.65 GB · WebGPU, more accurate', gpu: true},
]

/**
 * Whether this browser can run the turbo model: a WebGPU adapter that does
 * half-precision arithmetic, which its encoder is stored in.
 *
 * @param {GPU} [gpu]
 * @returns {Promise<boolean>}
 */
export async function hasWebGPU(gpu = globalThis.navigator?.gpu) {
  try {
    const adapter = await gpu?.requestAdapter()
    return Boolean(adapter?.features.has('shader-f16'))
  } catch {
    return false
  }
}

/**
 * The language a reader who has never chosen one is offered: the browser's
 * own when Whisper knows it, English when it does not.
 *
 * Whisper has to be told. Left to itself the library assumes English, which
 * turns a Dutch sentence into English-shaped nonsense rather than an error.
 *
 * @param {string} [preferred] a BCP 47 tag, such as `navigator.language`
 * @returns {string} one of LANGUAGES
 */
export function defaultLanguage(preferred = '') {
  const primary = String(preferred ?? '').toLowerCase().split('-')[0]
  return LANGUAGES.includes(primary) ? primary : 'en'
}

/**
 * Build the panel and return the handful of methods the app needs.
 *
 * @param {object} options
 * @param {(onProgress: (message: string) => void, signal: AbortSignal, model: string) =>
 *   Promise<{transcribe: (samples: Float32Array, options: {language: string,
 *   signal: AbortSignal}) => Promise<string>}>} options.ensureModel
 *   build or answer the engine, reporting progress into the status line
 * @param {(blob: Blob) => Promise<Float32Array>} options.decode
 *   a recording or a file as the samples the engine takes
 * @param {() => string | null} [options.getLanguage] the remembered choice
 * @param {(code: string) => void} [options.setLanguage]
 * @param {() => string | null} [options.getModel] the remembered model id
 * @param {(id: string) => void} [options.setModel]
 * @param {() => Promise<boolean>} [options.gpu] whether turbo can run here
 * @param {(text: string) => void} options.onInsert a transcript for the note
 * @param {() => boolean} [options.canOrganise] whether Organise by voice is on
 * @param {(text: string, options: {allNotes: boolean, say: (text: string,
 *   options?: {error?: boolean}) => void}) => Promise<void> | void} [options.onOrganise]
 *   the transcript, to be sorted into a board with the note (or every note);
 *   `say` writes into the panel's status line
 * @param {Document} [options.owner]
 * @returns {{element: HTMLElement, open: () => void, close: () => void,
 *   isOpen: () => boolean}}
 */
export function createSpeechPanel({
  ensureModel,
  decode,
  getLanguage = () => null,
  setLanguage = () => {},
  getModel = () => null,
  setModel = () => {},
  gpu = hasWebGPU,
  onInsert,
  canOrganise = () => false,
  onOrganise = () => {},
  owner = document,
} = {}) {
  const panel = owner.createElement('aside')
  panel.id = 'speech-panel'
  panel.setAttribute('role', 'group')
  panel.setAttribute('aria-label', 'Speech to text')
  panel.hidden = true

  const head = owner.createElement('div')
  head.className = 'writing-head'

  const title = owner.createElement('p')
  title.className = 'writing-title'
  title.textContent = 'Speech to text'

  const closeButton = owner.createElement('button')
  closeButton.type = 'button'
  closeButton.className = 'writing-close'
  closeButton.setAttribute('aria-label', 'Close speech to text')
  closeButton.append(icon('icon-close', 16))
  head.append(title, closeButton)

  const language = owner.createElement('label')
  language.className = 'speech-language'
  const select = owner.createElement('select')
  language.append('Spoken language', select)

  // Named by the browser, in the reader's language; a code it has no name
  // for is shown as the code.
  const names = new Intl.DisplayNames([navigator.language], {type: 'language'})
  const named = LANGUAGES.map((code) => {
    let name = code
    try {
      name = names.of(code) ?? code
    } catch {
      // Not a tag this browser accepts: the code stands in for itself.
    }
    return {code, name}
  }).sort((a, b) => a.name.localeCompare(b.name))
  for (const {code, name} of named) {
    const option = owner.createElement('option')
    option.value = code
    option.textContent = name
    select.append(option)
  }

  const model = owner.createElement('label')
  model.className = 'speech-language'
  const modelSelect = owner.createElement('select')
  model.append('Model', modelSelect)
  for (const {id, name} of MODELS) {
    const option = owner.createElement('option')
    option.value = id
    option.textContent = name
    modelSelect.append(option)
  }
  /** Asked once, the first time the panel opens. */
  let gpuReady = null

  const actions = owner.createElement('div')
  actions.className = 'speech-actions'

  const record = owner.createElement('button')
  record.type = 'button'
  record.className = 'dialog-button dialog-button-primary speech-record'
  // No microphone API (an insecure origin, an old browser) leaves the file
  // button as the one way in, rather than a Record that can only fail.
  record.hidden = !(typeof MediaRecorder === 'function' && navigator.mediaDevices?.getUserMedia)

  const choose = owner.createElement('button')
  choose.type = 'button'
  choose.className = 'dialog-button speech-file'
  choose.textContent = 'Choose file'

  const input = owner.createElement('input')
  input.type = 'file'
  input.accept = 'audio/*,video/*'
  input.className = 'speech-input'
  input.hidden = true

  actions.append(record, choose, input)

  const status = owner.createElement('p')
  status.className = 'writing-status'
  status.setAttribute('aria-live', 'polite')

  // The first transcription downloads 249 MB, and a long one runs for
  // minutes: both are the reader's to call off.
  const cancel = owner.createElement('button')
  cancel.type = 'button'
  cancel.className = 'dialog-button writing-cancel'
  cancel.textContent = 'Cancel'
  cancel.hidden = true

  const result = owner.createElement('div')
  result.className = 'writing-result'
  result.hidden = true

  const output = owner.createElement('p')
  output.className = 'writing-output'

  const insert = owner.createElement('button')
  insert.type = 'button'
  insert.className = 'dialog-button dialog-button-primary writing-replace'
  insert.textContent = 'Insert at the cursor'

  // Organise by voice: shown only while its switch in Settings is on.
  const organise = owner.createElement('button')
  organise.type = 'button'
  organise.className = 'dialog-button speech-organise'
  organise.textContent = 'Organise into a board'

  const allNotes = owner.createElement('label')
  allNotes.className = 'speech-all-notes'
  const allBox = owner.createElement('input')
  allBox.type = 'checkbox'
  allBox.checked = true
  allNotes.append(allBox, ' Sort all my notes too, not only this one')

  result.append(output, insert, organise, allNotes)
  panel.append(head, language, model, actions, status, cancel, result)

  /** A transcription is in flight; nothing starts a second one. */
  let running = false
  /** The recording in progress, or null. */
  let recorder = null
  /** The recording in progress is being thrown away, not transcribed. */
  let discarding = false

  const setStatus = (text, {error = false} = {}) => {
    status.textContent = text
    status.classList.toggle('error', error)
  }

  const sync = () => {
    record.textContent = recorder ? 'Stop' : 'Record'
    record.disabled = running
    choose.disabled = running || Boolean(recorder)
    select.disabled = running
    modelSelect.disabled = running
  }

  const transcribe = async (blob) => {
    if (running) return
    running = true
    result.hidden = true
    sync()

    const abort = new AbortController()
    cancel.onclick = () => abort.abort()
    cancel.hidden = false
    try {
      setStatus('Reading the audio…')
      const samples = await decode(blob)
      // Cancel pressed while the audio was being read: stop here, before the
      // engine is asked for anything it would have to be torn down to refuse.
      abort.signal.throwIfAborted()
      const engine = await ensureModel((message) => setStatus(message), abort.signal, modelSelect.value)
      setStatus('Transcribing…')
      const text = (await engine.transcribe(samples, {language: select.value, signal: abort.signal})).trim()
      if (!text) {
        setStatus('No speech was heard.')
        return
      }
      output.textContent = text
      organise.hidden = allNotes.hidden = !canOrganise()
      result.hidden = false
      setStatus('')
    } catch (error) {
      // Backing out is a decision, not a failure: said plainly, not in red.
      if (error?.name === 'AbortError') setStatus('Cancelled.')
      else setStatus(error?.message || String(error), {error: true})
    } finally {
      cancel.hidden = true
      running = false
      sync()
    }
  }

  const startRecording = async () => {
    setStatus('')
    // Disabled across the permission prompt, so a second click cannot ask
    // for a second microphone.
    record.disabled = true
    let stream
    try {
      stream = await navigator.mediaDevices.getUserMedia({audio: true})
    } catch (error) {
      const refused = error?.name === 'NotAllowedError' || error?.name === 'SecurityError'
      // Chromium words a refusal by the operating system - the browser
      // itself not allowed the microphone - differently from one by the
      // reader, and the fix is somewhere else entirely.
      const bySystem = refused && /system/i.test(error?.message ?? '')
      setStatus(
        bySystem
          ? 'Your computer blocks this browser from the microphone. Allow it in System Settings → Privacy & Security → Microphone, then restart the browser.'
          : refused
            ? 'The microphone was refused. Allow it for this site, or choose an audio file.'
            : error?.name === 'NotFoundError'
              ? 'No microphone was found.'
              : error?.name === 'NotReadableError'
                ? 'The microphone could not be opened. Another app may be using it, or the system blocked it.'
                : error?.message || String(error),
        {error: true},
      )
      sync()
      return
    }

    const release = () => {
      for (const track of stream.getTracks()) track.stop()
    }
    // Closed while the browser was still asking: nothing is recorded.
    if (panel.hidden) {
      release()
      sync()
      return
    }

    const pieces = []
    const current = new MediaRecorder(stream)
    current.addEventListener('dataavailable', (event) => pieces.push(event.data))
    current.addEventListener('stop', () => {
      release()
      recorder = null
      sync()
      if (discarding) setStatus('')
      else void transcribe(new Blob(pieces, {type: current.mimeType}))
    })
    discarding = false
    recorder = current
    current.start()
    setStatus('Recording… press Stop when you are done.')
    sync()
  }

  record.addEventListener('click', () => {
    if (recorder) recorder.stop()
    else void startRecording()
  })

  choose.addEventListener('click', () => input.click())

  input.addEventListener('change', () => {
    const file = input.files?.[0]
    // Cleared so choosing the same file twice in a row is still a change.
    input.value = ''
    if (!file) return
    if (file.size > MAX_FILE_BYTES) {
      setStatus(
        `${file.name} is larger than the ${Math.round(MAX_FILE_BYTES / (1024 * 1024))} MB this editor reads.`,
        {error: true},
      )
      return
    }
    void transcribe(file)
  })

  select.addEventListener('change', () => setLanguage(select.value))
  modelSelect.addEventListener('change', () => setModel(modelSelect.value))

  insert.addEventListener('click', () => {
    const text = output.textContent
    if (!text) return
    result.hidden = true
    onInsert(text)
  })

  organise.addEventListener('click', () => {
    const text = output.textContent
    if (!text) return
    result.hidden = true
    void onOrganise(text, {allNotes: allBox.checked, say: setStatus})
  })

  /**
   * Hide the panel. A recording dies with it - a microphone must never stay
   * live behind a panel nobody can see - while a download or a transcription
   * carries on, and its result is there when the panel is opened again.
   */
  const close = () => {
    panel.hidden = true
    if (recorder) {
      discarding = true
      recorder.stop()
    }
  }

  closeButton.addEventListener('click', close)

  return {
    element: panel,
    close,

    open() {
      const remembered = getLanguage()
      select.value = LANGUAGES.includes(remembered) ? remembered : defaultLanguage(navigator.language)
      const chosen = getModel()
      modelSelect.value = MODELS.some(({id}) => id === chosen) ? chosen : MODELS[0].id
      gpuReady ??= gpu().then((ready) => {
        if (ready) return
        for (const option of modelSelect.options) {
          if (!MODELS.find(({id}) => id === option.value)?.gpu) continue
          option.disabled = true
          option.textContent += ' (no WebGPU in this browser)'
        }
        if (modelSelect.selectedOptions[0]?.disabled) modelSelect.value = MODELS[0].id
      })
      panel.hidden = false
      sync()
    },

    isOpen() {
      return !panel.hidden
    },
  }
}
