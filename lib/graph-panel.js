// textarea-plus: the graph dialog. Each note is a dot, each [[link]] a line, a
// click opens the note. Every dot is a real button to the keyboard and a screen
// reader; what lib/graph.js computed is all this draws.

import {buildGraph, layoutGraph} from './graph.js'
import {listDocuments} from './library.js'

const SVG = 'http://www.w3.org/2000/svg'

/** Open the graph. @param {{current: string | null, onOpen: (entry: object) => void}} options */
export async function openGraph({current, onOpen}) {
  const entries = await listDocuments()
  const graph = buildGraph(entries)
  const byId = new Map(entries.map((entry) => [entry.id, entry]))

  const dialog = document.createElement('dialog')
  dialog.className = 'dialog dialog-graph'
  dialog.setAttribute('aria-label', 'Graph of linked notes')

  const heading = document.createElement('h2')
  heading.className = 'dialog-title'
  heading.textContent = 'Graph'

  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'dialog-button graph-close'
  close.textContent = 'Close'
  close.addEventListener('click', () => dialog.close())

  dialog.append(heading)
  if (!graph.nodes.length) {
    const empty = document.createElement('p')
    empty.className = 'dialog-description'
    empty.textContent = 'No titled notes yet. Link one to another with [[its title]] to draw a line.'
    dialog.append(empty)
  } else {
    const width = 800
    const height = 560
    const points = layoutGraph(graph, {width, height})
    const svg = document.createElementNS(SVG, 'svg')
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`)
    svg.setAttribute('class', 'graph')
    for (const {source, target} of graph.links) {
      const line = document.createElementNS(SVG, 'line')
      line.setAttribute('x1', points.get(source).x)
      line.setAttribute('y1', points.get(source).y)
      line.setAttribute('x2', points.get(target).x)
      line.setAttribute('y2', points.get(target).y)
      svg.append(line)
    }
    for (const node of graph.nodes) {
      const point = points.get(node.id)
      const group = document.createElementNS(SVG, 'g')
      group.setAttribute('class', node.id === current ? 'graph-node graph-current' : 'graph-node')
      group.setAttribute('tabindex', '0')
      group.setAttribute('role', 'button')
      group.setAttribute('aria-label', `Open ${node.title}, ${node.degree} links`)
      const dot = document.createElementNS(SVG, 'circle')
      dot.setAttribute('cx', point.x)
      dot.setAttribute('cy', point.y)
      dot.setAttribute('r', 6 + Math.min(node.degree, 6) * 1.5)
      const label = document.createElementNS(SVG, 'text')
      label.setAttribute('x', point.x)
      label.setAttribute('y', point.y - 14 - Math.min(node.degree, 6))
      label.textContent = node.title.length > 28 ? `${node.title.slice(0, 27)}…` : node.title
      // Wider than the dot: a small target with a gap before its label is
      // where clicks go missing.
      const target = document.createElementNS(SVG, 'circle')
      target.setAttribute('class', 'graph-target')
      target.setAttribute('cx', point.x)
      target.setAttribute('cy', point.y - 6)
      target.setAttribute('r', 26)
      group.append(target, dot, label)
      const open = () => {
        dialog.close()
        onOpen(byId.get(node.id))
      }
      group.addEventListener('click', open)
      group.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          open()
        }
      })
      svg.append(group)
    }
    dialog.append(svg)
  }
  dialog.append(close)
  dialog.addEventListener('close', () => dialog.remove())
  document.body.append(dialog)
  dialog.showModal()
  return dialog
}
