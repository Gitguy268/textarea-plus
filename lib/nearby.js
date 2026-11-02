// Send to a nearby device: a WebRTC data channel between two open copies of the
// app, paired by scanning QR codes. The ideas come from LocalSend (send straight
// to a device nearby, and the receiver says yes before anything arrives) and
// qrcp (pair by scanning a code). No code from either.
//
// There are no ICE servers, so the only candidates are the devices' own
// addresses. Both must be on the same network, and nothing passes through a
// server. Guest or client-isolated Wi-Fi will not connect, and the panel says
// so when the connection times out.
//
// A pairing code is "1" (version), "o" or "a" (offer or answer), then the SDP
// through the same deflate + base64url codec as the note hash. In a link it sits
// behind "#rtc=", and the "=" cannot occur in a note hash, so the two never meet.

import {decodeHash, encodeHash} from './share.js'

export const SIGNAL_PREFIX = 'rtc='
export const MAX_BYTES = 64 * 1024 * 1024 // the same ceiling as an inflated link
const VERSION = '1'
const MAX_SDP = 16 * 1024
const CHUNK = 16 * 1024 // the size every browser's data channel accepts
const HIGH_WATER = 1024 * 1024
const GATHER_TIMEOUT = 4000
export const CONNECT_TIMEOUT = 20_000

export class NearbyError extends Error {
  constructor(message) {
    super(message)
    this.name = 'NearbyError'
  }
}

/* ------------------------------------------------------------ pairing codes */

/** {type, sdp} -> pairing code */
export async function encodeSignal({type, sdp}) {
  return VERSION + (type === 'offer' ? 'o' : 'a') + (await encodeHash(sdp))
}

/**
 * Pairing code, or a whole link holding one -> {type, sdp}.
 *
 * @throws {NearbyError} for anything that is not a code this version wrote
 */
export async function decodeSignal(input) {
  let code = String(input).trim()
  const at = code.indexOf('#' + SIGNAL_PREFIX)
  if (at !== -1) code = code.slice(at + 1 + SIGNAL_PREFIX.length)
  else if (code.startsWith(SIGNAL_PREFIX)) code = code.slice(SIGNAL_PREFIX.length)

  if (code.length < 3 || code[0] !== VERSION || !'oa'.includes(code[1])) {
    throw new NearbyError('That is not a pairing code from this app.')
  }
  let sdp
  try {
    sdp = await decodeHash(code.slice(2))
  } catch {
    throw new NearbyError('That pairing code is damaged. Scan or copy it again.')
  }
  if (!sdp.startsWith('v=0') || sdp.length > MAX_SDP) {
    throw new NearbyError('That pairing code is damaged. Scan or copy it again.')
  }
  return {type: code[1] === 'o' ? 'offer' : 'answer', sdp}
}

/* -------------------------------------------------------------- connection */

// Non-trickle: the whole candidate list goes into the one code. Some browsers
// never report "complete" without a STUN server, so the wait is capped.
function gathered(pc) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, GATHER_TIMEOUT)
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(timer)
        resolve()
      }
    })
  })
}

function peer() {
  if (typeof RTCPeerConnection !== 'function') {
    throw new NearbyError('This browser cannot connect to another device.')
  }
  return new RTCPeerConnection({iceServers: []})
}

/**
 * The sending side: an offer, and a way to finish with the receiver's answer.
 *
 * @returns {Promise<{pc: RTCPeerConnection, channel: RTCDataChannel, code: string,
 *   accept: (answer: string) => Promise<void>}>}
 */
export async function createOffer() {
  const pc = peer()
  const channel = pc.createDataChannel('note')
  await pc.setLocalDescription()
  await gathered(pc)
  return {
    pc,
    channel,
    code: await encodeSignal(pc.localDescription),
    async accept(answer) {
      const description = await decodeSignal(answer)
      if (description.type !== 'answer') {
        throw new NearbyError('That is the code from this device. Scan the one the other device shows.')
      }
      await pc.setRemoteDescription(description)
    },
  }
}

/**
 * The receiving side: answer an offer.
 *
 * @returns {Promise<{pc: RTCPeerConnection, channel: Promise<RTCDataChannel>, code: string}>}
 */
export async function answerOffer(offer) {
  const description = await decodeSignal(offer)
  if (description.type !== 'offer') {
    throw new NearbyError('That is a reply code. On the other device choose Send, then scan its code.')
  }
  const pc = peer()
  // The channel only arrives once the sender has applied this answer. If it
  // never does, or the network keeps the two apart, ICE gives up and says so.
  const channel = new Promise((resolve, reject) => {
    pc.addEventListener('datachannel', (event) => resolve(event.channel), {once: true})
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'failed') {
        reject(new NearbyError('The other device could not be reached. Both must be on the same Wi-Fi.'))
      }
    })
  })
  await pc.setRemoteDescription(description)
  await pc.setLocalDescription()
  await gathered(pc)
  return {pc, channel, code: await encodeSignal(pc.localDescription)}
}

/** Resolve when the channel is open, reject when it fails or takes too long. */
export function opened(channel, timeout = CONNECT_TIMEOUT) {
  if (channel.readyState === 'open') return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new NearbyError('The other device could not be reached. Both must be on the same Wi-Fi.')),
      timeout,
    )
    channel.addEventListener('open', () => {
      clearTimeout(timer)
      resolve()
    }, {once: true})
    channel.addEventListener('close', () => {
      clearTimeout(timer)
      reject(new NearbyError('The connection closed.'))
    }, {once: true})
  })
}

/* ---------------------------------------------------------------- transfer */

function nextMessage(channel) {
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      channel.removeEventListener('close', onClose)
      resolve(event.data)
    }
    const onClose = () => {
      channel.removeEventListener('message', onMessage)
      reject(new NearbyError('The other device closed the connection.'))
    }
    channel.addEventListener('message', onMessage, {once: true})
    channel.addEventListener('close', onClose, {once: true})
  })
}

function drained(channel) {
  if (channel.bufferedAmount <= HIGH_WATER) return Promise.resolve()
  channel.bufferedAmountLowThreshold = HIGH_WATER / 2
  return new Promise((resolve) => channel.addEventListener('bufferedamountlow', resolve, {once: true}))
}

/**
 * Offer a note, wait for the receiver's yes, then send it.
 *
 * @returns {Promise<boolean>} false when the receiver declined
 */
export async function sendNote(channel, {title, text}) {
  const bytes = new TextEncoder().encode(text)
  channel.send(JSON.stringify({v: 1, title: String(title).slice(0, 200), bytes: bytes.length}))
  if ((await nextMessage(channel)) !== 'accept') return false
  for (let i = 0; i < bytes.length; i += CHUNK) {
    await drained(channel)
    channel.send(bytes.slice(i, i + CHUNK))
  }
  // Closing before the receiver has everything can drop what is still buffered,
  // so the sender closes, and only once the receiver says it has it all.
  if ((await nextMessage(channel)) !== 'done') throw new NearbyError('The other device did not confirm.')
  channel.close()
  return true
}

/**
 * Receive one note. `confirm` sees the header and decides; nothing is read
 * past the header without a yes.
 *
 * @param {RTCDataChannel} channel
 * @param {object} options
 * @param {(offer: {title: string, bytes: number}) => Promise<boolean>} options.confirm
 * @param {number} [options.maxBytes]
 * @returns {Promise<{title: string, text: string} | null>} null when declined
 */
export async function receiveNote(channel, {confirm, maxBytes = MAX_BYTES}) {
  channel.binaryType = 'arraybuffer'
  let header
  try {
    header = JSON.parse(await nextMessage(channel))
  } catch (error) {
    if (error instanceof NearbyError) throw error
    throw new NearbyError('The other device sent something this app does not understand.')
  }
  const {v, title, bytes} = header ?? {}
  if (v !== 1 || typeof title !== 'string' || !Number.isSafeInteger(bytes) || bytes < 0) {
    throw new NearbyError('The other device sent something this app does not understand.')
  }
  if (bytes > maxBytes) throw new NearbyError('That note is too large to receive.')

  const offer = {title: title.slice(0, 200), bytes}
  if (!(await confirm(offer))) {
    channel.send('decline')
    return null
  }

  const body = new Uint8Array(bytes)
  let received = 0
  const done = bytes === 0 ? null : new Promise((resolve, reject) => {
    const onClose = () => reject(new NearbyError('The connection closed before the note arrived.'))
    const onMessage = (event) => {
      const chunk = event.data instanceof ArrayBuffer ? new Uint8Array(event.data) : null
      if (!chunk || received + chunk.length > bytes) {
        channel.removeEventListener('message', onMessage)
        channel.removeEventListener('close', onClose)
        reject(new NearbyError('The other device sent more than it announced.'))
        return
      }
      body.set(chunk, received)
      received += chunk.length
      if (received === bytes) {
        channel.removeEventListener('message', onMessage)
        channel.removeEventListener('close', onClose)
        resolve()
      }
    }
    channel.addEventListener('message', onMessage)
    channel.addEventListener('close', onClose, {once: true})
  })
  channel.send('accept')
  await done
  channel.send('done')
  // pc.close() does not flush, so wait for the sender to hang up after reading
  // 'done', or it reports a failure for a note that arrived.
  await new Promise((resolve) => {
    if (channel.readyState === 'closed') return resolve()
    const timer = setTimeout(resolve, 3000)
    channel.addEventListener('close', () => {
      clearTimeout(timer)
      resolve()
    }, {once: true})
  })
  return {title: offer.title, text: new TextDecoder().decode(body)}
}
