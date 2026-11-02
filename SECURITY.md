# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for anything that looks like a security
problem.** Open an issue for ordinary bugs; a public issue is the wrong place for
a flaw that someone else can use first.

Email **[private vulnerability reporting](https://github.com/Gitguy268/textarea-plus/security/advisories/new)** with:

- what the problem is, in one or two sentences
- the version, which for this project is the commit SHA or the `sw.js` cache
  version (`VERSION` in that file is bumped whenever the shell changes)
- the browser, version and operating system
- the smallest set of steps that reproduces it, or a note, a file or a URL that
  triggers it

If you prefer, GitHub's private vulnerability reporting is enabled on the
repository under **Security**. Either route reaches the same person.

You should get an acknowledgement within three days and an assessment within a
week. If something needs longer, that will be said rather than left silent.

Please give reasonable time for a fix to be published before disclosing it
publicly. There is no bug bounty and no paid support here, so the offer is
honest rather than contractual.

## What is in scope

This is a static page. There is no server, no account and no database on the far
end, which removes most of the usual attack surface and makes the interesting
questions local ones:

- Anything that lets a note leave the browser without the reader asking. The app
  makes no network request carrying note content, and the document library,
  IndexedDB and `localStorage`, are all local. Folder sync is the one feature
  that writes outside the browser: it writes only into the folder the reader
  picked, and it never removes a file it has no manifest entry for. A change
  that widens either of those, or that introduces a request, should be treated
  as a security change.
- Anything that lets one note overwrite or read another within the same origin.
  Two tabs are meant to stay separate; the in-memory row tracking in `lib/note.js` is
  what keeps that true.
- Anything that makes encryption weaker than it claims: a reduced PBKDF2
  iteration count, an unencrypted fallback, a password written to storage or a
  log, or a change in the ZIP AE-2 output that other tools can no longer open.
- Anything that makes a file read from disk do more than read. Opening a PDF,
  ZIP or text file renders untrusted bytes, and the parsers are the risk.
- Cross-origin script execution, or the service worker serving one origin's
  cached shell to another.
- Anything that lets audio leave the browser, or keeps the microphone open
  unasked. Speech to text asks for the microphone only when Record is pressed,
  lets go of it on Stop or when its panel closes, and transcribes on this
  device; `Permissions-Policy` grants the microphone to this origin and no
  other device to anyone.

## What is out of scope

- **A lost password.** There is no recovery, by design. The format does not permit
  it and no backdoor is wanted.
- **Reading a note from someone else's browser.** The document library is
  per-origin and per-profile. It is not encrypted at rest, because it is the
  browser's own storage; anyone with access to the unlocked profile and DevTools
  can read it. That is true of every offline app and is not a vulnerability here.
- **Notes left in the URL.** A note is in the address bar and in browser history
  and in anything that reads the address bar. The QR code and the shared link both
  carry whatever the hash carries, which is why the encrypted-link option exists.
- **Plaintext files in a synced folder.** Folder sync writes markdown files into
  a folder the reader picked, unencrypted, because that is what makes them
  editable in any other program. Anything with access to the folder can read
  them, exactly as anything with access to the unlocked profile can read the
  library above. The files are as local as the browser's own storage.
- **Denial of service through one's own machine**, such as a note large enough to
  make the page slow. The editor already warns about URL length.
- Vulnerabilities in the vendored libraries as such. [pdf.js][pdfjs],
  [zip.js][zipjs] and [qrcode-generator][qr] are pinned in `vendor/` with their
  licences and version tables. A flaw in one of them is still worth reporting;
  report it to that project too, and mention it here so the pin gets looked at.

## Supported versions

The app is one page, so "versions" means the branch.

| Version | Supported |
|---|---|
| `main` | Yes |
| Anything older than the latest release on `main` | No — update |

There is no long-term-support branch. If something needs to work on an old
version, that is worth raising as a discussion before it needs fixing.

## Cryptography in use

Worth stating plainly, because "it uses AES-256" is a claim people repeat without
checking what it is applied to:

| | |
|---|---|
| Hash codec | deflate-raw, then base64url. **Not** encryption. |
| Encrypted link | AES-256-GCM, key from PBKDF2-HMAC-SHA256 at 210,000 iterations, 16-byte salt, 12-byte IV, 16-byte tag |
| Encrypted ZIP | WinZip AES AE-2, AES-256, via zip.js |
| QR code | No cryptography. The symbol carries the link in the clear. |

The PBKDF2 iteration count is in `DEFAULT_ITERATIONS` in `lib/share.js`, and
`MAX_ITERATIONS` caps what a hostile link may ask for so it cannot hang the tab.
Both are load-bearing; changing either is a security-relevant change.

[pdfjs]: https://github.com/mozilla/pdf.js
[zipjs]: https://github.com/gildas-lormeau/zip.js
[qr]: https://github.com/kazuhikoarase/qrcode-generator
