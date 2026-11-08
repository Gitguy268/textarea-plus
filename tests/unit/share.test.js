import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DecryptError,
  decodeHash,
  decryptHash,
  encodeHash,
  encryptHash,
  ENCRYPTED_PREFIX,
  fromBase64Url,
  isEncryptedHash,
  isHashTooLong,
  joinContent,
  splitContent,
  toBase64Url,
} from '../../lib/share.js'

const PASSWORD = 'a good long password'

test('base64url round trips and produces url safe output', () => {
  const bytes = new Uint8Array([0, 1, 250, 251, 252, 253, 254, 255, 65, 66, 67])
  const encoded = toBase64Url(bytes)
  assert.match(encoded, /^[A-Za-z0-9_-]+$/, 'no +, / or = may appear')
  assert.deepEqual([...fromBase64Url(encoded)], [...bytes])
})

test('a long buffer survives the chunked fallback encoder', () => {
  const bytes = new Uint8Array(200_000)
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256
  assert.deepEqual([...fromBase64Url(toBase64Url(bytes))].length, bytes.length)
})

test('the plain hash stays compatible with the upstream encoding', async () => {
  const content = 'Hello\nWorld\x00color: red'
  const hash = await encodeHash(content)
  assert.match(hash, /^[A-Za-z0-9_-]+$/, 'no marker, so an old reader still understands it')
  assert.equal(await decodeHash(hash), content)
})

test('an empty note round trips', async () => {
  assert.equal(await decodeHash(await encodeHash('')), '')
})

test('large and awkward notes round trip', async () => {
  const content = ('line with ünïcode, emoji 🎉 and ]]>\n'.repeat(2000))
  assert.equal(await decodeHash(await encodeHash(content)), content)
})

test('a link that expands past the inflation limit is refused', async () => {
  // 70 MB of a single character deflates to a few dozen kilobytes: a hash a
  // browser will happily hold, expanding into far more text than any note.
  const huge = 'a'.repeat(70 * 1024 * 1024)
  const hash = await encodeHash(huge)
  await assert.rejects(() => decodeHash(hash), /too much text/)
})

test('encryption round trips and marks the hash', async () => {
  const content = 'the launch codes'
  const payload = await encryptHash(content, PASSWORD)
  const hash = ENCRYPTED_PREFIX + payload

  assert.ok(isEncryptedHash(hash))
  assert.ok(!isEncryptedHash('#' + payload))
  assert.equal(await decryptHash(payload, PASSWORD), content)
})

test('ciphertext does not contain the plaintext', async () => {
  const payload = await encryptHash('SENSITIVE LAUNCH CODE', PASSWORD)
  const raw = Buffer.from(fromBase64Url(payload)).toString('latin1')
  assert.ok(!raw.includes('SENSITIVE'))
  assert.ok(!raw.includes('LAUNCH'))
})

test('a wrong password is refused', async () => {
  const payload = await encryptHash('secret', PASSWORD)
  await assert.rejects(() => decryptHash(payload, 'wrong password'), DecryptError)
  await assert.rejects(() => decryptHash(payload, PASSWORD + 'x'), DecryptError)
  await assert.rejects(() => decryptHash(payload, ''), DecryptError)
})

test('a password differing only by unicode normalisation still works', async () => {
  // A password typed on macOS with a combining accent must open a link created
  // with the precomposed form, or the link is silently unopenable.
  const precomposed = 'caf\u00e9' // e-acute as one code point
  const decomposed = 'cafe\u0301' // e + combining acute
  assert.notEqual(precomposed, decomposed)
  assert.equal(precomposed.normalize('NFC'), precomposed)

  const payload = await encryptHash('text', precomposed)
  assert.equal(await decryptHash(payload, decomposed), 'text')
})

test('a tampered ciphertext is rejected', async () => {
  const payload = await encryptHash('secret', PASSWORD)
  const bytes = fromBase64Url(payload)

  // Flip a bit in the ciphertext body, past the header.
  const index = bytes.length - 1
  bytes[index] ^= 0x01

  await assert.rejects(() => decryptHash(toBase64Url(bytes), PASSWORD), DecryptError)
})

test('a truncated or unknown payload is rejected without touching the cipher', async () => {
  await assert.rejects(() => decryptHash('AAAA', PASSWORD), DecryptError)
  await assert.rejects(() => decryptHash('!!!not base64!!!', PASSWORD), DecryptError)
  await assert.rejects(() => decryptHash('', PASSWORD), DecryptError)

  // Right length, wrong magic.
  const bytes = new Uint8Array(80)
  await assert.rejects(() => decryptHash(toBase64Url(bytes), PASSWORD), DecryptError)
})

test('an implausible iteration count is refused before the key is derived', async () => {
  const payload = await encryptHash('secret', PASSWORD)
  const bytes = fromBase64Url(payload)
  // The iteration count is the last field of the header.
  new DataView(bytes.buffer).setUint32(4 + 16 + 12, 0xffffffff)
  await assert.rejects(
    () => decryptHash(toBase64Url(bytes), PASSWORD),
    /implausible amount of work/,
  )
})

test('an iteration count below the floor is refused', async () => {
  const payload = await encryptHash('secret', PASSWORD)
  const bytes = fromBase64Url(payload)
  new DataView(bytes.buffer).setUint32(4 + 16 + 12, 1)
  await assert.rejects(
    () => decryptHash(toBase64Url(bytes), PASSWORD),
    /implausible amount of work/,
  )
})

test('two encryptions of the same note differ, so a link is not fingerprintable', async () => {
  const a = await encryptHash('same', PASSWORD)
  const b = await encryptHash('same', PASSWORD)
  assert.notEqual(a, b, 'a random salt and iv per encryption')
  assert.equal(await decryptHash(a, PASSWORD), await decryptHash(b, PASSWORD))
})

test('content splits on the NUL separator that cannot occur in the text', () => {
  assert.deepEqual(splitContent('just text'), {text: 'just text', style: null})
  assert.deepEqual(splitContent('text\x00color: red'), {text: 'text', style: 'color: red'})
  assert.deepEqual(splitContent('text\x00'), {text: 'text', style: null})

  assert.equal(joinContent('text', null), 'text')
  assert.equal(joinContent('text', ''), 'text')
  assert.equal(joinContent('text', 'color: red'), 'text\x00color: red')
})

test('split and join are inverses', () => {
  for (const style of [null, '', 'color: red', 'font: 12px/1.5 system-ui; tab-size: 2']) {
    const content = joinContent('body', style)
    const {text} = splitContent(content)
    assert.equal(text, 'body')
    if (style) assert.equal(splitContent(content).style, style)
  }
})

test('isHashTooLong flags a note that will break URLs', () => {
  assert.equal(isHashTooLong('#' + 'a'.repeat(100)), false)
  assert.equal(isHashTooLong('#' + 'a'.repeat(90000)), true)
  assert.equal(isHashTooLong('#' + 'a'.repeat(90000), 500), true)
})

test('a link is called long before it is called too long', async () => {
  const {isHashGettingLong, isHashTooLong} = await import('../../lib/share.js')
  assert.equal(isHashGettingLong('#' + 'a'.repeat(50000)), false)
  assert.equal(isHashGettingLong('#' + 'a'.repeat(65000)), true)
  assert.equal(isHashTooLong('#' + 'a'.repeat(65000)), false)
  assert.equal(isHashTooLong('#' + 'a'.repeat(85000)), true)
})
