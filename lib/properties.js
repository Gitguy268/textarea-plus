// A note's properties: `key:: value` lines of its own text, the form Obsidian
// reads too. Nothing is kept beside the note, so a value edited in a table and
// a value typed by hand are the same line, and every app reading the folder
// sees it. Lines inside a code fence are code and do not count.
//
// Pure: text in, text out, every other line left as it was.

const LINE = /^(\p{L}[\p{L}\p{N} _-]{0,39})::(?:[ \t]+(.*))?$/u
const FENCE = /^(?:```|~~~)/

/** A name a property may have. */
export const validKey = (key) => LINE.test(`${String(key).trim()}::`)

/** The property lines of a note, with where each one stands. */
function propertyLines(text) {
  const found = []
  let fenced = false
  let start = 0
  for (const line of text.split('\n')) {
    const end = start + line.length
    if (FENCE.test(line)) fenced = !fenced
    else if (!fenced) {
      const match = LINE.exec(line)
      if (match) found.push({key: match[1], value: (match[2] ?? '').trim(), start, end})
    }
    start = end + 1
  }
  return found
}

/**
 * @param {string} text
 * @returns {Map<string, string>} by lowercase name; the first line of a name wins
 */
export function propertiesOf(text) {
  const properties = new Map()
  const source = String(text ?? '')
  if (!source.includes('::')) return properties
  for (const {key, value} of propertyLines(source)) {
    const name = key.toLowerCase()
    if (!properties.has(name)) properties.set(name, value)
  }
  return properties
}

/**
 * The note's text with one property set: the line rewritten where it stands in
 * its own spelling, added at the end when it is new, and taken out when the
 * value is empty.
 *
 * @param {string} text
 * @param {string} key
 * @param {string} value
 */
export function setProperty(text, key, value) {
  const clean = String(value ?? '').replace(/[\r\n]+/g, ' ').trim()
  const name = key.toLowerCase()
  const line = propertyLines(text).find((candidate) => candidate.key.toLowerCase() === name)
  if (line) {
    if (clean) return `${text.slice(0, line.start)}${line.key}:: ${clean}${text.slice(line.end)}`
    return `${text.slice(0, line.start)}${text.slice(line.end + 1)}`.replace(/\n+$/, '\n')
  }
  if (!clean) return text
  const body = text.replace(/\n*$/, '')
  if (!body) return `${key}:: ${clean}\n`
  // Properties written one after another stay one block.
  const gap = LINE.test(body.slice(body.lastIndexOf('\n') + 1)) ? '\n' : '\n\n'
  return `${body}${gap}${key}:: ${clean}\n`
}
