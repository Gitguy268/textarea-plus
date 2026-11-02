// Turning the note's link into a QR code.
//
// The encoder is the vendored qrcode-generator (MIT, see vendor/qr/LICENSE). It
// is loaded with a dynamic import, so a session that only types does not parse
// it. The service worker still precaches it: pairing with a nearby device has
// to work offline, after the local server that served the tab has gone.
//
// What is *not* vendored is the output format. qrcode-generator can emit SVG
// itself, but the markup it produces is built for its own demo page, so the
// module matrix is read here and drawn as one path. That keeps the file small,
// makes the colour follow the page, and means matrixToSvg() is a pure function
// of the matrix and can be unit tested without an encoder.

/** Error correction level. Q survives a quarter of the symbol being damaged. */
export const ERROR_CORRECTION = 'Q'

/**
 * Modules of empty space around the symbol.
 *
 * Four is the minimum the specification allows and what every scanner expects. A
 * tighter margin produces a smaller file that some phone cameras will not lock
 * onto, and a note link is not big enough for the extra modules to matter.
 */
export const QUIET_ZONE = 4

/** Pixel size of one module in the downloaded file. */
export const SCALE = 8

export class QrError extends Error {
  constructor(message, options) {
    super(message, options)
    this.name = 'QrError'
  }
}

/**
 * The encoder, loaded once and then reused.
 *
 * The UTF-8 encoder is installed over the default one before any data is added.
 * The default masks each UTF-16 code unit with `& 0xFF`, which throws on
 * anything above U+00FF, and a link with an accented character or an emoji in its
 * slug would otherwise fail to encode at all.
 *
 * A failed load clears the promise so a later attempt retries rather than
 * replaying the same rejection for the rest of the session.
 */
let encoderPromise = null

function loadEncoder() {
  if (encoderPromise) return encoderPromise

  encoderPromise = Promise.all([
    import('../vendor/qr/qrcode.mjs'),
    import('../vendor/qr/qrcode_UTF8.mjs'),
  ])
    .then(([qrcode, utf8]) => {
      qrcode.default.stringToBytes = utf8.stringToBytes
      return qrcode.default
    })
    .catch((error) => {
      encoderPromise = null
      throw new QrError('The QR encoder could not be loaded.', {cause: error})
    })

  return encoderPromise
}

/**
 * @typedef {object} QrMatrix
 * @property {number} count  modules per side
 * @property {(row: number, column: number) => boolean} isDark
 */

/**
 * Encode text into a QR matrix.
 *
 * @param {string} text
 * @param {object} [options]
 * @param {'L'|'M'|'Q'|'H'} [options.errorCorrection]
 * @returns {Promise<QrMatrix>}
 * @throws {QrError} when the payload does not fit in any symbol
 */
export async function encodeQr(text, {errorCorrection = ERROR_CORRECTION} = {}) {
  const createQrCode = await loadEncoder()

  let code
  try {
    // A type number of 0 means "pick the smallest version that fits", which is
    // what keeps a short link scannable from across a desk.
    code = createQrCode(0, errorCorrection)
    code.addData(String(text ?? ''), 'Byte')
    code.make()
  } catch (error) {
    if (String(error).includes('code length overflow')) {
      throw new QrError(
        'This note is too long for a QR code: the largest symbol holds 2,331 bytes and this link is ' +
          new TextEncoder().encode(String(text ?? '')).length +
          '. Save the note to a file, or share the link as text.',
      )
    }
    throw new QrError('This note could not be turned into a QR code.')
  }

  return {count: code.getModuleCount(), isDark: (row, column) => code.isDark(row, column)}
}

/**
 * Draw a matrix as an SVG document.
 *
 * Each row becomes a path of merged dark runs, which is roughly a fifth of the
 * markup of one rectangle per module. The light background is explicit: a
 * scanner needs a light quiet zone, and on the dark theme a black-on-transparent
 * symbol inverts the whole thing and will not be read.
 *
 * @param {QrMatrix} matrix
 * @param {object} [options]
 * @param {number} [options.scale]    pixels per module in the exported file
 * @param {number} [options.margin]   quiet zone, in modules
 * @param {string} [options.dark]     module colour, or 'currentColor' to follow the page
 * @param {string} [options.light]    background colour
 * @param {string} [options.label]    accessible name for the symbol
 * @returns {string}
 */
export function matrixToSvg(
  matrix,
  {
    scale = SCALE,
    margin = QUIET_ZONE,
    dark = 'currentColor',
    light = '#ffffff',
    label = 'QR code linking to this note',
  } = {},
) {
  const {count, isDark} = matrix
  const side = count + margin * 2
  const pixelSize = side * scale

  const parts = [
    '<svg xmlns="http://www.w3.org/2000/svg"',
    ` viewBox="0 0 ${side} ${side}"`,
    ` width="${pixelSize}"`,
    ` height="${pixelSize}"`,
    ` role="img"`,
    ` aria-label="${escapeAttribute(label)}"`,
    // Without this a browser resamples the symbol on a fractional pixel
    // boundary and blurs the finder patterns, which is where "it scans on my
    // screen but not off the screen" comes from.
    ' shape-rendering="crispEdges">',
  ]

  if (light !== 'none') {
    parts.push(`<rect width="${side}" height="${side}" fill="${escapeAttribute(light)}"/>`)
  }

  let path = ''
  for (let row = 0; row < count; row++) {
    let start = -1
    // One step past the last column closes a run that reaches the edge.
    for (let column = 0; column <= count; column++) {
      const on = column < count && isDark(row, column)
      if (on && start === -1) {
        start = column
      } else if (!on && start !== -1) {
        const x = start + margin
        const width = column - start
        path += `M${x} ${row + margin}h${width}v1h-${width}z`
        start = -1
      }
    }
  }
  parts.push(`<path fill="${escapeAttribute(dark)}" d="${path}"/>`)
  parts.push('</svg>')

  return parts.join('')
}

/** Encode and draw in one call. */
export async function qrSvg(text, options = {}) {
  return matrixToSvg(await encodeQr(text, options), options)
}

function escapeAttribute(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
}
