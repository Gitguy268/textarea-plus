import assert from 'node:assert/strict'
import {test} from 'node:test'

import {attachmentPath, attachmentToken} from '../../lib/attachments.js'
import {buildGraph, layoutGraph} from '../../lib/graph.js'
import {renderMarkdown} from '../../lib/markdown.js'
import {cardPreview} from '../../lib/views.js'

const notes = [
  {id: 'a', text: '# Alpha\n\nsee [[beta]] and [[Beta]] and [[Nobody]] and [[Alpha]]'},
  {id: 'b', text: '# Beta\n\nback to [[Alpha]]'},
  {id: 'c', text: '# Lonely'},
  {id: 'd', text: 'no heading'},
  {id: 'e', text: '# Gone\n\n[[Alpha]]', archived: true},
]

test('links resolve the way a click does, each pair once, no self-links', () => {
  const {nodes, links} = buildGraph(notes)
  assert.deepEqual(links, [{source: 'a', target: 'b'}])
  assert.deepEqual(nodes.map((node) => [node.id, node.degree]), [['a', 1], ['b', 1], ['c', 0]])
})

test('the layout is the same every time and stays inside the box', () => {
  const graph = buildGraph(notes)
  const one = layoutGraph(graph, {width: 400, height: 300})
  assert.deepEqual([...one], [...layoutGraph(graph, {width: 400, height: 300})])
  for (const {x, y} of one.values()) {
    assert.ok(x >= 0 && x <= 400 && y >= 0 && y <= 300, `${x},${y}`)
    assert.ok(Number.isFinite(x) && Number.isFinite(y))
  }
})

test('a page link alone on its line is a card, and the text stays the note', () => {
  const text = 'before [[Inline]]\n[[Alpha]]\n![pic](attachments/a.png)\n[doc](attachments/d.pdf)\n'
  const nodes = renderMarkdown(text, {wikilinks: true, preview: () => 'hello', attachments: () => 'data:x'})
  assert.equal(nodes.map((node) => node.v ?? (node.children ?? []).map((c) => c.v).join('')).join(''), text)
  const card = nodes.find((node) => node.card)
  assert.deepEqual([card.wiki, card.preview], ['Alpha', 'hello'])
  assert.equal(nodes.filter((node) => node.card).length, 1)
  assert.equal(nodes.find((node) => node.t === 'image').url, 'data:x')
  assert.equal(nodes.find((node) => node.attachment)?.attachment, 'attachments/d.pdf')
})

test('with no attachments option the tokens are only text', () => {
  const nodes = renderMarkdown('![pic](attachments/a.png)\n', {})
  assert.ok(nodes.every((node) => node.t === 'text'))
})

test('an attachment keeps its name, cleaned, and numbered when taken', () => {
  const taken = (path) => path === 'attachments/photo.png'
  assert.equal(attachmentPath('photo.png', () => false), 'attachments/photo.png')
  assert.equal(attachmentPath('photo.png', taken), 'attachments/photo 2.png')
  assert.equal(attachmentPath('a(b)/c:d.png', () => false), 'attachments/a b c d.png')
  assert.equal(attachmentPath('', () => false), 'attachments/file')
  assert.equal(attachmentToken('attachments/p.png', 'image/png'), '![p.png](attachments/p.png)')
  assert.equal(attachmentToken('attachments/d.pdf', 'application/pdf'), '[d.pdf](attachments/d.pdf)')
})

test('a card previews the first line that says something', () => {
  assert.equal(cardPreview({text: '# T\n#tag #other\n\nfolder:: X\nthe plan'}), 'the plan')
  assert.equal(cardPreview({text: '# T'}), '')
  assert.equal(cardPreview({text: `# T\n${'x'.repeat(200)}`}).length, 90)
})
