// The settings panel: every switch and every knob in one place.
//
// The menu keeps its quick rows - a reader who only wants the glass off
// should not have to open anything - and this dialog is the whole picture:
// the same switches the menu carries, plus the appearance choices that have
// no business being four rows of their own. The switches are handed in by
// the app as get/set pairs against the very preferences the menu rows read,
// so the two faces can never disagree: there is one switch, and this panel
// is another way to flip it.
//
// The panel owns nothing and remembers nothing itself. Every change is
// written through the app's own setter, the appearance module's own
// storage, or the font shelf's own records, so closing the dialog the same
// way it was opened leaves the state exactly as a reader expects.

import {
  applyAppearance,
  FONTS,
  isCustomFont,
  LEADING_RANGE,
  readAppearance,
  saveAppearance,
  SIZE_RANGE,
} from './appearance.js'
import {
  applyFont,
  CUSTOM_FONTS_KEY,
  enabled as customFontsEnabled,
  FONT_EXTENSIONS,
  importFont,
  importFontFromUrl,
  listFonts,
  customStacks,
  removeFont,
} from './fonts.js'
import {trackGlass} from './glass.js'

/** The value every unset appearance preference falls back to. */
const DEFAULTS = {
  font: FONTS[0].id,
  size: SIZE_RANGE.fallback,
  leading: LEADING_RANGE.fallback,
}

/**
 * Show the settings.
 *
 * The dialog is built asynchronously: the font shelf is read first, so the
 * note's select offers every font in one paint rather than gaining options
 * under the reader's cursor.
 *
 * @param {object} [options]
 * @param {Array<{id: string, label: string, get: () => boolean,
 *   set: (on: boolean) => void, available?: () => boolean,
 *   options?: Array<{id: string, label: string,
 *   kind?: 'switch' | 'select' | 'text',
 *   choices?: Array<{value: string, label: string}>, placeholder?: string,
 *   get: () => boolean | string, set: (value: any) => void}>}>} [options.features]
 *   the switches in the order they should appear; a feature whose
 *   `available` says no is left out entirely, the same way the menu hides
 *   its row. Each feature's own `options` are its behaviour, shown beneath
 *   its switch and only while that switch is on
 * @param {(message: string, isError?: boolean) => void} [options.notify]
 *   how the panel reports a font that was added or refused; the app's own
 *   bubble, injected so the panel stays free of the page it sits in
 * @returns {Promise<void>}
 */
export async function showSettingsPanel({features = [], notify = () => {}} = {}) {
  // The shelf before the DOM: options that arrived after the first paint
  // would move the choice under the reader's cursor.
  const storedFonts = await listFonts()
  const dialog = document.createElement('dialog')
  dialog.className = 'dialog dialog-settings'
  dialog.setAttribute('aria-label', 'Settings')

  const form = document.createElement('form')
  form.method = 'dialog'
  form.className = 'dialog-form'

  const heading = document.createElement('h2')
  heading.className = 'dialog-title'
  heading.textContent = 'Settings'
  form.append(heading)

  const description = document.createElement('p')
  description.className = 'dialog-description'
  description.textContent =
    'Switch features on or off and shape the note. Every choice is kept on this device only.'
  form.append(description)

  /* ------------------------------------------------------------- features */

  form.append(sectionHeading('Features'))

  const featureList = document.createElement('div')
  featureList.className = 'settings-features'
  for (const feature of features) {
    if (feature.available && !feature.available()) continue

    const input = document.createElement('input')
    input.type = 'checkbox'
    input.id = 'setting-' + feature.id
    input.checked = feature.get()

    const label = document.createElement('label')
    label.className = 'dialog-check'
    label.append(input, document.createTextNode(feature.label))
    featureList.append(label)

    if (!feature.options?.length) {
      input.addEventListener('change', () => {
        feature.set(input.checked)
        // Read back after the flip: a preference the browser would not take
        // says so by showing the state the app is actually in.
        input.checked = feature.get()
      })
      continue
    }

    // The behaviour rides beneath the switch it belongs to, and only while
    // that switch is on: a choice about a feature that is off is noise, and
    // hiding it this way keeps the panel from growing a section nobody asked
    // for until they asked for the feature.
    const box = document.createElement('div')
    box.className = 'feature-options'
    box.hidden = !input.checked
    for (const option of feature.options) box.append(buildOption(feature.id, option))
    featureList.append(box)

    input.addEventListener('change', () => {
      feature.set(input.checked)
      input.checked = feature.get()
      box.hidden = !input.checked
    })
  }
  form.append(featureList)

  /* ----------------------------------------------------------- appearance */

  form.append(sectionHeading('Appearance'))

  const appearanceList = document.createElement('div')
  appearanceList.className = 'settings-appearance'

  // The accent is a colour and a switch, because a colour input has no way
  // to say "none": unchecked is the theme's own colours showing through,
  // which is where every reader starts.
  const accentCheck = document.createElement('input')
  accentCheck.type = 'checkbox'
  accentCheck.id = 'setting-accent-custom'

  const accentColor = document.createElement('input')
  accentColor.type = 'color'
  accentColor.id = 'setting-accent'
  accentColor.setAttribute('aria-label', 'Accent colour')

  const fontSelect = document.createElement('select')
  fontSelect.id = 'setting-font'
  for (const font of FONTS) {
    const option = document.createElement('option')
    option.value = font.id
    option.textContent = font.label
    fontSelect.append(option)
  }

  /**
   * Rebuild the select's custom half: the stored fonts after the built-ins,
   * or none of them while the feature is off - the switch is what decides,
   * and the built-in three are always on offer.
   */
  const drawFontOptions = (fonts) => {
    for (const option of [...fontSelect.options]) {
      if (isCustomFont(option.value)) option.remove()
    }
    if (!customFontsEnabled(localStorage)) return
    for (const record of fonts) {
      const option = document.createElement('option')
      option.value = record.id
      option.textContent = record.family
      fontSelect.append(option)
    }
  }
  drawFontOptions(storedFonts)

  const sizeRange = document.createElement('input')
  sizeRange.type = 'range'
  sizeRange.id = 'setting-size'
  sizeRange.min = String(SIZE_RANGE.min)
  sizeRange.max = String(SIZE_RANGE.max)
  sizeRange.step = '1'

  const sizeValue = document.createElement('span')
  sizeValue.className = 'settings-value'

  const leadingRange = document.createElement('input')
  leadingRange.type = 'range'
  leadingRange.id = 'setting-leading'
  leadingRange.min = String(LEADING_RANGE.min)
  leadingRange.max = String(LEADING_RANGE.max)
  leadingRange.step = '0.1'

  const leadingValue = document.createElement('span')
  leadingValue.className = 'settings-value'

  /* ------------------------------------------------------- custom fonts */

  // A shelf rather than a single choice: a switch, the file input that
  // fills it, and one row per font already on it. The switch lives in
  // storage like every other, and switching it off does more than hide the
  // rows - a note left in a custom font falls back to a system stack, so
  // the screen keeps agreeing with the switch.
  const fontsCheck = document.createElement('input')
  fontsCheck.type = 'checkbox'
  fontsCheck.id = 'setting-custom-fonts'
  fontsCheck.checked = customFontsEnabled(localStorage)

  const fontFile = document.createElement('input')
  fontFile.type = 'file'
  fontFile.id = 'setting-font-file'
  fontFile.accept = FONT_EXTENSIONS
  fontFile.multiple = true

  // The second way in: a link to a file in a public repository, read
  // through the same shelf and refused on the same terms. The field is
  // text rather than a URL input so a pasted link with a query or a
  // fragment reaches the checker whole - rawGitHubUrl drops what it does
  // not want, and an input that has already dropped it cannot be blamed
  // for what never arrived.
  const fontUrl = document.createElement('input')
  fontUrl.type = 'text'
  fontUrl.id = 'setting-font-url'
  fontUrl.className = 'settings-font-url'
  fontUrl.placeholder = 'https://github.com/user/repo/blob/main/Font.ttf'

  const fontImport = document.createElement('button')
  fontImport.type = 'button'
  fontImport.id = 'setting-font-import'
  fontImport.className = 'dialog-button settings-font-action'
  fontImport.textContent = 'Import'

  const fontList = document.createElement('div')
  fontList.className = 'settings-font-list'

  const fontsBox = document.createElement('div')
  fontsBox.className = 'feature-options'
  fontsBox.hidden = !fontsCheck.checked
  fontsBox.append(
    settingsRow('Add font files', fontFile),
    settingsRow('From GitHub', fontUrl, fontImport),
    fontList,
  )

  /** One row per stored font, each with the button that takes it back. */
  const drawFontRows = (fonts) => {
    fontList.textContent = ''
    if (!customFontsEnabled(localStorage)) return
    for (const record of fonts) {
      const remove = document.createElement('button')
      remove.type = 'button'
      remove.className = 'dialog-button settings-font-action'
      remove.textContent = 'Remove'
      remove.setAttribute('aria-label', `Remove ${record.family}`)
      remove.addEventListener('click', async () => {
        if (!(await removeFont(record.id))) {
          notify('That font could not be removed.', true)
          return
        }
        // A removed font cannot stay the note's choice: the stack is gone,
        // so the preference goes back to the default in the same breath.
        const values = readAppearance(localStorage)
        if (values.font === record.id) {
          saveAppearance(localStorage, {...values, font: DEFAULTS.font})
          applyAppearance(document.documentElement, {...values, font: DEFAULTS.font})
        }
        // Redraw before the message, for the same reason as the upload:
        // the notice and the panel should agree by the time it is read.
        await refreshFonts()
        notify(`Removed “${record.family}”`)
      })
      fontList.append(settingsRow(record.family, remove))
    }
  }

  /** Re-read the shelf and redraw everything that shows it. */
  const refreshFonts = async () => {
    const fonts = await listFonts()
    drawFontOptions(fonts)
    drawFontRows(fonts)
    fontsBox.hidden = !customFontsEnabled(localStorage)
    paint()
  }

  fontFile.addEventListener('change', async () => {
    for (const file of fontFile.files ?? []) {
      try {
        const record = await importFont(file.name, await file.arrayBuffer())
        // Redraw before the message: a reader who reads "Added" and looks
        // at the select must find it there, not on its way.
        await refreshFonts()
        notify(`Added “${record.family}”`)
      } catch (error) {
        notify(error?.message ?? `Could not add ${file.name}`, true)
      }
    }
    fontFile.value = ''
  })

  fontImport.addEventListener('click', async () => {
    const link = fontUrl.value.trim()
    if (!link) {
      notify('Paste a link to a font file in a public GitHub repository.', true)
      return
    }
    // Disabled across the round trip: a second click while the bytes are
    // still arriving would be a second font fighting over the same slot.
    fontImport.disabled = true
    try {
      const record = await importFontFromUrl(link)
      // Redraw before the message, for the same reason as the upload.
      await refreshFonts()
      fontUrl.value = ''
      notify(`Added “${record.family}”`)
    } catch (error) {
      notify(error?.message ?? 'That link could not be imported.', true)
    } finally {
      fontImport.disabled = false
    }
  })

  fontsCheck.addEventListener('change', async () => {
    try {
      if (fontsCheck.checked) localStorage.removeItem(CUSTOM_FONTS_KEY)
      else localStorage.setItem(CUSTOM_FONTS_KEY, 'off')
    } catch {
      // Storage refused: the shelf keeps its contents either way.
    }
    // A note left in a custom font falls back while the feature is off, so
    // what is on screen is what the switch says - and the choice written
    // back is a system stack rather than a preference nothing applies.
    const values = readAppearance(localStorage)
    if (isCustomFont(values.font)) {
      saveAppearance(localStorage, {...values, font: DEFAULTS.font})
      applyAppearance(document.documentElement, {...values, font: DEFAULTS.font})
    }
    await refreshFonts()
    fontsCheck.checked = customFontsEnabled(localStorage)
  })
  drawFontRows(storedFonts)

  appearanceList.append(
    settingsRow('Custom accent colour', accentCheck, accentColor),
    settingsRow('Note font', fontSelect),
    settingsRow('Custom fonts', fontsCheck),
    fontsBox,
    settingsRow('Text size', sizeRange, sizeValue),
    settingsRow('Line spacing', leadingRange, leadingValue),
  )
  form.append(appearanceList)

  /**
   * Write the four choices where they belong and put them on the page in
   * the same breath, so the panel previews what a reload will show.
   */
  const commit = () => {
    const values = {
      accent: accentCheck.checked ? accentColor.value : null,
      font: fontSelect.value,
      size: sizeRange.value,
      leading: leadingRange.value,
    }
    saveAppearance(localStorage, values)
    applyAppearance(document.documentElement, values, customStacks())
  }

  /** Put every control back in step with what is actually stored. */
  const paint = () => {
    const values = readAppearance(localStorage)
    accentCheck.checked = values.accent !== null
    accentColor.disabled = !accentCheck.checked
    accentColor.value = values.accent ?? themeOutline()
    fontSelect.value = values.font ?? DEFAULTS.font
    // A stored font whose files are gone matches no option; show the
    // default rather than an empty select. The preference itself is left
    // alone - it is only the next change to any control that commits the
    // choice actually on offer.
    if (fontSelect.value === '') fontSelect.value = DEFAULTS.font
    sizeRange.value = String(values.size ?? DEFAULTS.size)
    leadingRange.value = String(values.leading ?? DEFAULTS.leading)
    sizeValue.textContent = sizeRange.value + 'px'
    leadingValue.textContent = leadingRange.value
  }

  accentCheck.addEventListener('change', () => {
    accentColor.disabled = !accentCheck.checked
    commit()
  })
  accentColor.addEventListener('input', commit)
  fontSelect.addEventListener('change', async () => {
    // A font stored in an earlier session has a stack but no face until it
    // is asked for; without this the note keeps the fallback until a reload.
    if (isCustomFont(fontSelect.value)) await applyFont(fontSelect.value)
    commit()
  })
  sizeRange.addEventListener('input', () => {
    sizeValue.textContent = sizeRange.value + 'px'
    commit()
  })
  leadingRange.addEventListener('input', () => {
    leadingValue.textContent = leadingRange.value
    commit()
  })

  /* -------------------------------------------------------------- actions */

  const actions = document.createElement('div')
  actions.className = 'dialog-actions'

  const reset = document.createElement('button')
  reset.type = 'button'
  reset.id = 'setting-reset'
  reset.className = 'dialog-button'
  reset.textContent = 'Reset appearance'
  reset.addEventListener('click', () => {
    const cleared = {accent: null, font: null, size: null, leading: null}
    saveAppearance(localStorage, cleared)
    applyAppearance(document.documentElement, cleared)
    paint()
  })

  const closeButton = document.createElement('button')
  closeButton.type = 'button'
  closeButton.className = 'dialog-button dialog-button-primary'
  closeButton.textContent = 'Close'

  actions.append(reset, closeButton)
  form.append(actions)
  dialog.append(form)

  let releaseGlass = () => {}
  const close = () => {
    releaseGlass()
    dialog.close()
    dialog.remove()
  }

  closeButton.addEventListener('click', close)
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault()
    close()
  })
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) close()
  })

  paint()
  document.body.append(dialog)
  dialog.showModal()
  releaseGlass = trackGlass(dialog)
}

/** A section label above each half of the panel. */
function sectionHeading(text) {
  const heading = document.createElement('p')
  heading.className = 'settings-heading'
  heading.textContent = text
  return heading
}

/**
 * One behaviour choice beneath a feature switch: another switch, a choice
 * from a list, or a line of text. Read back through `get` after every `set`,
 * the same way the switches are, so a preference that would not take shows it.
 *
 * @param {string} featureId the switch this choice rides under
 * @param {{id: string, label: string,
 *   kind?: 'switch' | 'select' | 'text',
 *   choices?: Array<{value: string, label: string}>, placeholder?: string,
 *   get: () => boolean | string, set: (value: any) => void}} option
 * @returns {HTMLElement}
 */
function buildOption(featureId, option) {
  const id = `setting-${featureId}-${option.id}`

  if (option.kind === 'select') {
    const select = document.createElement('select')
    select.id = id
    for (const choice of option.choices ?? []) {
      const element = document.createElement('option')
      element.value = choice.value
      element.textContent = choice.label
      select.append(element)
    }
    select.value = String(option.get())
    select.addEventListener('change', () => {
      option.set(select.value)
      select.value = String(option.get())
    })
    return settingsRow(option.label, select)
  }

  // Free text, written on change rather than per keystroke: the preference
  // behind it is a sentence, and a setter that trims or normalises says so
  // in the box rather than in a preference the reader cannot see.
  if (option.kind === 'text') {
    const field = document.createElement('input')
    field.type = 'text'
    field.id = id
    field.value = String(option.get() ?? '')
    if (option.placeholder) field.placeholder = option.placeholder
    field.addEventListener('change', () => {
      option.set(field.value)
      field.value = String(option.get() ?? '')
    })
    return settingsRow(option.label, field)
  }

  const input = document.createElement('input')
  input.type = 'checkbox'
  input.id = id
  input.checked = Boolean(option.get())
  input.addEventListener('change', () => {
    option.set(input.checked)
    input.checked = Boolean(option.get())
  })

  const label = document.createElement('label')
  label.className = 'dialog-check'
  label.append(input, document.createTextNode(option.label))
  return label
}

/**
 * One row: its label on the left, its controls on the right.
 *
 * The label points at the first control, which is the one its text names;
 * the rest - a colour beside its switch, a value beside its slider - speak
 * for themselves.
 */
function settingsRow(text, ...controls) {
  const row = document.createElement('div')
  row.className = 'settings-row'

  const label = document.createElement('label')
  label.textContent = text
  if (controls[0].id) label.htmlFor = controls[0].id

  const group = document.createElement('span')
  group.className = 'settings-controls'
  group.append(...controls)

  row.append(label, group)
  return row
}

/** The accent in effect right now, for the colour input to start from. */
function themeOutline() {
  const value = getComputedStyle(document.documentElement).getPropertyValue('--outline')
  return value.trim() || '#007aff'
}
