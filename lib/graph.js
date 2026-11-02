// textarea-plus: the map of which notes link to which.
//
// Pure: entries in, nodes and links and their positions out. Links resolve the
// way a click on a wikilink does, by title and ignoring case, first match, so
// the map cannot show a link that would not open. lib/graph-panel.js draws it.

import {titleOf} from './front-matter.js'
import {wikiTitles} from './markdown.js'

/**
 * @param {Array<{id: string, text?: string, archived?: boolean}>} entries
 * @returns {{nodes: Array<{id: string, title: string, degree: number}>, links: Array<{source: string, target: string}>}}
 *   every titled note or linked note; each pair once, whichever way it points
 */
export function buildGraph(entries) {
  const live = entries.filter((entry) => !entry.archived)
  const byTitle = new Map()
  for (const entry of live) {
    const key = titleOf(entry.text ?? '').toLowerCase()
    if (key !== 'textarea' && !byTitle.has(key)) byTitle.set(key, entry)
  }
  const seen = new Set()
  const links = []
  const degree = new Map()
  for (const entry of live) {
    for (const title of wikiTitles(entry.text ?? '')) {
      const target = byTitle.get(title.toLowerCase())
      if (!target || target.id === entry.id) continue
      const pair = [entry.id, target.id].sort().join('\0')
      if (seen.has(pair)) continue
      seen.add(pair)
      links.push({source: entry.id, target: target.id})
      degree.set(entry.id, (degree.get(entry.id) ?? 0) + 1)
      degree.set(target.id, (degree.get(target.id) ?? 0) + 1)
    }
  }
  const nodes = live
    .filter((entry) => degree.has(entry.id) || titleOf(entry.text ?? '') !== 'Textarea')
    .map((entry) => ({id: entry.id, title: titleOf(entry.text ?? ''), degree: degree.get(entry.id) ?? 0}))
  return {nodes, links}
}

/**
 * Positions by a small force layout: every pair pushes apart, every link
 * pulls together, and everything drifts to the middle. Starts from a circle
 * in a fixed order, so one library always draws the same map.
 *
 * @param {ReturnType<typeof buildGraph>} graph
 * @param {{width?: number, height?: number, steps?: number}} [size]
 * @returns {Map<string, {x: number, y: number}>} inside the size, with a margin
 */
export function layoutGraph({nodes, links}, {width = 800, height = 560, steps = 200} = {}) {
  const points = nodes.map((node, index) => {
    const angle = (index / Math.max(1, nodes.length)) * Math.PI * 2
    return {id: node.id, x: Math.cos(angle) * 200, y: Math.sin(angle) * 200, dx: 0, dy: 0}
  })
  const at = new Map(points.map((point) => [point.id, point]))
  const k = Math.sqrt((width * height) / Math.max(1, nodes.length)) * 0.45
  for (let step = 0; step < steps; step++) {
    const heat = 40 * (1 - step / steps) + 1
    for (const point of points) point.dx = point.dy = 0
    for (let a = 0; a < points.length; a++) {
      for (let b = a + 1; b < points.length; b++) {
        const dx = points[a].x - points[b].x
        const dy = points[a].y - points[b].y
        const distance = Math.max(1, Math.hypot(dx, dy))
        const push = (k * k) / distance / distance
        points[a].dx += dx * push
        points[a].dy += dy * push
        points[b].dx -= dx * push
        points[b].dy -= dy * push
      }
    }
    for (const {source, target} of links) {
      const a = at.get(source)
      const b = at.get(target)
      const dx = a.x - b.x
      const dy = a.y - b.y
      const pull = Math.hypot(dx, dy) / k
      a.dx -= dx * pull
      a.dy -= dy * pull
      b.dx += dx * pull
      b.dy += dy * pull
    }
    for (const point of points) {
      point.dx -= point.x * 0.4
      point.dy -= point.y * 0.4
      const length = Math.max(1, Math.hypot(point.dx, point.dy))
      const move = Math.min(length, heat)
      point.x += (point.dx / length) * move
      point.y += (point.dy / length) * move
    }
  }
  // Fitted to the box, so a small library is not a knot in the middle.
  const margin = 70
  const xs = points.map((point) => point.x)
  const ys = points.map((point) => point.y)
  const spanX = Math.max(1, Math.max(...xs) - Math.min(...xs))
  const spanY = Math.max(1, Math.max(...ys) - Math.min(...ys))
  const fit = new Map()
  for (const point of points) {
    fit.set(point.id, {
      x: margin + ((point.x - Math.min(...xs)) / spanX) * (width - margin * 2),
      y: margin + ((point.y - Math.min(...ys)) / spanY) * (height - margin * 2),
    })
  }
  return fit
}
