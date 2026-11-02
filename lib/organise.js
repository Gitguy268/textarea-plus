// Organise by voice: scattered notes and a spoken update in, a board out.
//
// The reader talks (or types) about where things stand, and the writing model
// sorts that, plus whatever notes they hand it, into topics with tasks, what
// is done and what is still open. The answer is plain markdown in a fixed
// shape, so it is an ordinary note - it syncs, backs up and opens anywhere -
// and lib/board-panel.js draws the same text as cards with a progress bar each.
//
// Everything here is pure: the prompt going in and the parser coming out, so
// both are unit tested without a model. The parser is the forgiving half. A
// 2B model drifts - a `###` for a `##`, `*` for `-`, a bold line for a
// heading - and a board that refuses those would refuse most answers.
//
// This file is shared, byte for byte, by textarea-master, textarea-master-claude
// and Xiao's notes pack. Change it in one and copy it to the others.

/** Characters of notes the prompt carries. The rest is cut, and said so. */
export const ORGANISE_LIMIT = 12_000

const INSTRUCTION =
  'You organise notes. Sort everything the user gives you into topics. ' +
  'Answer in markdown with exactly this shape and nothing else:\n' +
  '## Topic name\n' +
  '- [x] something that is done\n' +
  '- [ ] something still to do\n' +
  '- ? an open question\n' +
  '- a plain fact or note\n\n' +
  'Rules: one "## " line per topic, short topic names, one short line per item. ' +
  'Mark an item [x] only when the user says it is done, finished or already happened. ' +
  'Merge duplicates. Keep the same language as the user. No introduction, no closing remark.'

// One worked example: a 2B model copies a shape far more reliably than it
// follows a description of one.
const EXAMPLE_IN = 'I finished the fence posts, still need soil for the garden. Thesis: outlined chapter two, ' +
  'must email my supervisor, not sure which dataset to use for chapter three.'
const EXAMPLE_OUT =
  '## Garden\n- [x] Fence posts\n- [ ] Buy soil\n\n' +
  '## Thesis\n- [x] Outline chapter two\n- [ ] Email supervisor\n- ? Which dataset for chapter three'

/**
 * The messages for the writing model.
 *
 * @param {string} spoken what the reader just said (or typed); may be empty
 * @param {Array<{title?: string, text: string}>} notes notes to sort along with it
 * @returns {{messages: Array<{role: string, content: string}>, truncated: boolean}}
 */
export function buildOrganisePrompt(spoken, notes = []) {
  let body = ''
  const said = String(spoken ?? '').trim()
  if (said) body += `What I just said:\n${said}\n\n`
  for (const note of notes) {
    const text = String(note?.text ?? '').trim()
    if (!text) continue
    body += `Note${note.title ? ` "${note.title}"` : ''}:\n${text}\n\n`
  }
  const truncated = body.length > ORGANISE_LIMIT
  if (truncated) body = body.slice(0, ORGANISE_LIMIT)
  return {
    truncated,
    messages: [
      {role: 'system', content: INSTRUCTION},
      {role: 'user', content: EXAMPLE_IN},
      {role: 'assistant', content: EXAMPLE_OUT},
      {role: 'user', content: body.trim() || '(nothing)'},
    ],
  }
}

const HEADING = /^\s{0,3}(?:#{1,6}\s+|\*\*(?=.+\*\*\s*:?\s*$))(.+?)(?:\*\*)?\s*:?\s*$/
const ITEM = /^\s*(?:[-*+•]|\d+[.)])\s+(.*)$/
const BOX = /^\[( |x|X)\]\s*(.*)$/

/**
 * Read a board out of markdown.
 *
 * Every heading starts a topic; every list item under it is a task (with a
 * checkbox), a question (starts with `?` or ends with one) or a plain note.
 * Items before any heading land in a topic called "Notes". A `# title` line
 * that has no items under it is a title, not a topic, and is dropped.
 *
 * @param {string} markdown
 * @returns {Array<{topic: string, items: Array<{kind: 'task' | 'question' | 'note',
 *   text: string, done: boolean, line: number}>}>} `line` is the 0-based
 *   line the item came from, so a ticked box can be written back
 */
export function parseBoard(markdown) {
  const topics = []
  let current = null
  const lines = String(markdown ?? '').split('\n')
  lines.forEach((raw, line) => {
    const heading = raw.match(HEADING)
    if (heading && !ITEM.test(raw)) {
      current = {topic: heading[1].replace(/\*\*/g, '').trim(), items: []}
      topics.push(current)
      return
    }
    const item = raw.match(ITEM)
    if (!item) return
    let text = item[1].trim()
    if (!text) return
    let kind = 'note'
    let done = false
    const box = text.match(BOX)
    if (box) {
      kind = 'task'
      done = box[1] !== ' '
      text = box[2].trim()
    } else if (text.startsWith('?')) {
      kind = 'question'
      text = text.slice(1).trim()
    } else if (text.endsWith('?')) {
      kind = 'question'
    }
    if (!text) return
    if (!current) {
      current = {topic: 'Notes', items: []}
      topics.push(current)
    }
    current.items.push({kind, text, done, line})
  })
  return topics.filter((topic) => topic.items.length)
}

/**
 * Done and total tasks of one topic, for its progress bar.
 *
 * @param {{items: Array<{kind: string, done: boolean}>}} topic
 * @returns {{done: number, total: number}}
 */
export function progress(topic) {
  const tasks = topic.items.filter((item) => item.kind === 'task')
  return {done: tasks.filter((item) => item.done).length, total: tasks.length}
}

/**
 * The note with one checkbox flipped, or the note unchanged when that line
 * holds no checkbox (it was edited since the board was drawn).
 *
 * @param {string} markdown
 * @param {number} line 0-based, as parseBoard reported it
 * @param {boolean} done
 * @returns {string}
 */
export function setDone(markdown, line, done) {
  const lines = String(markdown).split('\n')
  const swapped = lines[line]?.replace(/^(\s*(?:[-*+•]|\d+[.)])\s+)\[( |x|X)\]/, `$1[${done ? 'x' : ' '}]`)
  if (swapped === undefined || swapped === lines[line]) return markdown
  lines[line] = swapped
  return lines.join('\n')
}

/**
 * The model's answer as the note that is saved: a dated title over the
 * topics, with anything that is not part of the board shape left out.
 *
 * @param {string} answer
 * @param {Date} [when]
 * @returns {string}
 */
export function boardNote(answer, when = new Date()) {
  const title = `# Organised ${when.toLocaleDateString(undefined, {day: 'numeric', month: 'long', year: 'numeric'})}`
  const topics = parseBoard(answer)
  const body = topics.map(({topic, items}) =>
    [`## ${topic}`, ...items.map(({kind, text, done}) =>
      kind === 'task' ? `- [${done ? 'x' : ' '}] ${text}` : kind === 'question' ? `- ? ${text}` : `- ${text}`)].join('\n'))
  return [title, ...body].join('\n\n') + '\n'
}
