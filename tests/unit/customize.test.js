// The Customize panel's rules: which looks exist, what a theme may hold, how
// strong its colours may be over the note, and the code that carries it.

import assert from 'node:assert/strict'
import {test} from 'node:test'

import {
  BASES,
  KEYS,
  LOOKS,
  MAX_CSS,
  PRESETS,
  contrast,
  decodeThemeCode,
  encodeThemeCode,
  maxStrength,
  mix,
  readCustomization,
  readLook,
  readableAccent,
  sanitizeTheme,
  saveCustomization,
  themeProperties,
} from '../../lib/customize.js'

/** A Storage stand-in. */
function memory(initial = {}) {
  const data = new Map(Object.entries(initial))
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
    data,
  }
}

test('the four looks, and nothing else', () => {
  assert.deepEqual(LOOKS.map(({id}) => id), ['classic', 'win97', 'xiao', 'glass'])
  assert.equal(readLook('xiao'), 'xiao')
  assert.equal(readLook('hotdog-stand'), 'classic')
  assert.equal(readLook(null), 'classic')
})

test('a theme keeps up to three #rrggbb colours and clamps the rest', () => {
  assert.deepEqual(
    sanitizeTheme({colors: ['#FF0000', 'red', 'url(x)', '#00ff00', '#0000ff', '#ffffff'], angle: 999, strength: -2, grain: 'a'}),
    {colors: ['#ff0000', '#00ff00', '#0000ff'], angle: 360, strength: 0, grain: 0.15},
  )
  assert.deepEqual(sanitizeTheme('nonsense').colors, [])
})

test('contrast follows WCAG', () => {
  assert.equal(Math.round(contrast('#000000', '#ffffff')), 21)
  assert.equal(contrast('#777777', '#777777'), 1)
  assert.equal(mix('#000000', '#ffffff', 0.5), '#808080')
})

test('the strength is capped so text stays at 4.5:1 on every colour', () => {
  for (const preset of PRESETS) {
    for (const base of Object.values(BASES)) {
      const limit = maxStrength(preset.colors, base)
      for (const color of preset.colors) {
        assert.ok(contrast(mix(base.page, color, limit), base.text) >= 4.5, `${preset.id} over ${base.page}`)
      }
    }
  }
  // White text over white tint can go all the way; black over black cannot.
  assert.equal(maxStrength(['#000000'], BASES.dark), 1)
  assert.ok(maxStrength(['#000000'], BASES.light) < 0.6)
})

test('the accent is moved toward the text colour until it is readable', () => {
  for (const base of Object.values(BASES)) {
    for (const color of ['#ffd6ff', '#ffb703', '#000080', '#7c3aed']) {
      assert.ok(contrast(readableAccent(color, base), base.page) >= 4.5)
    }
  }
  assert.equal(readableAccent('#000080', BASES.light), '#000080')
})

test('properties come out per theme, and none without colours', () => {
  assert.equal(themeProperties({colors: []}), null)
  const properties = themeProperties({colors: ['#ff7a59'], angle: 90, strength: 1, grain: 0.2})
  assert.equal(properties['--custom-1'], '#ff7a59')
  assert.equal(properties['--custom-3'], '#ff7a59')
  assert.equal(properties['--custom-angle'], '90deg')
  assert.ok(Number(properties['--custom-strength-light']) <= 1)
  assert.ok(properties['--custom-accent-dark'].startsWith('#'))
})

test('a theme code round-trips, and anything else is refused', () => {
  const code = encodeThemeCode({look: 'glass', theme: {colors: ['#00b4d8', '#0077b6'], angle: 45, strength: 0.4, grain: 0}})
  assert.match(code, /^textarea-theme:[\w-]+$/)
  assert.deepEqual(decodeThemeCode(code), {
    look: 'glass',
    theme: {colors: ['#00b4d8', '#0077b6'], angle: 45, strength: 0.4, grain: 0},
  })
  assert.equal(decodeThemeCode('hello'), null)
  assert.equal(decodeThemeCode('textarea-theme:!!!'), null)
  const evil = 'textarea-theme:' + btoa(JSON.stringify({v: 1, look: '"><script>', colors: ['javascript:alert(1)']}))
  assert.deepEqual(decodeThemeCode(evil), {look: 'classic', theme: {colors: [], angle: 135, strength: 0.35, grain: 0.15}})
})

test('storage holds only what differs from the defaults', () => {
  const storage = memory()
  saveCustomization(storage, {look: 'classic', theme: {colors: []}, css: '  '})
  assert.equal(storage.data.size, 0)
  saveCustomization(storage, {look: 'win97', theme: {colors: ['#123456']}, css: 'article{color:red}'})
  assert.equal(storage.getItem(KEYS.look), 'win97')
  assert.deepEqual(readCustomization(storage).theme.colors, ['#123456'])
  assert.equal(readCustomization(storage).css, 'article{color:red}')
  saveCustomization(storage, {look: 'win97', theme: {colors: []}, css: 'x'.repeat(MAX_CSS + 50)})
  assert.equal(readCustomization(storage).css.length, MAX_CSS)
})

test('a storage that throws reads as the defaults', () => {
  const broken = {getItem: () => { throw new Error('no') }, setItem: () => { throw new Error('no') }, removeItem: () => {}}
  assert.deepEqual(readCustomization(broken), {look: 'classic', theme: {colors: [], angle: 135, strength: 0.35, grain: 0.15}, css: ''})
  assert.doesNotThrow(() => saveCustomization(broken, {look: 'xiao', theme: {}, css: ''}))
})
