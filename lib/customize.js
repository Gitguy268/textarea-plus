// How the app looks: the look, the colours behind the note, and the reader's
// own CSS.
//
// Three layers, each optional and each kept in localStorage only - never in
// a note, its front matter or a share link, so nothing here travels to
// another reader:
//
//   - The look: Classic (this app as it always was), Windows 97, Xiao and
//     Liquid glass. One attribute on <html>, `data-look`, which the
//     stylesheet keys whole sets of rules on. The light/dark choice stays
//     where it was (the theme row in the menu) and every look honours it.
//   - The colours: Arc's way of theming a space, brought to a page. One to
//     three colours become a gradient behind the note, with an angle, a
//     strength and a little film grain. The strength is capped so the note's
//     text keeps a 4.5:1 contrast on every part of the gradient, in light and
//     in dark, and the first colour becomes the accent where it is readable.
//   - The reader's own CSS, for anything the two above do not reach. It
//     applies in this browser only and is not part of a theme code.
//
// A theme code (`textarea-theme:` and a base64 JSON) carries the colours and
// the look from one browser to another. It is data, read back through the
// same sanitizer as storage, so a code from someone else can only ever pick
// among looks this app has and colours in #rrggbb form.

/** The looks, in the order the panel shows them. */
export const LOOKS = [
  {id: 'classic', label: 'Classic', hint: 'Textarea as it always was'},
  {id: 'win97', label: 'Windows 97', hint: 'Grey bevels, navy title bars, Tahoma and a Notepad-style page'},
  {id: 'xiao', label: 'Xiao', hint: 'Warm paper, red ink, Bricolage Grotesque and Junicode'},
  {id: 'glass', label: 'Liquid glass', hint: 'Frosted panels that bend the colours behind them'},
]

/** Ready-made colours, Arc-style: a name and one to three stops. */
export const PRESETS = [
  {id: 'dusk', label: 'Dusk', colors: ['#ff7a59', '#7c3aed']},
  {id: 'lagoon', label: 'Lagoon', colors: ['#00b4d8', '#0077b6']},
  {id: 'moss', label: 'Moss', colors: ['#84a98c', '#2f3e46']},
  {id: 'sunrise', label: 'Sunrise', colors: ['#ffb703', '#fb8500', '#e63946']},
  {id: 'lilac', label: 'Lilac', colors: ['#c8b6ff', '#ffd6ff']},
  {id: 'ember', label: 'Ember', colors: ['#d00000']},
]

export const KEYS = {look: 'textarea:look', theme: 'textarea:custom-theme', css: 'textarea:custom-css'}

/** The longest stylesheet the reader's own CSS may be. */
export const MAX_CSS = 20_000

/** What a theme code starts with. */
const CODE_PREFIX = 'textarea-theme:'

const HEX = /^#[0-9a-f]{6}$/i

/** The theme an untouched panel shows: no colours, so no gradient. */
export const EMPTY_THEME = Object.freeze({colors: [], angle: 135, strength: 0.35, grain: 0.15})

/** A look id this app has, or 'classic'. */
export function readLook(value) {
  return LOOKS.some((look) => look.id === value) ? value : 'classic'
}

const clamp = (value, min, max, fallback) => {
  const number = Number(value)
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback
}

/**
 * A theme as storage or a code may hold it, made safe, or EMPTY_THEME.
 *
 * @param {unknown} raw
 * @returns {{colors: string[], angle: number, strength: number, grain: number}}
 */
export function sanitizeTheme(raw) {
  if (!raw || typeof raw !== 'object') return {...EMPTY_THEME, colors: []}
  const colors = (Array.isArray(raw.colors) ? raw.colors : [])
    .filter((color) => typeof color === 'string' && HEX.test(color))
    .slice(0, 3)
    .map((color) => color.toLowerCase())
  return {
    colors,
    angle: Math.round(clamp(raw.angle, 0, 360, EMPTY_THEME.angle)),
    strength: clamp(raw.strength, 0, 1, EMPTY_THEME.strength),
    grain: clamp(raw.grain, 0, 1, EMPTY_THEME.grain),
  }
}

/* ------------------------------------------------------------- contrast */

const channel = (value) => {
  const c = value / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/** #rrggbb as [r, g, b], 0-255. */
export function rgbOf(hex) {
  const n = Number.parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

const hexOf = (rgb) => '#' + rgb.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')

/** WCAG relative luminance. */
export function luminance(hex) {
  const [r, g, b] = rgbOf(hex).map(channel)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG contrast ratio between two colours, 1-21. */
export function contrast(a, b) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (light + 0.05) / (dark + 0.05)
}

/** `a` moved toward `b` by `amount` (0-1), in sRGB. */
export function mix(a, b, amount) {
  const [x, y] = [rgbOf(a), rgbOf(b)]
  return hexOf(x.map((c, index) => c + (y[index] - c) * amount))
}

/** The page and text colours of each theme, as the stylesheet sets them. */
export const BASES = {light: {page: '#ffffff', text: '#161616'}, dark: {page: '#000000', text: '#ffffff'}}

/**
 * The strongest the gradient may be over a base and still leave the text
 * readable (4.5:1) on every one of its colours.
 *
 * @param {string[]} colors
 * @param {{page: string, text: string}} base
 * @returns {number} 0-1
 */
export function maxStrength(colors, base) {
  const readable = (strength) => colors.every((color) => contrast(mix(base.page, color, strength), base.text) >= 4.5)
  if (readable(1)) return 1
  let low = 0
  let high = 1
  for (let step = 0; step < 12; step++) {
    const middle = (low + high) / 2
    if (readable(middle)) low = middle
    else high = middle
  }
  return Math.floor(low * 100) / 100
}

/**
 * A colour made readable as text or a focus ring on a page: moved toward the
 * text colour until it reaches 4.5:1, which keeps its hue as far as it can.
 *
 * @param {string} color
 * @param {{page: string, text: string}} base
 * @returns {string}
 */
export function readableAccent(color, base) {
  for (let step = 0; step <= 20; step++) {
    const candidate = mix(color, base.text, step / 20)
    if (contrast(candidate, base.page) >= 4.5) return candidate
  }
  return base.text
}

/**
 * The custom properties a theme puts on <html>. Strength comes out already
 * capped per base, so the stylesheet only picks the light or dark one.
 *
 * @param {{colors: string[], angle: number, strength: number, grain: number}} theme
 * @returns {Record<string, string> | null} null when there are no colours
 */
export function themeProperties(theme) {
  const {colors, angle, strength, grain} = sanitizeTheme(theme)
  if (!colors.length) return null
  const stops = [colors[0], colors[1] ?? colors[0], colors[2] ?? colors[1] ?? colors[0]]
  const properties = {
    '--custom-1': stops[0],
    '--custom-2': stops[1],
    '--custom-3': stops[2],
    '--custom-angle': `${angle}deg`,
    '--custom-grain': String(grain),
  }
  for (const [name, base] of Object.entries(BASES)) {
    properties[`--custom-strength-${name}`] = String(Math.min(strength, maxStrength(stops, base)))
    properties[`--custom-accent-${name}`] = readableAccent(colors[0], base)
  }
  return properties
}

/* ------------------------------------------------------------ theme code */

/**
 * The look and the colours as one line to copy into another browser.
 *
 * @param {{look: string, theme: object}} choice
 * @returns {string}
 */
export function encodeThemeCode({look, theme}) {
  const json = JSON.stringify({v: 1, look: readLook(look), ...sanitizeTheme(theme)})
  const base64 = btoa(String.fromCharCode(...new TextEncoder().encode(json)))
  return CODE_PREFIX + base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * A theme code read back, or null when it is not one.
 *
 * @param {string} code
 * @returns {{look: string, theme: object} | null}
 */
export function decodeThemeCode(code) {
  const text = String(code ?? '').trim()
  if (!text.startsWith(CODE_PREFIX) || text.length > 2000) return null
  try {
    const base64 = text.slice(CODE_PREFIX.length).replace(/-/g, '+').replace(/_/g, '/')
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
    const raw = JSON.parse(new TextDecoder().decode(bytes))
    if (raw?.v !== 1) return null
    return {look: readLook(raw.look), theme: sanitizeTheme(raw)}
  } catch {
    return null
  }
}

/* --------------------------------------------------------------- storage */

const safely = (act, fallback) => {
  try {
    return act()
  } catch {
    return fallback
  }
}

/**
 * Everything the reader chose, as storage holds it.
 *
 * @param {Storage} storage
 * @returns {{look: string, theme: object, css: string}}
 */
export function readCustomization(storage) {
  return {
    look: readLook(safely(() => storage.getItem(KEYS.look), null)),
    theme: sanitizeTheme(safely(() => JSON.parse(storage.getItem(KEYS.theme) ?? 'null'), null)),
    css: String(safely(() => storage.getItem(KEYS.css), '') ?? '').slice(0, MAX_CSS),
  }
}

/** Write the reader's choices; defaults are removed rather than stored. */
export function saveCustomization(storage, {look, theme, css}) {
  const write = (key, value) =>
    safely(() => (value === null ? storage.removeItem(key) : storage.setItem(key, value)), undefined)
  const safeLook = readLook(look)
  write(KEYS.look, safeLook === 'classic' ? null : safeLook)
  const safeTheme = sanitizeTheme(theme)
  write(KEYS.theme, safeTheme.colors.length ? JSON.stringify(safeTheme) : null)
  const safeCss = String(css ?? '').slice(0, MAX_CSS)
  write(KEYS.css, safeCss.trim() ? safeCss : null)
}

/* ----------------------------------------------------------------- apply */

const OWNED = [
  '--custom-1',
  '--custom-2',
  '--custom-3',
  '--custom-angle',
  '--custom-grain',
  '--custom-strength-light',
  '--custom-strength-dark',
  '--custom-accent-light',
  '--custom-accent-dark',
]

/**
 * Put the choices on the page: the look and the colours on <html>, the
 * reader's CSS in a <style> of its own at the end of <head>.
 *
 * @param {HTMLElement} root
 * @param {{look: string, theme: object, css: string}} choice
 */
export function applyCustomization(root, {look, theme, css = ''}) {
  const safeLook = readLook(look)
  if (safeLook === 'classic') delete root.dataset.look
  else root.dataset.look = safeLook

  const properties = themeProperties(theme)
  for (const name of OWNED) root.style.removeProperty(name)
  if (properties) {
    for (const [name, value] of Object.entries(properties)) root.style.setProperty(name, value)
    root.dataset.custom = ''
  } else {
    delete root.dataset.custom
  }

  const owner = root.ownerDocument
  let style = owner.getElementById('custom-css')
  const text = String(css ?? '').slice(0, MAX_CSS)
  if (!text.trim()) {
    style?.remove()
    return
  }
  if (!style) {
    style = owner.createElement('style')
    style.id = 'custom-css'
    owner.head.append(style)
  }
  // textContent, never innerHTML: the text is a stylesheet and nothing else.
  style.textContent = text
}
