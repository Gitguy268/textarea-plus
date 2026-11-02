// The inline icon symbols in index.html, checked against their sources.
//
// Most are Aiko's (github.com/tw93/aiko, MIT), pinned as the SHA-256 of their
// path data at commit 6ae2c093: a symbol re-drawn by hand, rescaled or swapped
// for a lookalike fails here, the same way the Material glyphs below do.
//
// The Material Symbols are copied out of google/material-design-icons and
// the check is byte for byte, because that is the only level at which the bug
// this test was written for is visible. All three glyphs at the time had been
// hand-rescaled
// from Google's 960-unit space into a 24-unit one, and the rescale mirrored the
// QR code and the trash can about the horizontal axis: finder patterns in the
// wrong corners, lid under the can. The shapes still looked plausible, so
// nothing caught it, and a test that only asked whether a path existed would
// not have caught it either.
//
// The expected strings below are Google's published `d` attributes, and the
// URLs say which file each came from. They are inlined rather than fetched so
// the suite needs no network; the cost is that they have to be re-copied by
// hand if Google ever redraws these icons.
//
// icon-save is not from Google. It is the tabler floppy this fork has always
// carried, checked for presence and for belonging to the tabler group's
// 24-unit box, which is what keeps the menu from drawing it at the wrong size.

import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import test from 'node:test'

const index = new URL('../../index.html', import.meta.url)

/** The raw source of one `<symbol>` element, or null when it is not there. */
function symbolSource(html, id) {
  return html.match(new RegExp(`<symbol id="${id}"[^>]*>[\\s\\S]*?</symbol>`))?.[0] ?? null
}

/** Every `d` attribute in a symbol, in order. */
function paths(source) {
  return [...source.matchAll(/\sd="([^"]+)"/g)].map((match) => match[1])
}

/** The `viewBox` of a symbol. */
function viewBox(source) {
  return source.match(/\sviewBox="([^"]+)"/)?.[1] ?? null
}

// github.com/google/material-design-icons, Apache-2.0. One file per entry.
const MATERIAL = [
  {
    id: 'icon-qr',
    file: 'symbols/web/qr_code/materialsymbolsoutlined/qr_code_24px.svg',
    d: 'M120-520v-320h320v320H120Zm80-80h160v-160H200v160Zm-80 480v-320h320v320H120Zm80-80h160v-160H200v160Zm320-320v-320h320v320H520Zm80-80h160v-160H600v160Zm160 480v-80h80v80h-80ZM520-360v-80h80v80h-80Zm80 80v-80h80v80h-80Zm-80 80v-80h80v80h-80Zm80 80v-80h80v80h-80Zm80-80v-80h80v80h-80Zm0-160v-80h80v80h-80Zm80 80v-80h80v80h-80Z',
  },
  {
    id: 'icon-water-drop',
    file: 'symbols/web/water_drop/materialsymbolsoutlined/water_drop_24px.svg',
    d: 'M491-200q12-1 20.5-9.5T520-230q0-14-9-22.5t-23-7.5q-41 3-87-22.5T343-375q-2-11-10.5-18t-19.5-7q-14 0-23 10.5t-6 24.5q17 91 80 130t127 35ZM480-80q-137 0-228.5-94T160-408q0-100 79.5-217.5T480-880q161 137 240.5 254.5T800-408q0 140-91.5 234T480-80Zm0-80q104 0 172-70.5T720-408q0-73-60.5-165T480-774Q361-665 300.5-573T240-408q0 107 68 177.5T480-160Zm0-320Z',
  },
]

// github.com/tw93/aiko, assets/icons.svg at 6ae2c093, MIT. `aiko` is the
// symbol id there and `name` what Aiko's own index calls it; the hash is of
// the symbol's `d` attributes in order, joined with newlines.
const AIKO = [
  {id: 'icon-plus', aiko: '6be74c', name: 'plus', viewBox: '0 0 20 20', sha256: '87e9660eb140b4324886827bf09aaa916de721dfa93f03c46c7c89ffd8d5ba36'},
  {id: 'icon-share', aiko: '455a38', name: 'share-network', viewBox: '0 0 20 20', sha256: '931326076c2dea715aa39aa9fe5127ab8c2e22fc587ccdca1e625add2e0fb678'},
  {id: 'icon-folder', aiko: '61ee0c', name: 'folder', viewBox: '0 0 20 20', sha256: '7f37fe66e40d8e98c8c2104e6fc79c575d0c870040143f111cd4a038c7fa0a72'},
  {id: 'icon-sync', aiko: 'ec66f0', name: 'refresh-cw', viewBox: '0 0 20 20', sha256: 'd1ce2019b21f5917f8f78a18712ab8d6f3920c465e1674b8041e8e19b36e2c05'},
  {id: 'icon-lock', aiko: '1f2234', name: 'lock', viewBox: '0 0 20 20', sha256: '36f3e35e351facf426efdd7eef3b48124d6ba58f4fdc18d27f78ea30ea4d78c9'},
  {id: 'icon-theme', aiko: 'fd4904', name: 'moon', viewBox: '0 0 20 20', sha256: 'bac817cacf96309ee596243b95e6f1e52dd58bc01954c721091f1b95a98a4361'},
  {id: 'icon-settings', aiko: '44c6db', name: 'settings', viewBox: '0 0 20 20', sha256: '58bd92fcff594ab06d39c90377f0c4b4e0c4022a668d3adc48edf01d7c5596ce'},
  {id: 'icon-backlinks', aiko: '5d1739', name: 'link', viewBox: '0 0 20 20', sha256: 'fc1ce41c501c382a661f0eb4c7732b618911f83a3c9a29290522bb126a0593e3'},
  {id: 'icon-writing', aiko: '6d87e1', name: 'pencil', viewBox: '0 0 20 20', sha256: '04bc60c33f735e23b855d116d964b92cc4f062f5e058f056f758fa269aa46156'},
  {id: 'icon-microphone', aiko: '29f921', name: 'mic', viewBox: '0 0 20 20', sha256: '6656a5ee61311cb28e3552a046e28687b9f4c667f8b1bbebc0911d7e0e2adca5'},
  {id: 'icon-task', aiko: '6e01b5', name: 'check-square', viewBox: '0 0 20 20', sha256: '5c19007c425cf4777b5bb2c43177fbde7cbc67258e76667e423bd0860fcde196'},
  {id: 'icon-download', aiko: '1a3695', name: 'download', viewBox: '0 0 20 20', sha256: '64b2141f7f6b865762bba7eb371815648ba37fda72b09e4e09774609b9bb1a0a'},
  {id: 'icon-copy', aiko: '817971', name: 'clipboard', viewBox: '0 0 20 20', sha256: '983e89c144ab69199d784dba7cbb12487c4fc3a6e960760fda6ebb01a17539e7'},
  {id: 'icon-list', aiko: '644ce5', name: 'list', viewBox: '0 0 20 20', sha256: 'ba62ac10649dc6176e1dabc4cd1e10ade75938c54633dbc0ab7bfedb28498d1e'},
  {id: 'icon-info', aiko: 'f5bdae', name: 'info-circle', viewBox: '0 0 20 20', sha256: 'ea7aa9c4ef44473ad43e677cd35f18c0c5ebc6bc30473fddb317ec6d07f74d19'},
  {id: 'icon-pin', aiko: '23d2ff', name: 'pin', viewBox: '0 0 20 20', sha256: 'bd1e77abbfbe32ef9fa4202b506308c13f345c5f81bc1c546de58e6d5f8017e4'},
  {id: 'icon-archive', aiko: 'f7f872', name: 'archive', viewBox: '0 0 20 20', sha256: 'c18fbd0ce3a14f796a3997808d390c842d98c380ea90bf89e155d32236b50107'},
  {id: 'icon-close', aiko: '85f94b', name: 'close', viewBox: '0 0 20 20', sha256: '7fb7ff38e6fd8d6f2ebc46557da9cb4149e37ef099cbc8196d2ce650f7756b0d'},
  {id: 'icon-delete', aiko: '3ee541', name: 'trash', viewBox: '0 0 20 20', sha256: '05a3ced654a401cd2f28f419f38207c83167d2e2177a0bb0702058b254003514'},
]

test("the Aiko icons are Aiko's paths, filled with the text colour", async () => {
  const html = await readFile(index, 'utf8')

  for (const {id, aiko, name, viewBox: box, sha256} of AIKO) {
    const source = symbolSource(html, id)
    assert.ok(source, `${id} should be defined in index.html`)
    const digest = createHash('sha256').update(paths(source).join('\n')).digest('hex')
    assert.equal(digest, sha256, `${id} should be Aiko's ${name} (${aiko}) path for path`)
    assert.equal(viewBox(source), box, `${id} should keep Aiko's viewBox`)
    assert.match(source, /\sfill="currentColor"/, `${id} should fill with the text colour`)
    assert.match(source, /\sstroke="none"/, `${id} should not stroke: these are fill glyphs`)
  }
})

// Google's own coordinate space: x across 0..960, y up from -960 to 0.
const GOOGLE_VIEWBOX = '0 -960 960 960'

test("the Material Symbols are Google's paths, not a rescale of them", async () => {
  const html = await readFile(index, 'utf8')

  for (const {id, file, d} of MATERIAL) {
    const source = symbolSource(html, id)
    assert.ok(source, `${id} should be defined in index.html`)

    // Exactly one path: a second means the symbol was rebuilt rather than
    // copied, which is how the mirror got in.
    const drawn = paths(source)
    assert.equal(drawn.length, 1, `${id} should be a single path (${file})`)
    assert.equal(drawn[0], d, `${id} should match ${file} byte for byte`)

    assert.equal(viewBox(source), GOOGLE_VIEWBOX, `${id} should keep Google's viewBox`)
    assert.match(source, /\sfill="currentColor"/, `${id} should fill with the text colour`)
    assert.match(source, /\sstroke="none"/, `${id} should not stroke: these are fill glyphs`)
  }
})

test('the QR code has its three finder patterns where Google puts them', async () => {
  // The geometric statement of the same thing, so a failure says what is wrong
  // rather than only that two strings differ. Google draws the three big
  // squares at top-left, top-right and bottom-left, with the small modules in
  // the bottom-right quadrant. A vertical mirror puts the third square at the
  // bottom-right and moves the modules up, which is what the bug did.
  const html = await readFile(index, 'utf8')
  const source = symbolSource(html, 'icon-qr')
  assert.ok(source, 'icon-qr should be defined')

  const finder = rectangles(paths(source)[0])
    // Google's squares are 320 units on a side; the modules are 80.
    .filter(([x0, y0, x1, y1]) => x1 - x0 >= 300 && y1 - y0 >= 300)
    // y grows upward in Google's space, so a negative centre is the top half.
    .map(([x0, y0, x1, y1]) => {
      const right = (x0 + x1) / 2 > 480
      const bottom = (y0 + y1) / 2 > -480
      return `${bottom ? 'bottom' : 'top'}-${right ? 'right' : 'left'}`
    })
    .sort()

  assert.deepEqual(
    finder,
    ['bottom-left', 'top-left', 'top-right'],
    'the three finder patterns should be at top-left, top-right and bottom-left',
  )
})

test('the save icon is present and stays in the tabler 24-unit box', async () => {
  const html = await readFile(index, 'utf8')
  const source = symbolSource(html, 'icon-save')
  assert.ok(source, 'icon-save should be defined in index.html')

  assert.equal(viewBox(source), '0 0 24 24', 'the floppy belongs to the tabler group')
  assert.match(source, /stroke-width="1\.25"/, 'the tabler group draws at 1.25')
  assert.match(source, /stroke="currentColor"/, 'the tabler group strokes with the text colour')

  const drawn = paths(source)
  assert.ok(drawn.length > 1, 'the floppy is drawn, not left as one blank path')
  assert.ok(
    drawn.some((d) => d.startsWith('M6 4h10l4 4')),
    "the floppy's outline should still be the one this fork has always drawn",
  )
})

/**
 * Every closed axis-aligned rectangle in a path, as [x0, y0, x1, y1].
 *
 * Only the commands the QR glyph is built from are handled: absolute and
 * relative moves, horizontal and vertical lines, and close. Anything else
 * throws rather than silently dropping a shape, because a shape dropped here
 * would make the quadrant assertion pass for the wrong reason.
 */
function rectangles(d) {
  const tokens = d.match(/[MmZzVvHh]|-?\d*\.?\d+/g) ?? []
  const out = []
  let at = 0
  let x = 0
  let y = 0
  let startX = 0
  let startY = 0
  let command = null
  let points = []

  const close = () => {
    if (points.length >= 3) {
      const xs = points.map(([px]) => px)
      const ys = points.map(([, py]) => py)
      out.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)])
    }
    points = []
  }

  while (at < tokens.length) {
    const token = tokens[at]
    if (/[A-Za-z]/.test(token)) {
      command = token
      at++
      if (command === 'Z' || command === 'z') {
        close()
        x = startX
        y = startY
      }
      continue
    }

    const n = Number(tokens[at++])
    if (command === 'M') {
      close()
      x = n
      y = Number(tokens[at++])
      startX = x
      startY = y
      command = 'L'
      points = [[x, y]]
    } else if (command === 'm') {
      close()
      x += n
      y += Number(tokens[at++])
      startX = x
      startY = y
      command = 'l'
      points = [[x, y]]
    } else if (command === 'v') {
      y += n
      points.push([x, y])
    } else if (command === 'V') {
      y = n
      points.push([x, y])
    } else if (command === 'h') {
      x += n
      points.push([x, y])
    } else if (command === 'H') {
      x = n
      points.push([x, y])
    } else {
      throw new Error(`unhandled path command ${JSON.stringify(command)} in ${d}`)
    }
  }

  close()
  return out
}
