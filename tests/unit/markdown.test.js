import assert from 'node:assert/strict'
import {test} from 'node:test'

import {fileLink, renderMarkdown, tagsIn, tasksIn} from '../../lib/markdown.js'

/** Concatenate the source text a tree carries, which must be the input back. */
function sourceOf(nodes) {
  return nodes
    .map((node) => {
      if (node.t === 'item') return sourceOf(node.children)
      return node.v
    })
    .join('')
}

/** Every span class in the tree, in order. */
function classes(nodes) {
  const out = []
  for (const node of nodes) {
    if (node.t === 'item') out.push(node.children[0].c, ...classes(node.children.slice(1)))
    else if (node.t !== 'text') out.push(node.c)
  }
  return out
}

const items = (nodes) => nodes.filter((node) => node.t === 'item')

test('the rendered tree carries the note back unchanged', () => {
  const notes = [
    '',
    'plain text',
    'trailing newline\n',
    '# Title\n\nA line with **bold**, *italic*, ~~strike~~, `code` and https://example.com/a?b=c.',
    '## Sub\n\n```\nfenced block\n```\n\nafter',
    'Text with a * lone star and a - dash and 1. number',
    '* one\n* two\n  * nested\n    1. deep',
    'a\n\n\nb',
    '*unspaced is not a list',
    '- ',
    'mail jane.doe@example.com, cc a@b.c and `code@x.y` back',
    'google:textarea word wrap and google:cats',
  ]

  for (const note of notes) {
    assert.equal(sourceOf(renderMarkdown(note)), note, `round trip for ${JSON.stringify(note)}`)
  }
})

test('headings, emphasis and links are unchanged from upstream', () => {
  assert.deepEqual(renderMarkdown('# Title'), [{t: 'span', c: 'md-h1', v: '# Title'}])
  assert.deepEqual(renderMarkdown('### Deep'), [{t: 'span', c: 'md-h3', v: '### Deep'}])
  assert.deepEqual(renderMarkdown('#### Deeper'), [{t: 'span', c: 'md-h4', v: '#### Deeper'}])
  assert.deepEqual(renderMarkdown('##### Deepest'), [{t: 'span', c: 'md-h5', v: '##### Deepest'}])

  assert.deepEqual(renderMarkdown('**bold**'), [{t: 'span', c: 'md-bold', v: '**bold**'}])
  assert.deepEqual(renderMarkdown('__bold__'), [{t: 'span', c: 'md-bold', v: '__bold__'}])
  assert.deepEqual(renderMarkdown('~~gone~~'), [{t: 'span', c: 'md-strike', v: '~~gone~~'}])
  assert.deepEqual(renderMarkdown('`code`'), [{t: 'span', c: 'md-code', v: '`code`'}])

  // A hash without a space is not a heading, which was true before this file.
  // The text comes back in two pieces because '#' is a character the scanner
  // stops at, exactly as it did upstream.
  assert.deepEqual(
    renderMarkdown('#nope'),
    [
      {t: 'text', v: '#'},
      {t: 'text', v: 'nope'},
    ],
  )
  assert.ok(!classes(renderMarkdown('#nope')).some((c) => c.startsWith('md-h')))
  assert.deepEqual(renderMarkdown('## Sub'), [{t: 'span', c: 'md-h2', v: '## Sub'}])

  assert.deepEqual(renderMarkdown('https://example.com/a?b=c'), [
    {t: 'link', h: 'https://example.com/a?b=c', v: 'https://example.com/a?b=c'},
  ])
  assert.deepEqual(renderMarkdown('```\ncode\n```'), [
    {t: 'span', c: 'md-codeblock', v: '```\ncode\n```'},
  ])
  // An unterminated fence is not a fence, so the backticks fall through to the
  // inline code matcher and get eaten as a pair. Upstream did the same, since its
  // fenced matcher never matched either.
  assert.deepEqual(renderMarkdown('```\ncode'), [
    {t: 'span', c: 'md-code', v: '``'},
    {t: 'text', v: '`'},
    {t: 'text', v: '\n'},
    {t: 'text', v: 'code'},
  ])
})

test('email addresses become mail links', () => {
  // The local part is trimmed back out of the text runs the scanner emitted
  // for it, so the address appears exactly once in the note's text.
  assert.deepEqual(renderMarkdown('mail jane.doe@example.com now'), [
    {t: 'text', v: 'mail '},
    {t: 'link', h: 'mailto:jane.doe@example.com', v: 'jane.doe@example.com'},
    {t: 'text', v: ' now'},
  ])

  assert.deepEqual(renderMarkdown('jane@example.org'), [
    {t: 'link', h: 'mailto:jane@example.org', v: 'jane@example.org'},
  ])

  // The local part reaching back through a code span cannot be trimmed without
  // changing the text, so the domain half stays text instead of duplicating it.
  assert.deepEqual(renderMarkdown('`x`@example.org'), [
    {t: 'span', c: 'md-code', v: '`x`'},
    {t: 'text', v: '@example.org'},
  ])
})

test('almost-addresses stay text', () => {
  const notes = [
    'a@b.c', // one-letter TLD
    'foo@bar', // no dot at all
    '@example.org', // no local part
    '.jane@example.org', // leading dot
    'jane.@example.org', // trailing dot
  ]
  for (const note of notes) {
    assert.ok(
      !renderMarkdown(note).some((node) => node.t === 'link'),
      `${JSON.stringify(note)} should not become a link`,
    )
    assert.equal(sourceOf(renderMarkdown(note)), note)
  }
})

test('google: makes the rest of the line a search link', () => {
  assert.deepEqual(renderMarkdown('google:textarea word wrap'), [
    {
      t: 'link',
      h: 'https://www.google.com/search?q=textarea%20word%20wrap',
      v: 'google:textarea word wrap',
    },
  ])

  // Mid-line it starts at the marker, the way a bare URL starts at its scheme.
  assert.deepEqual(renderMarkdown('try google:cats now'), [
    {t: 'text', v: 'try '},
    {t: 'link', h: 'https://www.google.com/search?q=cats%20now', v: 'google:cats now'},
  ])

  // Nothing after the marker is nothing to search for.
  assert.ok(!renderMarkdown('google:').some((node) => node.t === 'link'))
  // Like http://, the marker is lowercase. And a query with characters that
  // would change the URL's meaning arrives encoded.
  assert.ok(!renderMarkdown('Google:cats').some((node) => node.t === 'link'))
  assert.deepEqual(renderMarkdown('google:a&b=c'), [
    {
      t: 'link',
      h: 'https://www.google.com/search?q=a%26b%3Dc',
      v: 'google:a&b=c',
    },
  ])
})

test('file links render only while the feature is on', () => {
  const token = '[budget notes](file:3)'

  assert.deepEqual(renderMarkdown(token, {fileLinks: true}), [{t: 'link', file: '3', v: token}])
  // The token is the reader's own text first: with the switch off it is
  // exactly what was typed, which is also what makes the toggle reversible.
  // The runs may be split where the scanner stops, so this is asserted as
  // "no link, text intact" rather than as one node.
  const off = renderMarkdown(token)
  assert.ok(!off.some((node) => node.t === 'link'), 'the token is not a link while the switch is off')
  assert.equal(sourceOf(off), token)

  // The whole token matches at the '[', so an underscore inside the label
  // does not drag emphasis into it, and the text still round-trips.
  const label = '[a_b c](file:42)'
  assert.deepEqual(renderMarkdown(label, {fileLinks: true}), [
    {t: 'link', file: '42', v: label},
  ])
  assert.equal(sourceOf(renderMarkdown(label, {fileLinks: true})), label)

  // Almost a token: without digits for an id there is nothing to resolve.
  const nearMisses = ['[x](file:abc)', '[x](file:)', '[x](file:123456789012345)']
  for (const note of nearMisses) {
    assert.ok(
      !renderMarkdown(note, {fileLinks: true}).some((node) => node.t === 'link'),
      `${JSON.stringify(note)} should not become a link`,
    )
  }
})

test('wikilinks render only while the feature is on', () => {
  const token = '[[Quarterly review]]'

  assert.deepEqual(renderMarkdown(`see ${token}`, {wikilinks: true}), [
    {t: 'text', v: 'see '},
    {t: 'link', wiki: 'Quarterly review', v: token},
  ])
  // textarea-plus: alone on its line, the same link is a card.
  assert.deepEqual(renderMarkdown(token, {wikilinks: true}), [
    {t: 'link', wiki: 'Quarterly review', v: token, card: true, preview: ''},
  ])

  // The brackets are the reader's own text first: with the switch off they
  // are exactly what was typed, which is also what makes the toggle
  // reversible. The runs may split where the scanner stops, so this is
  // asserted as "no link, text intact" rather than as one node.
  const off = renderMarkdown(token)
  assert.ok(!off.some((node) => node.t === 'link'), 'not a link while the switch is off')
  assert.equal(sourceOf(off), token)

  // File links on, wikilinks off: '[' is a special because one token needs
  // it, and the other token still does not appear.
  const fileOnly = renderMarkdown(token, {fileLinks: true})
  assert.ok(!fileOnly.some((node) => node.t === 'link'), 'file links do not switch wikilinks on')
  assert.equal(sourceOf(fileOnly), token)

  // The whole token matches at the '[', so an underscore inside the title
  // does not drag emphasis into it, and the text still round-trips.
  const underscored = '[[a_b c]]'
  assert.deepEqual(renderMarkdown(underscored, {wikilinks: true}), [
    {t: 'link', wiki: 'a_b c', v: underscored, card: true, preview: ''},
  ])
  assert.equal(sourceOf(renderMarkdown(underscored, {wikilinks: true})), underscored)
})

test('a wikilink needs a title, both brackets and one line', () => {
  const nearMisses = [
    '[[]]', // nothing between the brackets
    '[[   ]]', // nothing between them, however it is padded
    '[[unterminated]', // one bracket short
    '[[two\nlines]]', // a title does not run over a line
    `[[${'x'.repeat(201)}]]`, // longer than the matcher takes
  ]
  for (const note of nearMisses) {
    const nodes = renderMarkdown(note, {wikilinks: true})
    assert.ok(
      !nodes.some((node) => node.t === 'link'),
      `${JSON.stringify(note)} should not become a link`,
    )
    assert.equal(sourceOf(nodes), note)
  }

  // Padding around a real title is trimmed away - that trimmed title is
  // what the click half resolves - and two on one line are two links.
  assert.deepEqual(renderMarkdown('see [[ Alpha ]] now', {wikilinks: true}), [
    {t: 'text', v: 'see '},
    {t: 'link', wiki: 'Alpha', v: '[[ Alpha ]]'},
    {t: 'text', v: ' now'},
  ])
})

test('fileLink builds the token the renderer reads back', () => {
  const token = fileLink('quarterly [draft].txt', 7)
  assert.equal(token, '[quarterly draft.txt](file:7)')
  assert.deepEqual(renderMarkdown(token, {fileLinks: true}), [
    {t: 'link', file: '7', v: token},
  ])

  // Characters that would end the label early are replaced rather than
  // trusted, and a name longer than the matcher takes is cut to fit - both
  // so the token the app writes is always a token it can read.
  const long = fileLink(`x`.repeat(300) + ']\n[', 8)
  assert.ok(long.length <= `[${'x'.repeat(150)}](file:8)`.length, `too long: ${long.length}`)
  const nodes = renderMarkdown(long, {fileLinks: true})
  assert.equal(nodes.length, 1, 'a long name still parses as one token')
  assert.equal(nodes[0].file, '8')
  assert.equal(sourceOf(nodes), long)
})


test('bullets become list items and keep their marker', () => {
  const nodes = renderMarkdown('* one\n+ three')
  const list = items(nodes)

  assert.equal(list.length, 2)
  assert.deepEqual(
    list.map((node) => node.level),
    [1, 1],
  )
  assert.deepEqual(
    list.map((node) => node.children[0].v),
    ['* ', '+ '],
  )
  assert.ok(list.every((node) => !node.ordered))
  // The marker is hidden by CSS, so it is wrapped separately from the body.
  assert.ok(classes(nodes).includes('md-marker'))
})

test('indentation sets the nesting level', () => {
  // Two spaces a level, so eight spaces is the fifth level rather than the
  // fourth: 8 / 2 + 1.
  const nodes = renderMarkdown('* one\n  * two\n    * three\n        * four')
  assert.deepEqual(
    items(nodes).map((node) => node.level),
    [1, 2, 3, 5],
  )

  // A tab counts as two spaces, and the level stops at six.
  const tabs = items(renderMarkdown('*\tone\n\t* two'))
  assert.deepEqual(
    tabs.map((node) => node.level),
    [1, 2],
  )

  const deep = items(renderMarkdown('              * deep'))
  assert.equal(deep[0].level, 6)
})

test('numbered items are told apart from bullets', () => {
  const nodes = renderMarkdown('1. first\n2) second')
  const list = items(nodes)

  assert.equal(list.length, 2)
  assert.ok(list.every((node) => node.ordered))
  // The marker is left visible, since the number is already the note's own text.
  assert.deepEqual(
    list.map((node) => node.children[0].v),
    ['1. ', '2) '],
  )
})

test('emphasis still works inside a list item', () => {
  const nodes = renderMarkdown('* a **bold** item')
  const list = items(nodes)

  assert.equal(list.length, 1)
  assert.deepEqual(classes(list[0].children), ['md-marker', 'md-bold'])
})

test('a list and a fenced block do not fight each other', () => {
  const nodes = renderMarkdown('* one\n```\nraw * not emphasis\n```\n* two')
  const list = items(nodes)

  assert.equal(list.length, 2)
  assert.ok(!classes(nodes).includes('md-italic'), 'the fence content stays literal')
  assert.ok(classes(nodes).includes('md-codeblock'))
})

test('a marker needs a space after it to count', () => {
  // Upstream had no list support at all, so these were all plain text.
  assert.equal(items(renderMarkdown('*no space')).length, 0)
  assert.equal(items(renderMarkdown('-no space')).length, 0)
  assert.equal(items(renderMarkdown('1.no space')).length, 0)
  assert.equal(items(renderMarkdown('2 * 3 is maths')).length, 0)
})

test('a dash is only a dash unless a task follows it', () => {
  const plain = renderMarkdown('- two\n  - nested', {tasks: true})
  assert.equal(items(plain).length, 0, 'no bullet is drawn for a dash')
  assert.equal(sourceOf(plain), '- two\n  - nested')
  assert.equal(items(renderMarkdown('- [ ] water', {tasks: true})).length, 1, 'a task still is an item')
  assert.equal(items(renderMarkdown('* still a bullet', {tasks: true})).length, 1)
})

test('a bullet in the middle of a line is left alone', () => {
  const nodes = renderMarkdown('remember to buy * milk')
  assert.equal(items(nodes).length, 0)
})

test('a bracket after a marker draws as a checkbox when the reader asks', () => {
  const nodes = renderMarkdown('- [ ] water', {tasks: true})
  const [item] = items(nodes)

  assert.equal(item.children[0].c, 'md-marker')
  assert.equal(item.children[1].c, 'md-task')
  assert.equal(item.children[1].v, '[ ]')
  // The label after the bracket stays ordinary inline text.
  assert.equal(item.children[2].v, ' water')
  assert.equal(sourceOf(nodes), '- [ ] water')
})

test('[x] and [X] are the ticked state, however it was typed', () => {
  const nodes = renderMarkdown('- [x] done\n* [X] also', {tasks: true})
  const [first, second] = items(nodes)

  assert.ok(first.children[1].c.split(' ').includes('md-task-done'))
  assert.ok(second.children[1].c.split(' ').includes('md-task-done'))
  assert.ok(
    classes(nodes).some((c) => c.split(' ').includes('md-task')),
    'the box is drawn for both',
  )
})

test('the bracket is only a bracket until the switch is thrown', () => {
  // Off - the default - a dash line is plain text and a starred one the
  // list it always was: no checkbox anywhere, and the text untouched.
  const nodes = renderMarkdown('- [ ] water\n* [ ] wine')
  assert.ok(!classes(nodes).some((c) => c.includes('md-task')))
  assert.equal(items(nodes).length, 1)
  assert.equal(sourceOf(nodes), '- [ ] water\n* [ ] wine')
})

test('only a bracket straight after the marker counts as a task', () => {
  const drawn = (note) => classes(renderMarkdown(note, {tasks: true})).includes('md-task')

  assert.ok(!drawn('- [ ]water'), 'the bracket needs a space after it or the end of the line')
  assert.ok(!drawn('- water [ ] later'), 'the bracket has to come first')
  assert.ok(!drawn('- [y] maybe'), 'only space, x and X say anything')
  assert.ok(!drawn('```\n- [ ] inside a fence\n```'), 'a bracket in code is code')
  assert.ok(drawn('- [ ] at the end of the line'), 'the end of the line is enough')
  assert.ok(drawn('-  [ ] after the marker\u2019s own spaces'), 'the marker eats its trailing spaces')
  assert.ok(drawn('1. [ ] numbered too'), 'a numbered item is a list item like any other')
  assert.ok(drawn('  - [ ] nested'), 'nesting changes the level, not the task')
})

test('the round trip holds with the checkbox drawn', () => {
  const notes = [
    '- [ ] water\n- [x] done',
    '- [ ]',
    '  - [ ] nested\n1. [ ] ordered',
    '```\n- [ ] fenced\n```',
  ]

  for (const note of notes) {
    assert.equal(
      sourceOf(renderMarkdown(note, {tasks: true})),
      note,
      `round trip for ${JSON.stringify(note)}`,
    )
  }
})

test('tasksIn reads the tree the note is drawn from', () => {
  assert.deepEqual(tasksIn('- [ ] alpha\n- [x] baked'), [
    {done: false, text: 'alpha'},
    {done: true, text: 'baked'},
  ])
  assert.deepEqual(tasksIn('nothing to do\n- still nothing'), [])
  assert.deepEqual(tasksIn('```\n- [ ] inside a fence\n```'), [], 'a fence holds no tasks')
  // The label is the source, markers and all - the note holds them, so the
  // answer holds them, and the padding around the line is trimmed.
  assert.deepEqual(tasksIn('- [ ] buy **milk**'), [{done: false, text: 'buy **milk**'}])
  assert.deepEqual(tasksIn('  - [ ] nested\n1. [ ] ordered'), [
    {done: false, text: 'nested'},
    {done: false, text: 'ordered'},
  ])
  assert.deepEqual(tasksIn('- [ ]'), [{done: false, text: ''}], 'a task with no words still counts')
})

test('a tag is a # after a space with a letter behind it, and nothing else is', () => {
  const tags = (text) =>
    renderMarkdown(text, {tags: true})
      .flatMap((node) => (node.t === 'item' ? node.children : [node]))
      .filter((node) => node.c === 'md-tag')
      .map((node) => node.v)

  assert.deepEqual(tags('#home at the start, #work/taxes inside, and #ünï_1-x.'), ['#home', '#work/taxes', '#ünï_1-x'])
  assert.deepEqual(tags('* #listed in an item'), ['#listed'])
  // A heading is a heading, to its last character.
  assert.deepEqual(tags('# Title #not\n## Sub'), [])
  assert.deepEqual(tags('item #1, C#, a#b, &#39; and https://example.com/#top'), [])
  assert.deepEqual(tags('`#code` and\n```\n#include <stdio.h>\n```'), [])
})

test('a tag is only text until the switch is thrown, and the note comes back either way', () => {
  const note = '# Title\n\n#home and #work/taxes\n* #listed\n`#code`'
  assert.ok(!classes(renderMarkdown(note)).includes('md-tag'))
  assert.ok(classes(renderMarkdown(note, {tags: true})).includes('md-tag'))
  assert.equal(sourceOf(renderMarkdown(note)), note)
  assert.equal(sourceOf(renderMarkdown(note, {tags: true})), note)
})

test('tagsIn reads the tree the note is drawn from', () => {
  assert.deepEqual(tagsIn('# T #no\n#Home, #home and #work/Taxes\n- [ ] #todo\n`#code` item #1'), [
    'home',
    'home',
    'work/taxes',
    'todo',
  ])
  assert.deepEqual(tagsIn('nothing to find'), [])
  assert.deepEqual(tagsIn(undefined), [])
})
