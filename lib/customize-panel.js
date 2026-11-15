// The Customize panel: the look, the colours and the reader's own CSS,
// changed in place and seen at once, the way Arc themes a space.
//
// Every control writes straight through lib/customize.js - saved and applied
// on each change, so there is no Apply button to forget and closing the panel
// keeps what is on screen. The panel is not modal: the note behind it is the
// preview.

import {icon} from './dialog.js'
import {
  EMPTY_THEME,
  LOOKS,
  MAX_CSS,
  PRESETS,
  applyCustomization,
  decodeThemeCode,
  encodeThemeCode,
  readCustomization,
  saveCustomization,
  themeProperties,
} from './customize.js'

/** A colour the reader adds starts here: Arc's own default purple. */
const NEW_COLOR = '#7c3aed'

/**
 * @param {{storage?: Storage, root?: HTMLElement, owner?: Document,
 *   dark?: () => boolean}} [options]
 *   `dark` says whether the page is in its dark theme now, for the
 *   readability note under the strength slider
 * @returns {{element: HTMLElement, open: () => void, close: () => void, isOpen: () => boolean}}
 */
export function createCustomizePanel({
  storage = localStorage,
  root = document.documentElement,
  owner = document,
  dark = () => matchMedia('(prefers-color-scheme: dark)').matches,
} = {}) {
  let choice = readCustomization(storage)

  const el = (tag, className, text) => {
    const node = owner.createElement(tag)
    if (className) node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }

  const panel = el('aside')
  panel.id = 'customize-panel'
  panel.setAttribute('role', 'group')
  panel.setAttribute('aria-label', 'Customize')
  panel.hidden = true

  const head = el('div', 'writing-head')
  const closeButton = el('button', 'writing-close')
  closeButton.type = 'button'
  closeButton.setAttribute('aria-label', 'Close Customize')
  closeButton.append(icon('icon-close', 16))
  head.append(el('p', 'writing-title', 'Customize'), closeButton)

  /* ---------------------------------------------------------------- look */
  const looks = el('div', 'customize-looks')
  looks.setAttribute('role', 'radiogroup')
  looks.setAttribute('aria-label', 'Look')
  const lookButtons = LOOKS.map(({id, label, hint}) => {
    const button = el('button', 'customize-look')
    button.type = 'button'
    button.dataset.look = id
    button.setAttribute('role', 'radio')
    button.title = hint
    const swatch = el('span', 'customize-look-swatch')
    swatch.setAttribute('aria-hidden', 'true')
    button.append(swatch, el('span', 'customize-look-label', label))
    button.addEventListener('click', () => change({look: id}))
    looks.append(button)
    return button
  })

  /* -------------------------------------------------------------- colours */
  const presets = el('div', 'customize-presets')
  const none = el('button', 'customize-preset customize-preset-none', 'None')
  none.type = 'button'
  none.addEventListener('click', () => change({theme: {...choice.theme, colors: []}}))
  presets.append(none)
  for (const preset of PRESETS) {
    const button = el('button', 'customize-preset')
    button.type = 'button'
    button.title = preset.label
    button.setAttribute('aria-label', `${preset.label} colours`)
    button.style.background =
      preset.colors.length === 1 ? preset.colors[0] : `linear-gradient(135deg, ${preset.colors.join(', ')})`
    button.addEventListener('click', () => change({theme: {...choice.theme, colors: [...preset.colors]}}))
    presets.append(button)
  }

  const stops = el('div', 'customize-stops')
  const addColor = el('button', 'dialog-button customize-add', 'Add colour')
  addColor.type = 'button'
  addColor.addEventListener('click', () => {
    const colors = choice.theme.colors
    if (colors.length < 3) change({theme: {...choice.theme, colors: [...colors, colors.at(-1) ?? NEW_COLOR]}})
  })

  const slider = (label, min, max, read, write) => {
    const row = el('label', 'customize-slider')
    const input = el('input')
    input.type = 'range'
    input.min = String(min)
    input.max = String(max)
    const value = el('span', 'customize-value')
    row.append(el('span', '', label), input, value)
    input.addEventListener('input', () => change({theme: write(Number(input.value))}))
    return {row, input, value, read}
  }
  const angle = slider('Angle', 0, 360, (theme) => theme.angle, (n) => ({...choice.theme, angle: n}))
  const strength = slider('Strength', 0, 100, (theme) => Math.round(theme.strength * 100), (n) => ({...choice.theme, strength: n / 100}))
  const grain = slider('Grain', 0, 100, (theme) => Math.round(theme.grain * 100), (n) => ({...choice.theme, grain: n / 100}))
  const capped = el('p', 'customize-note')
  capped.setAttribute('aria-live', 'polite')

  /* ----------------------------------------------------------- theme code */
  const codeRow = el('div', 'customize-code')
  const copy = el('button', 'dialog-button', 'Copy theme code')
  copy.type = 'button'
  const code = el('input', 'customize-code-input')
  code.type = 'text'
  code.placeholder = 'Paste a theme code'
  code.setAttribute('aria-label', 'Theme code')
  code.spellcheck = false
  const useCode = el('button', 'dialog-button', 'Use')
  useCode.type = 'button'
  codeRow.append(copy, code, useCode)

  /* ------------------------------------------------------------ own CSS */
  const advanced = el('details', 'customize-advanced')
  const summary = el('summary', '', 'Your own CSS')
  const css = el('textarea', 'customize-css')
  css.rows = 6
  css.spellcheck = false
  css.maxLength = MAX_CSS
  css.placeholder = 'article { letter-spacing: 0.01em; }'
  css.setAttribute('aria-label', 'Your own CSS')
  const cssNote = el('p', 'customize-note', 'Applies in this browser only. It is not part of a theme code and never travels with a note.')
  advanced.append(summary, css, cssNote)

  const status = el('p', 'writing-status')
  status.setAttribute('aria-live', 'polite')

  const reset = el('button', 'dialog-button customize-reset', 'Reset everything')
  reset.type = 'button'

  const section = (title) => el('p', 'customize-heading', title)
  panel.append(
    head,
    section('Look'),
    looks,
    section('Colours'),
    presets,
    stops,
    addColor,
    angle.row,
    strength.row,
    grain.row,
    capped,
    section('Share'),
    codeRow,
    advanced,
    status,
    reset,
  )

  /* -------------------------------------------------------------- state */
  const say = (text, error = false) => {
    status.textContent = text
    status.classList.toggle('error', error)
  }

  function change(next) {
    choice = {...choice, ...next}
    saveCustomization(storage, choice)
    choice = readCustomization(storage)
    applyCustomization(root, choice)
    render()
  }

  function render() {
    for (const button of lookButtons) button.setAttribute('aria-checked', String(button.dataset.look === choice.look))

    const {colors} = choice.theme
    stops.replaceChildren(
      ...colors.map((color, index) => {
        const stop = el('span', 'customize-stop')
        const input = el('input')
        input.type = 'color'
        input.value = color
        input.setAttribute('aria-label', `Colour ${index + 1}`)
        input.addEventListener('input', () => {
          const next = [...choice.theme.colors]
          next[index] = input.value
          change({theme: {...choice.theme, colors: next}})
        })
        const remove = el('button', 'customize-stop-remove')
        remove.type = 'button'
        remove.setAttribute('aria-label', `Remove colour ${index + 1}`)
        remove.append(icon('icon-close', 12))
        remove.addEventListener('click', () =>
          change({theme: {...choice.theme, colors: choice.theme.colors.filter((_, at) => at !== index)}}),
        )
        stop.append(input, remove)
        return stop
      }),
    )
    addColor.hidden = colors.length >= 3
    addColor.textContent = colors.length ? 'Add colour' : 'Pick colours'
    for (const control of [angle, strength, grain]) {
      control.input.value = String(control.read(choice.theme))
      control.input.disabled = !colors.length
      control.value.textContent = control === angle ? `${control.input.value}°` : `${control.input.value}%`
    }
    const properties = themeProperties(choice.theme)
    const limit = properties ? Number(properties[`--custom-strength-${dark() ? 'dark' : 'light'}`]) : 1
    capped.textContent =
      properties && limit < choice.theme.strength
        ? `Shown at ${Math.round(limit * 100)}% so your text stays readable on these colours.`
        : ''
    if (owner.activeElement !== css) css.value = choice.css
  }

  /* ------------------------------------------------------------ actions */
  copy.addEventListener('click', async () => {
    const text = encodeThemeCode(choice)
    try {
      await navigator.clipboard.writeText(text)
      say('Theme code copied.')
    } catch {
      code.value = text
      code.select()
      say('Copy the selected code.')
    }
  })

  const applyCode = () => {
    const decoded = decodeThemeCode(code.value)
    if (!decoded) {
      say('That is not a theme code.', true)
      return
    }
    change(decoded)
    code.value = ''
    say('Theme applied.')
  }
  useCode.addEventListener('click', applyCode)
  code.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') applyCode()
  })

  let cssTimer = 0
  css.addEventListener('input', () => {
    clearTimeout(cssTimer)
    cssTimer = setTimeout(() => change({css: css.value}), 250)
  })

  reset.addEventListener('click', () => {
    change({look: 'classic', theme: {...EMPTY_THEME, colors: []}, css: ''})
    say('Back to Classic.')
  })

  const close = () => {
    panel.hidden = true
  }
  closeButton.addEventListener('click', close)
  panel.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') close()
  })

  return {
    element: panel,
    close,
    open() {
      choice = readCustomization(storage)
      say('')
      render()
      panel.hidden = false
      lookButtons.find((button) => button.dataset.look === choice.look)?.focus()
    },
    isOpen: () => !panel.hidden,
  }
}
