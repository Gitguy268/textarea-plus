// The glass panels: the preference, the gates and the registry.
//
// The vendored module in vendor/liquid-glass/ owns the optics: it builds an
// SVG filter from a displacement map and points the element's backdrop-filter
// at it, so the page behind a panel visibly bends at the rim. This file owns
// the policy — which surfaces may have the effect, and which way the switch
// points.
//
// Three gates, in order:
//
//   - The reader's stored preference, on unless the Glass row switched it off.
//   - prefers-reduced-transparency: a reader who asks for less transparency
//     gets the opaque panels this app always had, and is not offered a row in
//     the menu for an effect they cannot have.
//   - The browser. Refraction needs an SVG filter usable as a backdrop, which
//     today means Chromium; Safari and Firefox receive the module's frosted
//     blur instead — the same picture, minus the bending.
//
// The module itself is imported on first use, like the other vendored
// libraries, and the service worker caches it from then on. Nothing in this
// file runs — not even a fetch — until a panel actually opens.

const GLASS_KEY = 'textarea:glass'

/**
 * Surfaces registered for glass: each element mapped to its handle, or to
 * null while the import is in flight or the effect is switched off.
 *
 * @type {Map<Element, {destroy: () => void} | null>}
 */
const surfaces = new Map()

/**
 * How a panel bends what is behind it: the interior blurred enough that the
 * note's text cannot fight a label printed over it, and the three colour
 * channels staggered wider than the module's default, which is the prism
 * fringe at the rim. The module's own defaults suit a card over a photograph.
 */
const PANEL = {blur: 12, saturate: 1.8, chroma: 10}

/** The options a surface asked for instead of a panel's, by element. */
const settings = new WeakMap()

/** The preference once read, so a storage that throws is only paid once. */
let preference = null
let loading = null

function storedPreference() {
  if (preference === null) {
    try {
      preference = localStorage.getItem(GLASS_KEY) !== 'off'
    } catch {
      preference = true
    }
  }
  return preference
}

/** Whether the system has asked for less transparency. */
export function reducedTransparency() {
  return matchMedia('(prefers-reduced-transparency: reduce)').matches
}

/** Whether the menu should offer the row at all. */
export function glassAvailable() {
  return !reducedTransparency()
}

/** Whether glass should be rendering right now. */
export function glassEnabled() {
  return glassAvailable() && storedPreference()
}

/**
 * The panels only go translucent when there is something behind them to bend,
 * so the state rides on the root and the CSS in index.html hangs off it.
 * Called at boot, for the round button that is on screen from the start, and
 * again whenever a surface is tracked or the switch is thrown. It touches a
 * class and nothing else: the module is still not fetched until a panel opens.
 */
export function syncRoot() {
  document.documentElement.classList.toggle('glass', glassEnabled())
}

/** Import the vendored module at most once, and recover if it fails. */
async function getLiquidGlass() {
  if (typeof globalThis.liquidGlass === 'function') return globalThis.liquidGlass
  loading ??= import('../vendor/liquid-glass/liquid-glass.js').then(() => {
    if (typeof globalThis.liquidGlass !== 'function') {
      throw new Error('liquid-glass loaded but did not register itself')
    }
    return globalThis.liquidGlass
  })
  try {
    return await loading
  } catch (error) {
    loading = null
    throw error
  }
}

/** Apply the effect to one registered surface, if it should be showing. */
async function apply(el) {
  try {
    const liquidGlass = await getLiquidGlass()
    // The surface may have been released, or the switch thrown, while the
    // import was in flight.
    if (!surfaces.has(el) || !glassEnabled() || !el.isConnected) return
    surfaces.set(el, liquidGlass(el, {...PANEL, ...settings.get(el)}))
  } catch {
    // The module would not load. The panels keep the stylesheet's blur and the
    // next attempt starts fresh; a reader must not see an error for a panel
    // decoration.
  }
}

/**
 * Register a floating surface for glass.
 *
 * Applies the effect now if it is on, or the first time it is switched on
 * while the surface is alive. Returns the function that takes it back off
 * again: dialogs call it when they close, while the menu and the statistics
 * panel hold theirs for the session.
 *
 * @param {Element} el
 * @param {object} [options]  the module's options for this surface, where a
 *   panel's would not suit it: the round button is a fifth of a panel's size
 * @returns {() => void}
 */
export function trackGlass(el, options) {
  if (!surfaces.has(el)) {
    if (options) settings.set(el, options)
    surfaces.set(el, null)
    if (glassEnabled()) void apply(el)
  }
  syncRoot()
  return () => releaseGlass(el)
}

function releaseGlass(el) {
  if (!surfaces.has(el)) return
  const handle = surfaces.get(el)
  surfaces.delete(el)
  handle?.destroy()
}

/**
 * Switch the effect on or off, everywhere, until it is switched again.
 *
 * @param {boolean} on
 */
export function setGlassEnabled(on) {
  preference = on
  try {
    localStorage.setItem(GLASS_KEY, on ? 'on' : 'off')
  } catch {
    // Storage refused. The choice still holds for this session.
  }
  syncRoot()

  for (const [el, handle] of surfaces) {
    if (on) {
      if (!handle && glassEnabled()) void apply(el)
    } else {
      handle?.destroy()
      surfaces.set(el, null)
    }
  }
}
