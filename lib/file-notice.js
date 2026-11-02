// The one script that runs when index.html is opened straight from disk.
//
// A classic script, not a module, and loaded on its own for that reason: from
// a file:// address the browser refuses ES modules, workers and the service
// worker, so app.js never starts and the page is a bare textarea with no menu,
// no saving and no speech to text. This says so, and says what to do instead.
// Served over http it does nothing at all.

if (location.protocol === 'file:') {
  addEventListener('DOMContentLoaded', () => {
    const notice = document.createElement('p')
    notice.setAttribute('role', 'alert')
    notice.style.cssText =
      'position:fixed;inset:16px 16px auto;z-index:1000;margin:0;padding:12px 16px;border-radius:10px;' +
      'font:15px/1.4 system-ui,sans-serif;background:#fff4d6;color:#3b2a00;box-shadow:0 2px 12px rgb(0 0 0/.15)'
    notice.textContent =
      'This page was opened as a file, so the editor cannot start. Close it and double-click ' +
      'start.command in this folder instead (or run npm run serve and open the address it prints).'
    document.body.prepend(notice)
  })
}
