// The URL hash: how a note is encoded into the address bar, and how a note can
// be encrypted there.
//
// The plain format is the upstream one and is kept byte for byte compatible, so
// links that already exist keep working:
//
//   #<base64url(deflate-raw(text [+ "\0" + style]))>
//
// An encrypted note looks different, and unambiguously so, because '!' is not in
// the base64url alphabet:
//
//   #!<base64url(header + AES-GCM ciphertext)>
//
// Encryption is AES-256-GCM with the key derived from the password by
// PBKDF2-HMAC-SHA256. GCM is authenticated, so a wrong password or a tampered
// link fails loudly instead of yielding garbage.

const MAGIC = new Uint8Array([0x54, 0x58, 0x45, 0x31]) // "TXE1"
const SALT_LENGTH = 16
const IV_LENGTH = 12
const TAG_LENGTH = 16
const KEY_BITS = 256 // Web Crypto counts key length in bits, not bytes
const DEFAULT_ITERATIONS = 210_000 // OWASP guidance for PBKDF2-HMAC-SHA256
const MAX_ITERATIONS = 5_000_000 // a hostile link must not be able to hang the tab
// Deflate runs at better than 1000:1 on repetitive text, so a hash the browser
// will happily hold can expand into hundreds of megabytes. No note needs this
// much, and the tab should not die finding out.
const MAX_INFLATED_BYTES = 64 * 1024 * 1024

/** Marker for an encrypted hash. Not a valid base64url character. */
export const ENCRYPTED_PREFIX = '!'

export class DecryptError extends Error {
  constructor(message) {
    super(message)
    this.name = 'DecryptError'
  }
}

/* ---------------------------------------------------------------- encoding */

export function toBase64Url(bytes) {
  const encoded =
    typeof bytes.toBase64 === 'function'
      ? bytes.toBase64({alphabet: 'base64url'})
      : btoa(bytesToBinary(bytes))
  // The native encoder pads and the fallback does not. Padding is optional when
  // decoding, so dropping it keeps one browser from rewriting another browser's
  // hash for the same note. Links made by upstream still decode.
  return encoded.replace(/=+$/, '')
}

function bytesToBinary(bytes) {
  let binary = ''
  // Chunked: spreading a large array into fromCharCode overflows the stack.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return binary
}

export function fromBase64Url(text) {
  if (typeof Uint8Array.fromBase64 === 'function') {
    return Uint8Array.fromBase64(text, {alphabet: 'base64url'})
  }
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/**
 * Pump bytes through a compression or decompression stream.
 *
 * The writes are awaited rather than fired off: a rejected write would otherwise
 * surface as an unhandled rejection while the read on the other side simply
 * hung, which is a miserable way to find out the hash codec is broken. When the
 * read side fails — which is what the inflation limit below does — both
 * promises fail, so the read is consumed in the catch to leave one rejection
 * rather than two.
 */
async function pump(bytes, {writable, readable}) {
  const writer = writable.getWriter()
  const result = new Response(readable).arrayBuffer()
  try {
    await writer.write(bytes)
    await writer.close()
  } catch (error) {
    await result.catch(() => {})
    throw error
  }
  return new Uint8Array(await result)
}

const deflate = (bytes) => pump(bytes, new CompressionStream('deflate-raw'))

/**
 * Decompress, refusing to emit more than MAX_INFLATED_BYTES.
 *
 * Counting the output stream rather than trusting anything in the input is the
 * only part that is authoritative: the compressed size says nothing about how
 * big the note will be.
 */
function inflate(bytes) {
  const decompressor = new DecompressionStream('deflate-raw')
  let total = 0
  const limited = decompressor.readable.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        total += chunk.byteLength
        if (total > MAX_INFLATED_BYTES) {
          throw new Error('This link expands to too much text to open.')
        }
        controller.enqueue(chunk)
      },
    }),
  )
  return pump(bytes, {writable: decompressor.writable, readable: limited})
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** Note -> hash, without the leading '#'. */
export async function encodeHash(content) {
  return toBase64Url(await deflate(encoder.encode(content)))
}

/** Hash without the leading '#' -> note, for an unencrypted hash. */
export async function decodeHash(hash) {
  return decoder.decode(await inflate(fromBase64Url(hash)))
}

/* -------------------------------------------------------------- encryption */

function concat(...parts) {
  let length = 0
  for (const part of parts) length += part.length
  const out = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

async function deriveKey(password, salt, iterations) {
  if (!globalThis.crypto?.subtle) {
    throw new Error('This browser cannot encrypt: the Web Crypto API is unavailable.')
  }
  const material = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password.normalize('NFC')),
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    {name: 'PBKDF2', salt, iterations, hash: 'SHA-256'},
    material,
    {name: 'AES-GCM', length: KEY_BITS},
    false,
    ['encrypt', 'decrypt'],
  )
}

/**
 * Encrypt a note into a hash payload.
 *
 * @param {string} content  text, optionally with the "\0" + style suffix
 * @param {string} password
 * @returns {Promise<string>} payload without the '#!' prefix
 */
export async function encryptHash(content, password) {
  const iterations = DEFAULT_ITERATIONS
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH))
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH))
  const key = await deriveKey(password, salt, iterations)

  const header = new Uint8Array(MAGIC.length + SALT_LENGTH + IV_LENGTH + 4)
  header.set(MAGIC, 0)
  header.set(salt, MAGIC.length)
  header.set(iv, MAGIC.length + SALT_LENGTH)
  new DataView(header.buffer).setUint32(MAGIC.length + SALT_LENGTH + IV_LENGTH, iterations)

  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({name: 'AES-GCM', iv}, key, encoder.encode(content)),
  )

  return toBase64Url(concat(header, ciphertext))
}

/**
 * Decrypt a hash payload.
 *
 * @throws {DecryptError} on a wrong password, a truncated link or a tampered one
 */
export async function decryptHash(payload, password) {
  let bytes
  try {
    bytes = fromBase64Url(payload)
  } catch {
    throw new DecryptError('This link is not readable.')
  }

  const headerLength = MAGIC.length + SALT_LENGTH + IV_LENGTH + 4
  if (bytes.length < headerLength + TAG_LENGTH) throw new DecryptError('This link is truncated.')

  for (let i = 0; i < MAGIC.length; i++) {
    if (bytes[i] !== MAGIC[i]) throw new DecryptError('This link uses an unknown format.')
  }

  const salt = bytes.subarray(MAGIC.length, MAGIC.length + SALT_LENGTH)
  const iv = bytes.subarray(MAGIC.length + SALT_LENGTH, MAGIC.length + SALT_LENGTH + IV_LENGTH)
  const iterations = new DataView(
    bytes.buffer,
    bytes.byteOffset + MAGIC.length + SALT_LENGTH + IV_LENGTH,
    4,
  ).getUint32(0)

  if (iterations < 1000 || iterations > MAX_ITERATIONS) {
    throw new DecryptError('This link asks for an implausible amount of work.')
  }

  const key = await deriveKey(password, salt, iterations)
  try {
    return decoder.decode(
      await crypto.subtle.decrypt(
        {name: 'AES-GCM', iv},
        key,
        bytes.subarray(headerLength),
      ),
    )
  } catch {
    // GCM cannot distinguish a wrong password from a modified ciphertext, and
    // saying which would be a small oracle.
    throw new DecryptError('Wrong password, or this link has been altered.')
  }
}

export function isEncryptedHash(hash) {
  return hash.startsWith(ENCRYPTED_PREFIX)
}

/**
 * Split a stored note into its text and style halves.
 *
 * The separator is a NUL byte, which cannot appear in the text itself because
 * the editor works in plain text.
 */
export function splitContent(content) {
  const index = content.indexOf('\x00')
  if (index === -1) return {text: content, style: null}
  return {text: content.slice(0, index), style: content.slice(index + 1) || null}
}

export function joinContent(text, style) {
  return style ? text + '\x00' + style : text
}

/**
 * Rough size of the note as it will appear in the URL. Browsers start refusing
 * very long URLs, and a note imported from a PDF can get there quickly.
 */
export function isHashTooLong(hash, limit = 80000) {
  return hash.length > limit
}

/**
 * The same question asked a little earlier: past three quarters of the limit
 * the reader is told the link is getting long, while it still works
 * everywhere and there is still time to move the note into a file.
 */
export function isHashGettingLong(hash, limit = 80000) {
  return hash.length > limit * 0.75
}
