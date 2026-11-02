import assert from 'node:assert/strict'
import test from 'node:test'

import {decodeSignal, encodeSignal, NearbyError, receiveNote, sendNote} from '../../lib/nearby.js'
import {encodeQr} from '../../lib/qr.js'
import {encodeHash} from '../../lib/share.js'

const SDP = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\na=fingerprint:sha-256 AB:CD\r\n'

/** Two ends of an in-memory data channel, delivering asynchronously like the real one. */
function channelPair() {
  const make = () => Object.assign(new EventTarget(), {readyState: 'open', bufferedAmount: 0})
  const a = make()
  const b = make()
  const wire = (from, to) => {
    from.send = (data) => {
      const copy = typeof data === 'string' ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
      setTimeout(() => to.dispatchEvent(new MessageEvent('message', {data: copy})))
    }
  }
  wire(a, b)
  wire(b, a)
  for (const end of [a, b]) {
    end.close = () => {
      for (const side of [a, b]) {
        side.readyState = 'closed'
        setTimeout(() => side.dispatchEvent(new Event('close')))
      }
    }
  }
  return [a, b]
}

test('a pairing code round trips, bare or inside a link', async () => {
  const offer = await encodeSignal({type: 'offer', sdp: SDP})
  assert.match(offer, /^1o[A-Za-z0-9_-]+$/)
  assert.deepEqual(await decodeSignal(offer), {type: 'offer', sdp: SDP})
  assert.deepEqual(await decodeSignal(`https://example.test/#rtc=${offer}\n`), {type: 'offer', sdp: SDP})
  const answer = await encodeSignal({type: 'answer', sdp: SDP})
  assert.equal((await decodeSignal('rtc=' + answer)).type, 'answer')
})

test('anything else is refused as a pairing code', async () => {
  for (const input of ['', 'hello', '2o' + (await encodeHash(SDP)), '1x' + (await encodeHash(SDP)), '1o!!!']) {
    await assert.rejects(decodeSignal(input), NearbyError, JSON.stringify(input))
  }
  // Valid codec, but not an SDP.
  await assert.rejects(decodeSignal('1o' + (await encodeHash('not sdp'))), NearbyError)
  await assert.rejects(decodeSignal('1o' + (await encodeHash('v=0' + 'x'.repeat(20_000)))), NearbyError)
})

test('a note crosses in chunks, after the receiver accepts', async () => {
  const [sender, receiver] = channelPair()
  const text = 'Ünïcode 🎉 ' + 'x'.repeat(50_000)
  let seen = null
  const [sent, note] = await Promise.all([
    sendNote(sender, {title: 'Big note', text}),
    receiveNote(receiver, {confirm: async (offer) => ((seen = offer), true)}),
  ])
  assert.equal(sent, true)
  assert.deepEqual(seen, {title: 'Big note', bytes: new TextEncoder().encode(text).length})
  assert.deepEqual(note, {title: 'Big note', text})
})

test('an empty note crosses too', async () => {
  const [sender, receiver] = channelPair()
  const [sent, note] = await Promise.all([
    sendNote(sender, {title: '', text: ''}),
    receiveNote(receiver, {confirm: async () => true}),
  ])
  assert.equal(sent, true)
  assert.deepEqual(note, {title: '', text: ''})
})

test('a decline sends nothing', async () => {
  const [sender, receiver] = channelPair()
  let chunks = 0
  receiver.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') chunks++
  })
  const [sent, note] = await Promise.all([
    sendNote(sender, {title: 'No', text: 'secret'}),
    receiveNote(receiver, {confirm: async () => false}),
  ])
  assert.equal(sent, false)
  assert.equal(note, null)
  assert.equal(chunks, 0)
})

test('the receiver refuses a header over its cap, and a sender that lies', async () => {
  let [sender, receiver] = channelPair()
  let asked = false
  const big = receiveNote(receiver, {confirm: async () => (asked = true), maxBytes: 10})
  sender.send(JSON.stringify({v: 1, title: 't', bytes: 11}))
  await assert.rejects(big, /too large/)
  assert.equal(asked, false, 'nothing is asked about a note that cannot be taken')

  ;[sender, receiver] = channelPair()
  const lying = receiveNote(receiver, {confirm: async () => true})
  sender.send(JSON.stringify({v: 1, title: 't', bytes: 2}))
  sender.addEventListener('message', (event) => {
    if (event.data === 'accept') sender.send(new Uint8Array(3))
  })
  await assert.rejects(lying, /more than it announced/)

  ;[sender, receiver] = channelPair()
  const garbage = receiveNote(receiver, {confirm: async () => true})
  sender.send('{"v":1,"title":5,"bytes":1}')
  await assert.rejects(garbage, NearbyError)
})

test('a real-sized pairing code still reads at webcam resolution', async () => {
  // What Chromium writes for a data channel with two mDNS host candidates.
  const sdp = [
    'v=0', 'o=- 4611731400430051336 2 IN IP4 127.0.0.1', 's=-', 't=0 0', 'a=group:BUNDLE 0',
    'a=extmap-allow-mixed', 'a=msid-semantic: WMS', 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    'a=candidate:1830156466 1 udp 2113937151 75e730f7-3579-4fd4-b18b-d9ab118fc068.local 63212 typ host generation 0 network-cost 999',
    'a=candidate:1713879950 1 udp 2113939711 1d720845-1d59-470c-b36e-f0a344449be1.local 62937 typ host generation 0 network-cost 999',
    'a=ice-ufrag:fhZe', 'a=ice-pwd:FABtsQpDsdqyioZYESTouTrK', 'a=ice-options:trickle',
    'a=fingerprint:sha-256 4E:1F:0B:8C:69:9A:3D:22:5E:B7:41:6D:0C:F2:AA:13:97:58:E0:3B:C4:7D:21:66:9F:0E:B3:58:2A:71:CD:04',
    'a=setup:active', 'a=mid:0', 'a=sctp-port:5000', 'a=max-message-size:262144', '',
  ].join('\r\n')
  const code = await encodeSignal({type: 'answer', sdp})
  const {count, isDark} = await encodeQr(code, {errorCorrection: 'L'})

  // The symbol as a 640x480 frame sees it from arm's length: 3 px a module.
  const width = 640
  const height = 480
  const scale = 3
  const offset = Math.floor((height - (count + 8) * scale) / 2)
  const pixels = new Uint8ClampedArray(width * height * 4).fill(255)
  for (let row = 0; row < count; row++) {
    for (let column = 0; column < count; column++) {
      if (!isDark(row, column)) continue
      for (let y = 0; y < scale; y++) {
        for (let x = 0; x < scale; x++) {
          const at = ((offset + (row + 4) * scale + y) * width + offset + (column + 4) * scale + x) * 4
          pixels[at] = pixels[at + 1] = pixels[at + 2] = 0
        }
      }
    }
  }
  // Loaded the way lib/qr-scan.js loads it: a module import that sets self.jsQR.
  globalThis.self ??= globalThis
  await import('../../vendor/jsqr/jsQR.js')
  assert.equal(globalThis.jsQR(pixels, width, height)?.data, code)
  assert.ok(count * scale < height, `a ${count}-module symbol fits the frame`)
})
