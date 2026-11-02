/**
 * Markdown-ish rendering for the editor.
 *
 * This is upstream's parseMarkdown, moved out of app.js and reshaped so the
 * renderer is a pure function over a string. It returns a tree of nodes; only
 * parseMarkdown() at the bottom touches the document. That split is what makes
 * this testable without a browser.
 *
 * Two rules matter more here than fidelity to CommonMark:
 *
 * - The markers stay in the text. A span holds the source text it replaced, so
 *   article.textContent is byte-identical to the note and the URL keeps
 *   round-tripping. Anything decorative has to come from CSS, which is why a
 *   list bullet is a ::before and not text.
 * - Nothing is generated that the reader did not type, so the offset arithmetic
 *   in the editor's selection handling stays simple.
 */

/** A fenced code block, if one starts on the line at `index`. */
function readFence(text, index) {
  const opening = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(text.slice(index))
  if (!opening) return null

  const marker = opening[1]
  const firstBreak = text.indexOf('\n', index + opening[0].length)
  // An unterminated fence is not a fence. Falling through leaves the backticks
  // as text, which is what they were before this file existed.
  if (firstBreak === -1) return null

  const closing = new RegExp(`^[ \\t]{0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}[ \\t]*$`, 'm')
  const rest = text.slice(firstBreak + 1)
  const end = closing.exec(rest)
  if (!end) return null

  return firstBreak + 1 + end.index + end[0].length
}

/** A bullet or numbered marker at the start of the line at `index`. */
const LIST_ITEM = /^([ \t]*)(?:([-*+])|(\d{1,9})[.)])[ \t]+/

/** Indent width in spaces, counting a tab as two, and a nesting level of 1 to 6. */
function listLevel(indent) {
  return Math.min(Math.floor(indent.replace(/\t/g, '  ').length / 2) + 1, 6)
}

/**
 * Turn a matched domain into a whole mailto: link, completed from the text
 * before it.
 *
 * The matcher only recognises the half after the '@': a local part can begin
 * with any letter, and making every letter stop the scanner would cost a node
 * per character in the note. So the address is completed here. The local part
 * is read back from the line, and the plain-text nodes already emitted for it
 * are trimmed, so the note's text stays byte-identical with one node fewer -
 * which is the same trade the markers make, in reverse. When the local part
 * reaches back into something that is not plain text (a code span, say) there
 * is nothing that can be trimmed without changing the text, and the match is
 * left as text.
 *
 * @param {string} text the line the match sits on
 * @param {number} at the index of the '@'
 * @param {string} raw the matched domain, including the '@'
 * @param {{t: string, v?: string}[]} nodes what has been emitted so far
 */
function pushEmailLink(text, at, raw, nodes) {
  let start = at
  while (start > 0 && /[A-Za-z0-9._%+-]/.test(text[start - 1])) start--
  const local = text.slice(start, at)

  // Without a plausible local part the match is not an address - a bare
  // '@domain', or one glued to a dot - so it stays text.
  if (!local || local.startsWith('.') || local.endsWith('.')) {
    nodes.push({t: 'text', v: raw})
    return
  }

  let remaining = local.length
  const trimmed = []
  while (remaining > 0 && nodes.length > 0) {
    const prev = nodes[nodes.length - 1]
    if (prev.t !== 'text') break
    if (prev.v.length <= remaining) {
      remaining -= prev.v.length
      trimmed.push(nodes.pop())
    } else {
      prev.v = prev.v.slice(0, prev.v.length - remaining)
      remaining = 0
    }
  }

  if (remaining > 0) {
    nodes.push(...trimmed.reverse(), {t: 'text', v: raw})
    return
  }
  nodes.push({t: 'link', h: 'mailto:' + local + raw, v: local + raw})
}

/**
 * Render the inline markers in one line: code, bold, strike, italic, bare URLs,
 * bare email addresses and 'google:' search lines. Headings are included
 * because a heading is a whole line anyway.
 *
 * The matchers are tried in order at each position, and when none of them match
 * the run up to the next character that could start one is emitted as text. That
 * keeps the markers in the output rather than replacing them.
 *
 * `options.fileLinks` adds the `[name](file:id)` token and `options.wikilinks`
 * the `[[Title]]` one. They are switches rather than constants because the
 * features can be turned off: with the switch open the token is only the text
 * the reader typed, which is what makes the settings row the whole of the
 * feature. `options.tags` draws `#tag` the same way.
 *
 * @param {string} text one line of the note
 * @param {{fileLinks?: boolean, wikilinks?: boolean, tags?: boolean}} [options]
 */
function renderInline(text, options) {
  const fileLinks = Boolean(options?.fileLinks)
  const wikilinks = Boolean(options?.wikilinks)
  const matchers = [
    {name: 'md-h1', re: /^#[ \t]+[^\n]*$/my},
    {name: 'md-h2', re: /^##[ \t]+[^\n]*$/my},
    {name: 'md-h3', re: /^###[ \t]+[^\n]*$/my},
    {name: 'md-h4', re: /^####[ \t]+[^\n]*$/my},
    {name: 'md-h5', re: /#####[ \t]+[^\n]*$/my},
    {name: 'md-h6', re: /^######[ \t]+[^\n]*$/my},
    {name: 'md-code', re: /`[^`\n]*`/y},
    {name: 'md-bold', re: /\*\*[^*\n]+?\*\*/y},
    {name: 'md-bold', re: /__[^_\n]+?__/y},
    {name: 'md-strike', re: /~~[^~\n]+?~~/y},
    {name: 'md-italic', re: /\*[^*\n]+?\*/y},
    {name: 'md-italic', re: /_[^_\n]+?_/y},
    {name: 'md-url', re: /https?:\/\/[^\s<>()[\]{}"'`]+/y},
    {name: 'md-email', re: /@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/y},
    {name: 'md-google', re: /google:[^\n]+/y},
  ]

  const specials = ['`', '~', '*', '#', '_', 'h', '@', 'g']
  if (fileLinks || wikilinks || options?.attachments) {
    // '[' opens any of these tokens, so it is a special only while one of them
    // is on at all.
    specials.push('[')
  }
  if (options?.attachments) matchers.push({name: 'md-attachment', re: /\[[^[\]\n]{1,150}\]\(attachments\/[^)\n]{1,200}\)/y})
  if (wikilinks) matchers.push({name: 'md-wiki', re: /\[\[[^[\n]{1,200}?\]\]/y})
  if (fileLinks) matchers.push({name: 'md-file', re: /\[[^[\]\n]{1,150}\]\(file:\d{1,10}\)/y})
  // '#' is a special already, for the headings, which are tried first and
  // need the space a tag never has.
  if (options?.tags) matchers.push({name: 'md-tag', re: TAG})
  const nodes = []
  // The next index of each special, searched forward only and kept until i
  // passes it. Re-running every search from every position is quadratic on a
  // long run without one, and a pasted blob with no marker anywhere in it is
  // exactly that run: seconds to render for a megabyte of it.
  const nearest = new Map()

  let i = 0
  while (i < text.length) {
    let matched = false
    for (const m of matchers) {
      m.re.lastIndex = i
      const res = m.re.exec(text)
      if (!res || res.index !== i) continue

      const raw = res[0]
      if (m.name === 'md-url') nodes.push({t: 'link', h: raw, v: raw})
      else if (m.name === 'md-email') pushEmailLink(text, i, raw, nodes)
      else if (m.name === 'md-google') {
        // The rest of the line is the query, encoded so that spaces and '&'
        // cannot change its meaning. The marker stays in the text like any
        // other, so the note round-trips and the reader can edit the query.
        nodes.push({
          t: 'link',
          h: 'https://www.google.com/search?q=' + encodeURIComponent(raw.slice('google:'.length)),
          v: raw,
        })
      } else if (m.name === 'md-wiki') {
        // The title is the text between the brackets, trimmed of the padding
        // a person leaves around it. Empty brackets are brackets the reader
        // has not filled in yet, so they stay text until there is a title to
        // name - the click half of the feature has nothing to resolve.
        const title = raw.slice(2, -2).trim()
        if (title) nodes.push({t: 'link', wiki: title, v: raw})
        else nodes.push({t: 'text', v: raw})
      } else if (m.name === 'md-file') {
        // Not a URL: there is no address to put in href. The id rides on the
        // element instead, and the click handler resolves it against this
        // browser's own records.
        nodes.push({t: 'link', file: /\(file:(\d+)\)/.exec(raw)[1], v: raw})
      } else if (m.name === 'md-attachment') {
        nodes.push({t: 'link', attachment: raw.slice(raw.indexOf('](') + 2, -1), v: raw})
      } else nodes.push({t: 'span', c: m.name, v: raw})
      i += raw.length
      matched = true
      break
    }
    if (matched) continue

    let next = text.length
    for (const ch of specials) {
      let idx = nearest.get(ch)
      if (idx === undefined || (idx !== -1 && idx < i)) {
        idx = text.indexOf(ch, i)
        nearest.set(ch, idx)
      }
      if (idx !== -1 && idx < next) next = idx
    }

    if (next === i) {
      nodes.push({t: 'text', v: text[i]})
      i++
      continue
    }

    nodes.push({t: 'text', v: text.slice(i, next)})
    i = next
  }

  return nodes
}

/**
 * A tag: `#` at the start of a line or after a space, then a letter, then
 * letters, digits, `_`, `-` and the `/` that nests one tag under another.
 *
 * The space before is what leaves `example.com/#top`, `&#39;` and `C#` alone,
 * and the letter after is what leaves "item #1" alone. Sticky, so the inline
 * walk can try it at one position like every other matcher.
 */
const TAG = /(?<!\S)#\p{L}[\p{L}\p{N}_/-]*/uy

/**
 * Every tag in a note, as the renderer would draw them, lower-cased and
 * without the `#`.
 *
 * The walk goes through renderMarkdown, as tasksIn does, so a `#include` in
 * a fenced block or a `#fff` inside backticks is no more a tag to the
 * library's filter than it is to the note.
 *
 * @param {string} text
 * @returns {string[]} in order of appearance, repeats included
 */
export function tagsIn(text) {
  const source = String(text)
  // The library asks this of every note it holds, on every keystroke of a
  // search, and most notes have nothing a tag could start with: a heading's
  // '#' is followed by a space. Only a note that might have one is walked.
  if (!/(?:^|\s)#\p{L}/u.test(source)) return []
  const found = []
  const walk = (nodes) => {
    for (const node of nodes) {
      if (node.c === 'md-tag') found.push(node.v.slice(1).toLowerCase())
      else if (node.children) walk(node.children)
    }
  }
  walk(renderMarkdown(source, {tags: true}))
  return found
}

/**
 * The text a linked file takes in the note: `[name](file:id)`.
 *
 * This is the other half of the md-file matcher, kept next to it so the shape
 * of the token cannot drift from what the renderer accepts. The name is the
 * reader's own file name, cleaned of the two characters that would end the
 * label early and cut to the length the matcher takes; the id is the record
 * the database handed out.
 *
 * @param {string} name the file's name, shown as the link's text
 * @param {number} id the stored handle's id
 * @returns {string}
 */
export function fileLink(name, id) {
  const label =
    String(name)
      .replace(/[[\]\n\r]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 150) || 'file'
  return `[${label}](file:${Math.trunc(Number(id))})`
}

/**
 * textarea-plus: a line that is nothing but a page link or a picture is drawn
 * as a card or an image. The token stays the text of the element, so the
 * note's text is unchanged; what it shows beyond that comes from attributes
 * through CSS. The two lookups are synchronous answers from what the shell
 * and lib/attachments.js already hold, and an unknown answer is just empty.
 */
function blockOf(line, options) {
  if (options?.wikilinks) {
    const page = /^\[\[([^[\n]{1,200}?)\]\]$/.exec(line)
    const title = page?.[1].trim()
    if (title) return [{t: 'link', wiki: title, v: line, card: true, preview: options.preview?.(title) ?? ''}]
  }
  if (options?.attachments) {
    const image = /^!\[[^\]\n]{0,150}\]\((attachments\/[^)\n]{1,200})\)$/.exec(line)
    if (image) return [{t: 'image', path: image[1], url: options.attachments(image[1]), v: line}]
  }
  return null
}

/**
 * Every `[[title]]` in a string, as the renderer would read them.
 *
 * The same shape as the md-wiki matcher - no '[' and no newline inside,
 * up to 200 characters, the shortest closing ']]' wins - kept next to it
 * so a search that counts links can never count a token the renderer
 * would not draw. Padding around a real title is trimmed, because the
 * trimmed title is what a link resolves to.
 *
 * @param {string} text
 * @returns {string[]} the titles, in order of appearance
 */
export function wikiTitles(text) {
  const titles = []
  for (const match of String(text).matchAll(/\[\[([^[\n]{1,200}?)\]\]/g)) {
    const title = match[1].trim()
    if (title) titles.push(title)
  }
  return titles
}

const TASK_CLASS = {
  ' ': 'md-task',
  x: 'md-task md-task-done',
  X: 'md-task md-task-done',
  '/': 'md-task md-task-doing',
  '-': 'md-task md-task-done md-task-cancelled',
}

/**
 * Every task in a note, as the renderer would draw them.
 *
 * The walk goes through renderMarkdown itself rather than past it with a
 * regular expression of its own, so a line the panel counts as a task is
 * exactly a line the note draws as a checkbox - a bracket in a fenced block,
 * or one later in the line than the marker, can never be counted by one and
 * not the other. The label is the rest of the line as the reader typed it,
 * markers and all, trimmed of the padding around it the way wikiTitles
 * trims a title: the note holds the source, and so does the answer.
 *
 * @param {string} text
 * @returns {{done: boolean, text: string}[]} in order of appearance
 */
export function tasksIn(text) {
  const found = []
  for (const node of renderMarkdown(String(text), {tasks: true})) {
    if (node.t !== 'item') continue
    const at = node.children.findIndex(
      (child) => typeof child.c === 'string' && child.c.split(' ').includes('md-task'),
    )
    if (at === -1) continue
    const bracket = node.children[at]
    found.push({
      // In progress is still open; cancelled is as finished as done.
      done: !' /'.includes(bracket.v[1]),
      text: node.children
        .slice(at + 1)
        .map((child) => child.v)
        .join('')
        .trim(),
    })
  }
  return found
}

/**
 * Render a note to a tree of nodes.
 *
 * The text is walked a line at a time, because a list is the one construct that
 * needs to know where lines begin. Fenced code is picked up first, since it is
 * the only other thing that spans lines.
 *
 * @param {string} text
 * @param {{fileLinks?: boolean, wikilinks?: boolean, tasks?: boolean, tags?: boolean}} [options]
 *   passed through to the inline pass; `tasks` is what draws a bracket after a
 *   marker as a checkbox rather than as text
 */
export function renderMarkdown(text, options) {
  const nodes = []

  let i = 0
  while (i < text.length) {
    const fenced = readFence(text, i)
    if (fenced !== null) {
      nodes.push({t: 'span', c: 'md-codeblock', v: text.slice(i, fenced)})
      i = fenced
      continue
    }

    const break_ = text.indexOf('\n', i)
    const stop = break_ === -1 ? text.length : break_
    const line = text.slice(i, stop)

    const marker = LIST_ITEM.exec(line)
    const rest = marker ? line.slice(marker[0].length) : ''
    // A task is the bracket right after the marker - `- [ ] water` - and
    // only there: the bracket stays in the text like every other marker
    // and is hidden by CSS behind a drawn checkbox, [x] (or [X]) being
    // the ticked state. The switch is the reader's: off, the bracket is
    // only the text it always was, which is what keeps the settings row
    // the whole of the feature.
    const task = marker && options?.tasks ? /^\[( |x|X|\/|-)\](?=[ \t]|$)/.exec(rest) : null
    // A dash is a dash: it opens a task and nothing else, because a line
    // that begins with one is far more often a sentence than a list.
    if (marker && (marker[2] !== '-' || task)) {
      nodes.push({
        t: 'item',
        level: listLevel(marker[1]),
        // A numbered item keeps its own marker: the number is already in the
        // text, so there is nothing to draw and nothing to renumber.
        ordered: marker[3] !== undefined,
        children: [
          {t: 'span', c: 'md-marker', v: marker[0]},
          ...(task
            ? [
                {t: 'span', c: TASK_CLASS[task[1]], v: task[0]},
                ...renderInline(rest.slice(task[0].length), options),
              ]
            : renderInline(rest, options)),
        ],
      })
    } else {
      nodes.push(...(blockOf(line, options) ?? renderInline(line, options)))
    }

    if (break_ === -1) break
    // The newline is a text node like any other, which is what keeps
    // textContent identical to the note. It also guarantees progress on a blank
    // line, where there is nothing else to emit.
    nodes.push({t: 'text', v: '\n'})
    i = break_ + 1
  }

  return nodes
}

/** Build the DOM for one node. */
function toDom(node) {
  if (node.t === 'text') return document.createTextNode(node.v)

  if (node.t === 'link') {
    const a = document.createElement('a')
    a.textContent = node.v
    // A wikilink has no address either: the click resolves the title
    // against this browser's library, so the element carries the title.
    if (node.wiki !== undefined) {
      a.className = node.card ? 'md-wiki md-card' : 'md-wiki'
      a.dataset.wikiTitle = node.wiki
      if (node.card) a.dataset.preview = node.preview
      return a
    }
    if (node.attachment !== undefined) {
      a.className = 'md-attachment'
      a.dataset.attachment = node.attachment
      return a
    }
    if (node.file === undefined) {
      a.className = 'md-url'
      a.href = node.h
      a.target = '_blank'
      a.rel = 'noopener noreferrer'
      return a
    }
    // A link to a file on this computer has no URL to put in an href, so it
    // carries the id instead and the click handler does the resolving.
    a.className = 'md-file'
    a.dataset.fileId = node.file
    return a
  }

  const span = document.createElement('span')
  if (node.t === 'image') {
    span.className = 'md-image'
    span.dataset.attachment = node.path
    if (node.url) span.style.setProperty('--image', `url("${node.url}")`)
    span.textContent = node.v
    return span
  }
  if (node.t === 'item') {
    span.className = `md-li md-li-${node.level}${node.ordered ? ' md-ol' : ''}`
    for (const child of node.children) span.appendChild(toDom(child))
    return span
  }

  span.className = node.c
  span.textContent = node.v
  return span
}

/**
 * Render the note in place, touching only what changed.
 *
 * The article's children are compared with the ones this text asks for, from
 * the top down and from the bottom up, and only the stretch between the two
 * runs of matches is swapped. A keystroke in one paragraph of a long note
 * leaves every other node - its layout, and the selection if the caret is
 * elsewhere - exactly where it was, where the old renderer emptied the
 * article and rebuilt all of it. The result is node for node what a rebuild
 * from nothing would produce: a kept node is one that isEqualNode() says is
 * the node that would have been built.
 *
 * @param {HTMLElement} element the article holding the note
 * @param {{fileLinks?: boolean, wikilinks?: boolean, tasks?: boolean}} [options] see renderMarkdown
 * @param {string} [text] the note to draw; defaults to what the article holds
 */
export function parseMarkdown(element, options, text = element.textContent) {
  const fresh = []
  let pending = ''
  const flush = () => {
    if (!pending) return
    fresh.push(document.createTextNode(pending))
    pending = ''
  }
  for (const node of renderMarkdown(text, options)) {
    // The walk hands text back a run at a time. Joining the runs here, before
    // any node exists, means no two text nodes are ever neighbours, so there
    // is nothing for normalize() to merge afterwards - on a very large note
    // that merge was most of the re-render.
    if (node.t === 'text') pending += node.v
    else {
      flush()
      fresh.push(toDom(node))
    }
  }
  flush()

  let head = 0
  let first = element.firstChild
  // The last node the walk down kept, which is where the walk up must stop:
  // a node cannot be matched from both ends.
  let kept = null
  while (first && head < fresh.length && first.isEqualNode(fresh[head])) {
    kept = first
    first = first.nextSibling
    head++
  }
  // `first` is now the first node that differs, or null: everything matched.
  if (!first && head === fresh.length) return

  let end = fresh.length
  let last = element.lastChild
  let after = null
  while (last !== kept && end > head && last.isEqualNode(fresh[end - 1])) {
    after = last
    last = last.previousSibling
    end--
  }

  // Out with the stretch that differs (first up to, not including, after)...
  while (first && first !== after) {
    const next = first.nextSibling
    first.remove()
    first = next
  }
  // ...and in with the nodes the text asks for there.
  const frag = document.createDocumentFragment()
  for (let i = head; i < end; i++) frag.appendChild(fresh[i])
  element.insertBefore(frag, after)
}
