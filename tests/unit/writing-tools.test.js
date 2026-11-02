// The prompt half of the writing tools: what actually gets sent to the
// model that ships in models/.
//
// The panel itself is exercised in the browser through an injected engine;
// what is checked here is everything the engine is a stranger to - which
// tools exist, what each one asks for, where the note text lands, how the
// reader's extra instructions ride along, and the cut that keeps a pasted
// novel out of a 270M model's context.

import assert from 'node:assert/strict'
import {test} from 'node:test'

import {buildPrompt, MODELS, NOTE_LIMIT, TOOLS} from '../../lib/writing-tools.js'
import {MODELS as ENGINES} from '../../lib/gemma.js'

test('the tool shelf is stable: unique ids, a label and an instruction each', () => {
  const ids = TOOLS.map((tool) => tool.id)
  assert.deepEqual([...new Set(ids)], ids, 'ids are unique')

  for (const tool of TOOLS) {
    assert.ok(tool.label.trim(), `${tool.id} has a label`)
    assert.ok(tool.instruction.trim().length > 20, `${tool.id} has an instruction`)
    // The line that stops the model translating the reader's prose into
    // English on the way out rides on every tool that rewrites text.
    if (tool.id !== 'fix' && !tool.image) {
      assert.match(tool.instruction, /same language/i, `${tool.id} keeps the language`)
    }
  }
})

test('a prompt is system-then-user, with the tool’s job and the text in place', () => {
  const {messages, truncated} = buildPrompt('improve', 'Old sentence.')

  assert.equal(truncated, false)
  assert.deepEqual(
    messages.map((message) => message.role),
    ['system', 'user'],
  )

  const tool = TOOLS.find((candidate) => candidate.id === 'improve')
  assert.ok(
    messages[0].content.startsWith(tool.instruction),
    'the system message opens with the chosen tool’s instruction',
  )
  // The output contract: the text itself, not a commentary on it.
  assert.match(messages[0].content, /finished text only/)
  assert.ok(messages[1].content.includes('Old sentence.'), 'the note text is in the prompt')
})

test('the reader’s extra instructions are appended, or absent when there are none', () => {
  const withInstructions = buildPrompt('shorten', 'Body text.', 'Use British English.')
  assert.match(withInstructions.messages[1].content, /Extra instructions: Use British English\./)
  assert.ok(
    withInstructions.messages[1].content.indexOf('Body text.') <
      withInstructions.messages[1].content.indexOf('Extra instructions:'),
    'the note comes first, the extra instruction after it',
  )

  // Empty and whitespace-only are the same thing to a reader who cleared
  // the field: nothing extra is said, and no empty label is sent.
  for (const nothing of ['', '   ', undefined, null]) {
    const {messages} = buildPrompt('shorten', 'Body text.', nothing)
    assert.doesNotMatch(messages[1].content, /Extra instructions/)
    assert.ok(messages[1].content.includes('Body text.'))
  }
})

test('text past the note limit is cut in plain sight, never silently', () => {
  const exact = 'x'.repeat(NOTE_LIMIT)
  const over = `${exact}TAIL`

  const within = buildPrompt('summarize', exact)
  assert.equal(within.truncated, false)
  assert.ok(within.messages[1].content.includes(exact))

  const cut = buildPrompt('summarize', over)
  assert.equal(cut.truncated, true, 'the caller is told the text was cut')
  assert.ok(cut.messages[1].content.includes(exact), 'the head of the note survives')
  assert.ok(!cut.messages[1].content.includes('TAIL'), 'the tail does not')
  // Whatever else is in the prompt, the cut text is not padded back to
  // length with anything.
  assert.ok(cut.messages[1].content.length < within.messages[1].content.length + 100)
})

test('a tool the panel does not ship is a thrown error, not a blank prompt', () => {
  assert.throws(() => buildPrompt('translate', 'text'), /unknown writing tool: translate/)
  assert.throws(() => buildPrompt('', 'text'), /unknown writing tool/)
})

test('an image tool sends the picture, not the note, and needs one', () => {
  const picture = new ArrayBuffer(8)
  const {messages, truncated} = buildPrompt('describe', 'the note is ignored', 'in French', picture)
  assert.equal(truncated, false)
  assert.equal(messages[0].role, 'system')
  assert.match(messages[0].content, /Describe this image/)
  const [image, text] = messages[1].content
  assert.deepEqual(image, {type: 'image', data: picture})
  assert.equal(text.text, 'Extra instructions: in French')
  assert.ok(!JSON.stringify(messages).includes('the note is ignored'))

  assert.throws(() => buildPrompt('ocr', 'text'), /choose an image first/)
})

test('every model the picker offers is one the engine can load', () => {
  assert.deepEqual(
    MODELS.map(({id}) => id),
    Object.keys(ENGINES),
    'the same ids, in the same order',
  )
  assert.equal(MODELS[0].id, 'gemma', 'the small model stays the default')
  assert.deepEqual(MODELS.filter((model) => model.vision).map(({id}) => id), ['minicpm-v'])
})
