// The board: an organised note drawn as one card per topic.
//
// The note stays the source - this panel only reads it, and a ticked box is
// written back to that one line through `onChange`. Each card shows how far
// the topic is, as a bar and in words ("2 of 5 done"), its tasks as real
// checkboxes, its open questions, and its plain notes.
//
// Shared, byte for byte, by textarea-master, textarea-master-claude and
// Xiao's notes pack, like lib/organise.js.

import {parseBoard, progress, setDone} from './organise.js'

/**
 * @param {object} options
 * @param {(text: string) => void} options.onChange the note with a box ticked
 * @param {() => void} [options.onClose]
 * @param {Document} [options.owner]
 * @returns {{element: HTMLElement, update: (text: string) => boolean,
 *   open: () => void, close: () => void, isOpen: () => boolean}}
 */
export function createBoard({onChange, onClose = () => {}, owner = document}) {
  const el = (tag, className, text) => {
    const node = owner.createElement(tag)
    if (className) node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }

  const panel = el('aside')
  panel.id = 'board-panel'
  panel.setAttribute('aria-label', 'Board')
  panel.hidden = true

  const head = el('div', 'board-head')
  const title = el('p', 'board-title', 'Board')
  const close = el('button', 'board-close', '×')
  close.type = 'button'
  close.setAttribute('aria-label', 'Close the board')
  head.append(title, close)
  const cards = el('div', 'board-cards')
  panel.append(head, cards)

  let text = ''

  const card = (topic) => {
    const {done, total} = progress(topic)
    const section = el('section', 'board-card')
    const h = el('h3', 'board-topic', topic.topic)
    section.append(h)
    if (total) {
      const meter = el('div', 'board-progress')
      const bar = el('progress')
      bar.max = total
      bar.value = done
      bar.setAttribute('aria-label', `${topic.topic}: ${done} of ${total} done`)
      meter.append(bar, el('span', 'board-count', `${done} of ${total} done`))
      section.append(meter)
    }
    const list = el('ul', 'board-items')
    for (const item of topic.items) {
      const li = el('li', `board-item board-${item.kind}`)
      if (item.kind === 'task') {
        const label = el('label')
        const box = el('input')
        box.type = 'checkbox'
        box.checked = item.done
        box.addEventListener('change', () => {
          const next = setDone(text, item.line, box.checked)
          if (next !== text) onChange(next)
        })
        label.append(box, el('span', '', item.text))
        li.append(label)
        if (item.done) li.classList.add('board-done')
      } else {
        if (item.kind === 'question') li.append(el('span', 'board-mark', '?'))
        li.append(el('span', '', item.text))
      }
      list.append(li)
    }
    section.append(list)
    return section
  }

  close.addEventListener('click', () => {
    panel.hidden = true
    onClose()
  })

  return {
    element: panel,
    /** Redraw from the note; answers whether the note is a board at all. */
    update(next) {
      text = String(next ?? '')
      const topics = parseBoard(text)
      title.textContent = text.match(/^#\s+(.+)$/m)?.[1] ?? 'Board'
      // A ticked box saves the note, and the save redraws the board: keep the
      // keyboard where it was.
      const boxes = () => [...cards.querySelectorAll('input')]
      const focused = boxes().indexOf(owner.activeElement)
      cards.replaceChildren(...topics.map(card))
      if (focused >= 0) boxes()[focused]?.focus()
      return topics.length > 0
    },
    open: () => {
      panel.hidden = false
    },
    close: () => {
      panel.hidden = true
    },
    isOpen: () => !panel.hidden,
  }
}
