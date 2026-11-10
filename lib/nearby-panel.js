// The Send to a device and Receive from a device panels.
//
// Pairing takes two codes. The sender shows an offer as a QR link: a phone's
// own camera opens the app from it, or Receive scans it in the app. The
// receiver then shows its answer, which the sender scans with its camera or has
// pasted in. After that the note goes over the direct connection in
// lib/nearby.js, and only once the receiver has said yes to it.

import {copyText} from './clipboard.js'
import {QrError, qrSvg} from './qr.js'
import {SIGNAL_PREFIX} from './nearby.js'

// A phone cannot open this machine's localhost, so a code made there points at
// the deployed copy instead.
// shortcut: hard-coded deploy URL, change it if the site moves.
const DEPLOYED = 'https://gitguy268-textarea-plus.vercel.app/'

function linkBase() {
  const {protocol, hostname} = location
  const local = protocol === 'file:' || hostname === 'localhost' || hostname === '[::1]' || hostname.startsWith('127.')
  return local ? DEPLOYED : location.origin + location.pathname
}

function element(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text) node.textContent = text
  return node
}

function button(label, primary = false) {
  const node = element('button', 'dialog-button' + (primary ? ' dialog-button-primary' : ''), label)
  node.type = 'button'
  return node
}

/** The parts both panels share, already in the page and shown. */
function panel(title) {
  const dialog = element('dialog', 'dialog dialog-qr dialog-nearby')
  const form = element('form', 'dialog-form')
  const heading = element('h2', 'dialog-title', title)
  const description = element('p', 'dialog-description')
  const error = element('p', 'dialog-error')
  error.setAttribute('role', 'alert')
  error.hidden = true
  const figure = element('div', 'qr-figure')
  figure.hidden = true
  const video = element('video', 'nearby-camera')
  video.hidden = true
  video.setAttribute('aria-label', 'Camera view for scanning a code')

  const entry = element('div', 'nearby-entry')
  const label = element('label', 'dialog-label', 'Or paste the code')
  const input = element('input', 'nearby-input')
  input.type = 'text'
  input.id = 'nearby-code'
  input.autocomplete = 'off'
  input.spellcheck = false
  label.htmlFor = input.id
  const scan = button('Scan with camera')
  const connect = button('Connect', true)
  entry.append(label, input)

  const status = element('p', 'dialog-note')
  status.setAttribute('role', 'status')
  const actions = element('div', 'dialog-actions')
  const close = button('Close')
  actions.append(close)

  form.append(heading, description, error, figure, video, entry, status, actions)
  dialog.append(form)

  let stopCamera = null
  const ui = {
    dialog, form, description, figure, video, entry, input, scan, connect, status, actions, close,
    say(message) {
      // Clearing the status must not clear an error shown since.
      if (message) error.hidden = true
      status.textContent = message
    },
    fail(message) {
      status.textContent = ''
      error.textContent = message
      error.hidden = false
    },
    async showQr(text) {
      try {
        // Parsed as XML, as in the QR panel: the string comes from the encoder,
        // and a document parsed as what it says it is cannot be reinterpreted.
        const svg = new DOMParser().parseFromString(
          // Low error correction: a pairing code goes screen to camera and is
          // never smudged, and the sparser symbol is what a webcam can read.
          await qrSvg(text, {dark: '#000000', light: '#ffffff', errorCorrection: 'L', label: 'Pairing code'}),
          'image/svg+xml',
        )
        figure.replaceChildren(document.importNode(svg.documentElement, true))
      } catch (cause) {
        figure.replaceChildren()
        ui.fail(cause instanceof QrError ? cause.message : 'This code could not be drawn. Copy it instead.')
      }
      figure.hidden = false
    },
    /** Read codes from the camera until `onText` returns true. */
    async startCamera(onText) {
      ui.stopCamera()
      video.hidden = false
      try {
        const {startScan} = await import('./qr-scan.js')
        stopCamera = await startScan(video, async (text) => {
          if (await onText(text)) ui.stopCamera()
        })
      } catch (cause) {
        video.hidden = true
        ui.fail(cause.message)
      }
    },
    stopCamera() {
      stopCamera?.()
      stopCamera = null
      video.hidden = true
    },
  }

  document.body.append(dialog)
  dialog.showModal()
  return ui
}

/**
 * Wire the paste box and the camera to one handler, run once per code.
 *
 * @param {(code: string) => Promise<void>} use  throws with a message to show
 */
function takeCode(ui, use) {
  let busy = false
  const attempt = async (text) => {
    if (busy) return false
    busy = true
    try {
      await use(text)
      return true
    } catch (cause) {
      ui.fail(cause?.message ?? 'That did not work.')
      return false
    } finally {
      busy = false
    }
  }
  ui.form.addEventListener('submit', (event) => {
    event.preventDefault()
    if (ui.input.value.trim()) void attempt(ui.input.value)
  })
  ui.connect.addEventListener('click', () => ui.form.requestSubmit())
  ui.scan.addEventListener('click', () => ui.startCamera(attempt))
  ui.actions.prepend(ui.scan)
  ui.actions.append(ui.connect)
  ui.entry.hidden = false
}

function closing(ui, cleanup) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      ui.stopCamera()
      cleanup()
      ui.dialog.close()
      ui.dialog.remove()
      resolve(value)
    }
    ui.close.addEventListener('click', () => finish(null))
    ui.dialog.addEventListener('cancel', (event) => {
      event.preventDefault()
      finish(null)
    })
    ui.finish = finish
  })
}

const kilobytes = (bytes) => (bytes < 1024 ? `${bytes} bytes` : `${Math.ceil(bytes / 1024)} KB`)

/**
 * Send a note to another device.
 *
 * @param {{title: string, text: string}} note
 * @returns {Promise<'sent'|'declined'|null>} null when closed first
 */
export async function showSendPanel(note) {
  const nearby = await import('./nearby.js')
  const ui = panel('Send to a device')
  let connection = null
  const done = closing(ui, () => connection?.pc.close())
  ui.entry.hidden = true
  ui.say('Making a pairing code…')

  try {
    connection = await nearby.createOffer()
  } catch (cause) {
    ui.fail(cause?.message ?? 'This browser cannot connect to another device.')
    return done
  }
  const link = linkBase() + '#' + SIGNAL_PREFIX + connection.code
  ui.description.textContent =
    '1. On the other device, scan this with the camera, or open Textarea there and choose ' +
    'Receive from a device. Both must be on the same Wi-Fi. ' +
    '2. Then scan the code it shows in return, or paste it below.'
  await ui.showQr(link)
  ui.say('')

  const copy = button('Copy link')
  copy.addEventListener('click', async () => {
    if (await copyText(link)) ui.say('Link copied. Open it on the other device.')
    else ui.fail('The browser would not copy to the clipboard.')
  })
  ui.actions.append(copy)

  takeCode(ui, async (answer) => {
    await connection.accept(answer)
    ui.figure.hidden = true
    ui.entry.hidden = true
    ui.scan.hidden = ui.connect.hidden = copy.hidden = true
    ui.say('Connecting…')
    try {
      await nearby.opened(connection.channel)
      ui.say(`Connected. Waiting for the other device to accept the note…`)
      const sent = await nearby.sendNote(connection.channel, note)
      ui.finish(sent ? 'sent' : 'declined')
    } catch (cause) {
      // The pairing is spent either way; a new one starts from the menu.
      ui.fail(cause?.message ?? 'The note could not be sent.')
    }
  })
  return done
}

/**
 * Receive a note from another device.
 *
 * @param {string} [offer]  a pairing code from a link; without one the panel asks for it
 * @returns {Promise<{title: string, text: string} | null>}
 */
export async function showReceivePanel(offer) {
  const nearby = await import('./nearby.js')
  const ui = panel('Receive from a device')
  let connection = null
  let copy = null
  let again = null
  const done = closing(ui, () => connection?.pc.close())

  const answer = async (code) => {
    const next = await nearby.answerOffer(code)
    connection?.pc.close()
    connection = next
    copy?.remove()
    again?.remove()
    ui.entry.hidden = true
    ui.scan.hidden = ui.connect.hidden = true
    ui.description.textContent =
      'Now on the sending device, choose Scan with camera and point it at this code, or copy the code across.'
    await ui.showQr(connection.code)
    copy = button('Copy code')
    copy.addEventListener('click', async () => {
      if (await copyText(connection.code)) ui.say('Code copied. Paste it on the sending device.')
      else ui.fail('The browser would not copy to the clipboard.')
    })
    ui.actions.append(copy)
    ui.say('Waiting for the sending device…')

    try {
      const channel = await connection.channel
      await nearby.opened(channel)
      copy.hidden = true
      ui.figure.hidden = true
      const note = await nearby.receiveNote(channel, {confirm: (header) => ask(ui, header)})
      ui.finish(note)
    } catch (cause) {
      ui.fail(cause?.message ?? 'The note could not be received.')
      ui.figure.hidden = true
      if (copy) copy.hidden = true
      // The sender's offer stays open until it takes an answer, so a fresh
      // answer still works if its reply was never scanned.
      again = button('New code')
      again.addEventListener('click', () => {
        void answer(code).catch((error) => ui.fail(error?.message ?? 'That did not work.'))
      })
      ui.actions.append(again)
    }
  }

  if (offer) {
    ui.description.textContent = 'Another device wants to send you a note. Connect to see what it is.'
    ui.entry.hidden = true
    const connect = button('Connect', true)
    ui.actions.append(connect)
    connect.addEventListener('click', async () => {
      connect.hidden = true
      try {
        await answer(offer)
      } catch (cause) {
        ui.fail(cause?.message ?? 'That did not work.')
      }
    })
  } else {
    ui.description.textContent =
      'On the sending device, choose Send to a device. Then scan the code it shows, or paste its link here.'
    takeCode(ui, answer)
  }
  return done
}

/** Accept or decline, asked inside the panel rather than over it. */
function ask(ui, {title, bytes}) {
  ui.say(`Accept “${title || 'Untitled'}” (${kilobytes(bytes)})?`)
  const decline = button('Decline')
  const accept = button('Accept', true)
  ui.actions.append(decline, accept)
  accept.focus()
  return new Promise((resolve) => {
    const answer = (value) => {
      decline.remove()
      accept.remove()
      ui.say(value ? 'Receiving…' : '')
      resolve(value)
    }
    accept.addEventListener('click', () => answer(true))
    decline.addEventListener('click', () => answer(false))
  })
}
