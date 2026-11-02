// The writing tools panel: what the model in ../models/ is actually for.
//
// A reader picks a model and a tool, presses Run, and the note on screen
// goes through that model on this device - no request leaves the machine,
// which is the whole reason the weights are committed to the repository
// rather than fetched. The vision model adds two tools that work on an
// image the reader chooses instead of on the note. The panel draws the choice and the result; it never touches the
// model itself. Everything it needs from the app arrives as a function:
// `ensureModel` builds (or answers from cache) an engine with a `run`,
// `getText` reads the note, `getSelection`/`selectionAware` say whether the
// reader's selection stands in for that note, `getTools`/`getInstructions`
// read the settings that decide which tools exist and what extra
// instruction rides along, and `onReplace` puts a result back - the second
// argument naming the selection it belongs to, when it belongs to one -
// confirmation and saving being the app's business, the same way opening a
// link from a wikilink is.
//
// The selection is read when Run is pressed and kept, not re-read when
// Replace is: the reader replaces what was run on, even if the caret has
// wandered since, and one undo takes the whole thing back.
//
// That seam is deliberate: the browser test drives the entire panel through
// a fake engine, so the wasm, the 241 MB of weights and a slow first fetch
// are not what stands between a broken panel and a green suite. The real
// engine lives in lib/gemma.js and arrives through the same door.

import {icon} from './dialog.js'

/**
 * The tools the panel knows how to ask for, in the order they are offered.
 *
 * Each instruction is written for a small model: one job, stated
 * imperatively, plus the line that stops it from translating the reader's
 * prose into English on the way out.
 */
export const TOOLS = [
  {
    id: 'improve',
    label: 'Improve wording',
    instruction:
      'Rewrite the text so it reads better: smoother phrasing, clearer sentences, ' +
      'the same meaning, and the same language as the original.',
  },
  {
    id: 'shorten',
    label: 'Shorten',
    instruction:
      'Shorten the text, keeping every fact and dropping only what is redundant. ' +
      'Keep the same language as the original.',
  },
  {
    id: 'summarize',
    label: 'Summarize',
    instruction:
      'Summarize the text in a few sentences that make sense on their own. ' +
      'Use the same language as the original.',
  },
  {
    id: 'fix',
    label: 'Fix spelling & grammar',
    instruction:
      'Fix every spelling and grammar mistake. Change nothing else: the wording ' +
      'is the author’s.',
  },
  {
    id: 'casual',
    label: 'Make more casual',
    instruction:
      'Rewrite the text in a casual, conversational tone, keeping its meaning. ' +
      'Use the same language as the original.',
  },
  // The image tools: offered only while a model that reads images is picked,
  // and they work on the chosen image, not on the note.
  {
    id: 'describe',
    label: 'Describe image',
    image: true,
    instruction: 'Describe this image in a few clear sentences: what is in it, and any text it shows.',
  },
  {
    id: 'ocr',
    label: 'Read text from image',
    image: true,
    instruction: 'Write out all the text in this image exactly as it appears, keeping its line breaks.',
  },
]

/**
 * The writing models on offer, by the ids lib/gemma.js loads them under.
 * Named here and not there, the way speech-panel.js names its Whispers, so
 * the panel can list them without pulling the engine in. The sizes are the
 * first Run's download.
 */
export const MODELS = [
  {id: 'gemma', name: 'Gemma 3 270M · 253 MB · quickest'},
  {id: 'minicpm5', name: 'MiniCPM5 2B · 1.56 GB · best writing'},
  {id: 'minicpm-v', name: 'MiniCPM-V 4.7 1B · 1.57 GB · reads images', vision: true},
]

/** Longest side an image is sent at. The vision model cuts big images into
 *  more tiles, each one more seconds of encoding, for detail a note rarely needs. */
export const IMAGE_SIDE = 896

/**
 * An image file as the vision model takes it: scaled down to IMAGE_SIDE and
 * re-encoded as JPEG, plus a data URL of the same picture for the panel to
 * show (the page's CSP allows data: images, not blob: ones).
 *
 * @param {Blob} file
 * @param {Document} [owner]
 * @returns {Promise<{data: ArrayBuffer, preview: string}>}
 * @throws {Error} for a file the browser cannot decode as an image
 */
export async function prepareImage(file, owner = document) {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, IMAGE_SIDE / Math.max(bitmap.width, bitmap.height))
  const canvas = owner.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bitmap.width * scale))
  canvas.height = Math.max(1, Math.round(bitmap.height * scale))
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  const jpeg = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9))
  return {data: await jpeg.arrayBuffer(), preview: canvas.toDataURL('image/jpeg', 0.9)}
}

/**
 * The most note text one prompt will carry.
 *
 * A 270M model on a modest context is not a place to find out the hard way
 * that a novel was pasted in: the text is cut here, in plain sight, and the
 * panel says it did - a silent cut would be the tool lying about what it
 * worked on.
 */
export const NOTE_LIMIT = 24_000

/**
 * The messages for one tool run.
 *
 * @param {string} toolId one of TOOLS
 * @param {string} text the note on screen
 * @param {string} [instructions] the reader's custom instructions, if any
 * @param {ArrayBuffer} [image] the picture an image tool works on
 * @returns {{messages: Array<{role: string, content: string | Array<object>}>,
 *   truncated: boolean}}
 * @throws {Error} for a tool id the panel does not ship, or an image tool
 *   with no image
 */
export function buildPrompt(toolId, text, instructions = '', image = null) {
  const tool = TOOLS.find((candidate) => candidate.id === toolId)
  if (!tool) throw new Error(`unknown writing tool: ${toolId}`)

  const system = {
    role: 'system',
    content:
      `${tool.instruction}\n\n` +
      'Reply with the finished text only: no preamble, no explanation, ' +
      'and no quotation marks around it.',
  }
  const extra = String(instructions ?? '').trim()

  if (tool.image) {
    if (!image) throw new Error('choose an image first')
    return {
      truncated: false,
      messages: [
        system,
        {
          role: 'user',
          content: [
            {type: 'image', data: image},
            {type: 'text', text: extra ? `Extra instructions: ${extra}` : 'Here is the image.'},
          ],
        },
      ],
    }
  }

  const body = String(text ?? '')
  const truncated = body.length > NOTE_LIMIT
  const used = truncated ? body.slice(0, NOTE_LIMIT) : body

  const user = [`Text:\n\n${used}`, extra ? `Extra instructions: ${extra}` : null]
    .filter(Boolean)
    .join('\n\n')

  return {truncated, messages: [system, {role: 'user', content: user}]}
}

/**
 * Build the panel and return the handful of methods the app needs.
 *
 * The panel is built once and hidden rather than built per opening, like the
 * statistics and backlinks panels: the tool buttons are redrawn on every
 * open from whatever settings say now, so a tool switched off in settings is
 * gone from the row the next time anyone looks, and the active tool falls
 * back to the first one still offered.
 *
 * @param {object} options
 * @param {(onProgress: (message: string) => void, signal: AbortSignal,
 *   model: string) => Promise<{run: (messages: Array<object>) =>
 *   Promise<string>}>} options.ensureModel
 *   build or answer the engine for a model id, reporting progress into the
 *   status line
 * @param {() => string | null} [options.getModel] the remembered model id
 * @param {(id: string) => void} [options.setModel] remember the model id
 * @param {() => string} options.getText the note on screen
 * @param {() => {start: number, end: number, text: string}} [options.getSelection]
 *   the reader's selection, in the same flat offsets the note is read in
 * @param {() => boolean} [options.selectionAware]
 *   the reader's switch: work on the selection when there is one
 * @param {() => string[]} options.getTools the enabled tool ids
 * @param {() => string} options.getInstructions the extra instructions
 * @param {(text: string, selection: {start: number, end: number} | null) =>
 *   void} options.onReplace a result to put back, and the selection it
 *   belongs to - null when the run was the whole note
 * @param {Document} [options.owner]
 * @returns {{element: HTMLElement, open: () => void, close: () => void,
 *   refresh: () => void, toggle: () => boolean, isOpen: () => boolean,
 *   onDismiss: (handler: () => void) => void}}
 */
export function createWritingTools({
  ensureModel,
  getModel = () => null,
  setModel = () => {},
  getText,
  getSelection = () => ({start: 0, end: 0, text: ''}),
  selectionAware = () => false,
  getTools,
  getInstructions,
  onReplace,
  owner = document,
} = {}) {
  const panel = owner.createElement('aside')
  panel.id = 'writing-panel'
  panel.setAttribute('role', 'group')
  panel.setAttribute('aria-label', 'Writing tools')
  panel.hidden = true

  const head = owner.createElement('div')
  head.className = 'writing-head'

  const title = owner.createElement('p')
  title.className = 'writing-title'
  title.textContent = 'Writing tools'

  const closeButton = owner.createElement('button')
  closeButton.type = 'button'
  closeButton.className = 'writing-close'
  closeButton.setAttribute('aria-label', 'Close writing tools')
  closeButton.append(icon('icon-close', 16))
  head.append(title, closeButton)

  const model = owner.createElement('label')
  model.className = 'writing-model'
  const modelSelect = owner.createElement('select')
  model.append('Model', modelSelect)
  for (const {id, name} of MODELS) {
    const option = owner.createElement('option')
    option.value = id
    option.textContent = name
    modelSelect.append(option)
  }

  const extra = owner.createElement('p')
  extra.className = 'writing-extra'
  extra.hidden = true

  const tools = owner.createElement('div')
  tools.className = 'writing-tools'
  tools.setAttribute('role', 'group')
  tools.setAttribute('aria-label', 'Tools')

  // Shown while an image tool is picked: the image it will work on.
  const picture = owner.createElement('div')
  picture.className = 'writing-image'
  picture.hidden = true
  const chooseImage = owner.createElement('button')
  chooseImage.type = 'button'
  chooseImage.className = 'dialog-button writing-choose'
  chooseImage.textContent = 'Choose image'
  const imageInput = owner.createElement('input')
  imageInput.type = 'file'
  imageInput.accept = 'image/*'
  imageInput.hidden = true
  const preview = owner.createElement('img')
  preview.className = 'writing-preview'
  preview.alt = 'The chosen image'
  preview.hidden = true
  picture.append(preview, chooseImage, imageInput)

  const run = owner.createElement('button')
  run.type = 'button'
  run.className = 'dialog-button dialog-button-primary writing-run'
  run.textContent = 'Run'

  const status = owner.createElement('p')
  status.className = 'writing-status'
  status.setAttribute('aria-live', 'polite')

  const result = owner.createElement('div')
  result.className = 'writing-result'
  result.hidden = true

  const output = owner.createElement('p')
  output.className = 'writing-output'

  const replace = owner.createElement('button')
  replace.type = 'button'
  replace.className = 'dialog-button dialog-button-primary writing-replace'
  replace.textContent = 'Replace the note'

  result.append(output, replace)

  // Shown only while the model is on its way: the first Run downloads
  // 241 MB, and a reader on a metered connection has to be able to say no
  // after seeing that number rather than before.
  const cancel = owner.createElement('button')
  cancel.type = 'button'
  cancel.className = 'dialog-button writing-cancel'
  cancel.textContent = 'Cancel download'
  cancel.hidden = true

  panel.append(head, model, extra, tools, picture, run, status, cancel, result)

  /** The tool the next Run will use, kept as an id so a redraw can find it. */
  let active = TOOLS[0].id
  /** A Run is in flight; nothing starts a second one. */
  let running = false
  /**
   * The selection the visible result belongs to, captured when that Run
   * started. Replace hands it back with the answer; null for a run that was
   * the whole note.
   */
  let planned = null
  let dismissed = null
  /** The image the image tools work on, prepared for the model; null until chosen. */
  let image = null

  const vision = () => Boolean(MODELS.find(({id}) => id === modelSelect.value)?.vision)

  const setStatus = (text, {error = false} = {}) => {
    status.textContent = text
    status.classList.toggle('error', error)
  }

  /**
   * What the next Run will work on: the selection when the reader has asked
   * for selection-aware tools and there is one, the note otherwise. The
   * offsets ride along so Replace can put the answer back where the Run
   * looked, whatever has happened to the caret in the meantime.
   *
   * Whitespace-only selections are no selection: a stray drag across a line
   * break should not quietly halve the note the model is asked about.
   */
  const working = () => {
    const selection = getSelection()
    if (selectionAware() && selection.text.trim()) {
      return {selection: {start: selection.start, end: selection.end}, text: selection.text}
    }
    return {selection: null, text: getText()}
  }

  /**
   * Redraw the tool row from the settings and work out whether Run may be
   * pressed. Returns false when there is nothing to run at all - no tools
   * switched on - which is a settings answer, not a note one.
   */
  const syncState = () => {
    const enabled = getTools()
    const available = TOOLS.filter((tool) => enabled.includes(tool.id) && (!tool.image || vision()))

    tools.replaceChildren()
    if (!available.some((tool) => tool.id === active)) active = available[0]?.id ?? null

    for (const tool of available) {
      const button = owner.createElement('button')
      button.type = 'button'
      button.className = 'writing-tool'
      button.dataset.tool = tool.id
      button.textContent = tool.label
      button.setAttribute('aria-pressed', String(tool.id === active))
      button.addEventListener('click', () => {
        active = tool.id
        for (const peer of tools.querySelectorAll('.writing-tool')) {
          peer.setAttribute('aria-pressed', String(peer.dataset.tool === active))
        }
        // Not a redraw: the button just pressed keeps the focus.
        run.disabled = running || !ready()
      })
      tools.append(button)
    }

    const instruction = String(getInstructions() ?? '').trim()
    extra.textContent = instruction ? `Extra: ${instruction}` : ''
    extra.hidden = !instruction

    return ready()
  }

  /** Whether the active tool has what it works on: the note, or an image. */
  const ready = () => {
    const tool = TOOLS.find((candidate) => candidate.id === active)
    picture.hidden = !tool?.image
    if (!tool) {
      setStatus('No tools are switched on in settings.')
      return false
    }
    if (tool.image ? !image : !working().text.trim()) {
      setStatus(tool.image ? 'Choose an image to work on.' : 'There is nothing on screen to work on.')
      return false
    }
    if (!running) setStatus('')
    return true
  }

  const runTool = async () => {
    if (running || !syncState()) return

    const tool = TOOLS.find((candidate) => candidate.id === active)
    // An image tool's answer goes in at the cursor, or over the selection.
    const {selection, text} = tool.image ? {selection: getSelection(), text: ''} : working()
    // A copy each Run: the engine may hand the buffer it is given to its worker.
    const {messages, truncated} = buildPrompt(active, text, getInstructions(), image?.data.slice(0))
    running = true
    run.disabled = true
    modelSelect.disabled = true
    setStatus(truncated ? 'Working from the first 24,000 characters…' : 'Writing…')

    const abort = new AbortController()
    cancel.onclick = () => abort.abort()
    cancel.hidden = false
    try {
      const engine = await ensureModel(
        (message) => {
          if (running) setStatus(message)
        },
        abort.signal,
        modelSelect.value,
      )
      // Past this line there is nothing left to download, so nothing to cancel.
      cancel.hidden = true
      const answer = await engine.run(messages)
      output.textContent = answer
      // The button says which of the two the answer is for, so nobody has to
      // remember what the selection was when they pressed Run - and planned
      // keeps those offsets beside the answer they belong to. Set here, not
      // when the Run starts: a failed Run leaves the previous result, and
      // its offsets, on show.
      replace.textContent = !selection
        ? 'Replace the note'
        : selection.start === selection.end
          ? 'Insert at the cursor'
          : 'Replace the selection'
      planned = selection && {start: selection.start, end: selection.end}
      result.hidden = false
      setStatus('')
    } catch (error) {
      // Backing out is a decision, not a failure: said plainly, not in red.
      if (error?.name === 'AbortError') setStatus('Download cancelled. Run starts it again.')
      else setStatus(error?.message || String(error), {error: true})
    } finally {
      cancel.hidden = true
      running = false
      modelSelect.disabled = false
      // refresh() clears the status line for a panel that is idle, which is
      // right after an answer and wrong after a failure: the reason the Run
      // ended is the one thing the reader still needs to read.
      const said = status.textContent
      const failed = status.classList.contains('error')
      refresh()
      if (said) setStatus(said, {error: failed})
    }
  }

  run.addEventListener('click', () => void runTool())

  modelSelect.addEventListener('change', () => {
    setModel(modelSelect.value)
    refresh()
  })

  const takeImage = async (file) => {
    try {
      image = await prepareImage(file, owner)
      preview.src = image.preview
      preview.hidden = false
      result.hidden = true
      refresh()
    } catch {
      setStatus('That file is not an image this browser can open.', {error: true})
    }
  }
  chooseImage.addEventListener('click', () => imageInput.click())
  imageInput.addEventListener('change', () => {
    const [file] = imageInput.files
    imageInput.value = ''
    if (file) void takeImage(file)
  })
  // An image dropped anywhere on the panel, while an image tool is picked.
  panel.addEventListener('dragover', (event) => {
    if (!picture.hidden && event.dataTransfer?.types.includes('Files')) event.preventDefault()
  })
  panel.addEventListener('drop', (event) => {
    const file = event.dataTransfer?.files[0]
    if (picture.hidden || !file) return
    event.preventDefault()
    void takeImage(file)
  })

  replace.addEventListener('click', () => {
    const answer = output.textContent
    if (!answer) return
    result.hidden = true
    const selection = planned
    planned = null
    onReplace(answer, selection)
  })

  closeButton.addEventListener('click', () => {
    panel.hidden = true
    dismissed?.()
  })

  /**
   * Re-read everything the panel does not own - the note, the tools, the
   * instructions - and work out whether Run may be pressed. The app calls
   * this on every note change, the way the statistics panel is pushed its
   * counts: without it a button disabled for an empty note would have no
   * way to notice the reader has typed one, and would be a dead end.
   */
  const refresh = () => {
    const available = syncState()
    run.disabled = running || !available
  }

  const open = () => {
    const chosen = getModel()
    if (!running) modelSelect.value = MODELS.some(({id}) => id === chosen) ? chosen : MODELS[0].id
    panel.hidden = false
    result.hidden = true
    refresh()
  }

  const close = () => {
    panel.hidden = true
  }

  return {
    element: panel,
    open,
    close,
    refresh,

    toggle() {
      if (panel.hidden) open()
      else close()
      return !panel.hidden
    },

    isOpen() {
      return !panel.hidden
    },

    onDismiss(handler) {
      dismissed = handler
    },
  }
}
