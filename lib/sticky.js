// The sticky note: the note itself in a small square window that stays on
// top of every other window, for jotting while working somewhere else.
//
// It is the same editor, not a copy. Document Picture-in-Picture lets a page
// move its own elements into the always-on-top window, so the <article> is
// moved there and moved back when the window closes: one note, one save path,
// nothing to keep in step. The API is Chromium's (Chrome, Edge, Brave), so
// the switch is offered only where it exists: menu.js and settings-rows.js
// test for `documentPictureInPicture` themselves, keeping this file off the boot.
//
// Shared, byte for byte, by textarea-master and textarea-master-claude.

/** The window's side, in CSS pixels: square, and small. */
export const STICKY_SIDE = 260

let open = null

/**
 * Open the note in a sticky window, or bring the open one forward.
 *
 * @param {HTMLElement} article the editor
 * @returns {Promise<void>}
 */
export async function openSticky(article) {
  if (open) {
    open.focus()
    return
  }
  const pip = await globalThis.documentPictureInPicture.requestWindow({width: STICKY_SIDE, height: STICKY_SIDE})
  open = pip
  const doc = pip.document

  // The page's styles and theme, so the note looks like itself over there.
  for (const sheet of document.querySelectorAll('style, link[rel="stylesheet"]')) doc.head.append(sheet.cloneNode(true))
  for (const {name, value} of document.documentElement.attributes) doc.documentElement.setAttribute(name, value)
  doc.documentElement.classList.add('sticky')
  doc.title = 'Sticky note'

  const placeholder = document.createComment('sticky note')
  article.replaceWith(placeholder)
  doc.body.append(article)
  article.focus()

  pip.addEventListener('pagehide', () => {
    placeholder.replaceWith(article)
    open = null
  })
}
