// Every link that stays inside this repository, checked without a network.
//
// CI runs lychee over the external URLs, but from outside it cannot see
// whether a relative link still lands on a file, whether an anchor still
// lands on a heading, or whether the shell, the manifest and the crawler
// files promise paths that are really here. Those break quietly: a renamed
// document 404s only for the reader who follows the link, and the service
// worker will happily precache a path that stopped existing.

import assert from 'node:assert/strict'
import {readFile, readdir, stat} from 'node:fs/promises'
import test from 'node:test'

const read = (name) => readFile(new URL(`../../${name}`, import.meta.url), 'utf8')

const exists = (name) =>
  stat(new URL(`../../${name}`, import.meta.url)).then(
    () => true,
    () => false,
  )

/** Links out of a markdown file, with code examples removed first. */
const linksIn = (markdown) => {
  const prose = markdown.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '')
  return [...prose.matchAll(/!?\[[^\]]*\]\(([^)\s]+)\)/g)].map((match) => match[1])
}

const isExternal = (url) => /^(https?:|mailto:|data:|javascript:)/.test(url)

/** GitHub's heading slug: lowercase, punctuation gone, spaces to hyphens. */
const slug = (heading) =>
  heading
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')

const headingSlugs = (markdown) =>
  new Set([...markdown.matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) => slug(match[1])))

const DOCS = ['README.md', 'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md', 'SECURITY.md', 'CHANGELOG.md']

test('every relative link in the documentation lands on a file', async () => {
  for (const doc of DOCS) {
    const text = await read(doc)
    for (const link of linksIn(text)) {
      if (isExternal(link) || link.startsWith('#')) continue
      const [path] = link.split('#')
      assert.ok(await exists(path), `${doc} links at ${link}, which is not in the repository`)
    }
  }
})

test('every anchor lands on a heading', async () => {
  for (const doc of DOCS) {
    const text = await read(doc)
    const anchors = linksIn(text).filter((link) => link.includes('#') && !isExternal(link))
    for (const target of anchors) {
      const [path, anchor] = target.split('#')
      const source = path ? await read(path) : text
      assert.ok(
        headingSlugs(source).has(anchor),
        `${doc} links at ${target}, which is not a heading in ${path || doc}`,
      )
    }
  }
})

test('every relative URL in the pages lands on a file', async () => {
  for (const page of ['index.html', '404.html']) {
    const html = await read(page)
    const urls = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((match) => match[1])
    for (const url of urls) {
      if (isExternal(url) || url.startsWith('#')) continue
      // A leading slash is the deployed site, whose root is the index page.
      const path = url.startsWith('/') ? (url === '/' ? 'index.html' : url.slice(1)) : url
      assert.ok(await exists(path), `${page} references ${url}, which is not in the repository`)
    }
  }
})

test('every icon the page uses is defined by a symbol', async () => {
  const html = await read('index.html')
  const used = [...html.matchAll(/xlink:href="#([^"]+)"/g)].map((match) => match[1])
  assert.ok(used.length > 0, 'the page should be using the inline icon symbols')
  const defined = new Set([...html.matchAll(/<symbol id="([^"]+)"/g)].map((match) => match[1]))
  for (const id of used) {
    assert.ok(defined.has(id), `index.html uses #${id}, which no <symbol> defines`)
  }
})

test('the service worker precaches files that exist', async () => {
  const sw = await read('sw.js')
  const list = /const SHELL = \[([\s\S]*?)\]/.exec(sw)
  assert.ok(list, 'sw.js declares a SHELL list')
  const paths = [...list[1].matchAll(/'([^']+)'/g)].map((match) => match[1])
  assert.ok(paths.length > 0, 'the shell list should not be empty')

  for (const path of paths) {
    const file = path === '/' ? 'index.html' : path.slice(1)
    assert.ok(await exists(file), `sw.js precaches ${path}, which is not in the repository`)
  }

  // The reverse is the bug that ships: a module added to lib/ but left out of
  // SHELL loads online and 404s in a cached tab, which nobody sees until they
  // go offline.
  const precached = new Set(paths)
  for (const name of await readdir(new URL('../../lib', import.meta.url))) {
    assert.ok(
      precached.has(`/lib/${name}`),
      `lib/${name} is not precached, so the app would break offline`,
    )
  }
})

test('the manifest points at icons that exist', async () => {
  const manifest = JSON.parse(await read('manifest.json'))
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length > 0, 'the manifest has icons')
  for (const icon of manifest.icons) {
    assert.ok(await exists(icon.src), `manifest.json names ${icon.src}, which is not here`)
  }
})

test('robots.txt, sitemap.xml and llms.txt name the same deployed site', async () => {
  const robots = await read('robots.txt')
  const listed = /Sitemap:\s*(\S+)/.exec(robots)
  assert.ok(listed, 'robots.txt tells a crawler where the sitemap is')

  const sitemapUrl = new URL(listed[1])
  assert.equal(sitemapUrl.pathname, '/sitemap.xml', 'the sitemap is served from the site root')
  assert.ok(await exists('sitemap.xml'), 'robots.txt points at a sitemap this repository lacks')

  const xml = await read('sitemap.xml')
  const loc = /<loc>([^<]+)<\/loc>/.exec(xml)
  assert.ok(loc, 'the sitemap says where the site lives')
  const site = new URL(loc[1])
  assert.equal(site.origin, sitemapUrl.origin, 'robots.txt and sitemap.xml disagree on the domain')

  // llms.txt sends agents to the same deployment under a different name, so a
  // domain change made in one file and not the others would strand readers.
  const app = /- \[The app\]\(([^)]+)\)/.exec(await read('llms.txt'))
  assert.ok(app, 'llms.txt links the deployed app')
  assert.equal(
    new URL(app[1]).origin,
    site.origin,
    'llms.txt, robots.txt and sitemap.xml disagree on the deployed domain',
  )
})
