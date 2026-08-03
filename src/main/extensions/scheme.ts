import { randomBytes } from 'crypto'
import { net, protocol } from 'electron'
import { realpath } from 'fs/promises'
import { extname, join, resolve as resolvePath, sep } from 'path'
import { pathToFileURL } from 'url'

import { isValidExtensionId } from '@shared/types/extensionId.js'
import { EXTENSIONS_DIR } from '@main/storage/paths.js'
import { buildFrameDocument, childFrameCsp } from '@main/extensions/frameDocument.js'
import { readLedger } from '@main/extensions/ledger.js'

export const EXTENSION_SCHEME = 'agent-code-ext'

// The reserved path that serves the sandbox frame HTML document rather than a
// bundle asset. An extension cannot ship a file at this path — it collides with
// nothing real because the `.` in a normal entry can never produce this exact
// name, and even if it did, this branch is checked first and serves the host's
// document, not the extension's file.
const RESERVED_FRAME_PATH = '__agent-code-frame__.html'

// Serving installed extension bundles to the renderer.
//
// WHY a custom scheme at all, rather than importing the file path directly:
// the renderer's CSP is `script-src 'self'` and its document origin differs
// between dev (http://localhost via ELECTRON_RENDERER_URL) and production
// (file:// via loadFile). A raw filesystem path is blocked in dev by the
// localhost origin and is a cross-origin file:// fetch in production — it
// cannot be made to work identically in both, which is exactly the trap this
// design exists to avoid. A registered scheme has ONE spelling that resolves
// the same way in both modes, and adding it to script-src is a single, narrow,
// auditable concession rather than relaxing the policy for everything.

/**
 * MUST be called at module scope, before `app.whenReady()`.
 *
 * Electron silently treats a scheme registered after ready as opaque — no
 * origin semantics, no secure context, no CORS handling. The resulting failure
 * surfaces in the renderer as a CSP or CORS error, which sends you looking at
 * index.html instead of at call ordering. There is no runtime warning for it,
 * so the ordering constraint lives here in a comment and in the call site.
 *
 * The privileges are each load-bearing:
 *
 *   standard        Gives the scheme real origin semantics, so a relative
 *                   specifier inside a bundle (`./util.js` beside `index.js`)
 *                   resolves. Without it every intra-extension import would
 *                   have to be an absolute agent-code-ext:// URL, which no
 *                   normal bundler emits.
 *   secure          Module scripts and most web APIs require a secure context.
 *                   Omitting this makes `import()` fail with an error that
 *                   does not mention security.
 *   supportFetchAPI Lets an extension fetch its own assets — JSON config, CSS,
 *                   an SVG sprite — through the same origin it was loaded from.
 *   corsEnabled     Module scripts are ALWAYS fetched in CORS mode, and
 *                   `standard: true` makes this a distinct origin from the
 *                   document. Without CORS handling every import fails.
 *   stream          Lets the handler return a streaming body instead of
 *                   buffering each asset in main.
 */
export function registerExtensionScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: EXTENSION_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ])
}

// Deliberately small and explicit rather than a mime lookup dependency. An
// extension bundle is JS plus a handful of asset kinds; anything unrecognised
// is served as a byte stream rather than guessed at, because a wrong
// `text/javascript` on a non-module would be worse than an honest download.
const CONTENT_TYPES: Record<string, string> = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
}

function contentTypeFor(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * Call after `app.whenReady()`, before the first window is created.
 *
 * URL shape: `agent-code-ext://<extensionId>/<path-inside-bundle>`
 */
/**
 * CORS for a bundle asset: the extension's own origin, or nothing.
 *
 * Returning an empty object (rather than a wildcard) is deliberate — absence of the
 * header is a closed door, and it keeps cross-extension reads from being a one-word
 * regression away.
 */
function corsHeadersFor(origin: string | null, extensionId: string): Record<string, string> {
  return origin && origin === `${EXTENSION_SCHEME}://${extensionId}`
    ? { 'access-control-allow-origin': origin }
    : {}
}

export function handleExtensionScheme(): void {
  protocol.handle(EXTENSION_SCHEME, async request => {
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return new Response('bad request', { status: 400 })
    }

    // ── VALIDATE THE ID BEFORE IT IS USED AS A PATH SEGMENT ──
    // `url.hostname` is attacker-chosen. It is joined onto EXTENSIONS_DIR below, and
    // the containment check further down resolves against a root DERIVED FROM THIS
    // VALUE — so if the id escapes, the check certifies the wrong root and approves
    // everything beneath it. A request for `agent-code-ext://../extension-grants.json`
    // yielded hostname `..`, rooting the handler at the whole state directory: grants,
    // the ledger, workspace.json, and the proxy dumps that contain provider
    // Authorization headers. Reachable from a Tier-0 extension that triggered no
    // consent dialog, since `connect-src agent-code-ext:` permits the request.
    //
    // This must be the FIRST thing the handler does. The shared validator is imported
    // rather than re-written: this file having no copy of the pattern, while four other
    // files had one, is precisely how the gap happened.
    const extensionId = url.hostname
    if (!isValidExtensionId(extensionId)) return new Response('not found', { status: 404 })

    // decodeURIComponent BEFORE the containment check, never after. A check
    // performed on the encoded form would pass `..%2f..%2f.ssh` — the segments
    // only look like traversal once decoded, and decoding afterwards would
    // reintroduce exactly what the check was meant to stop.
    let relative: string
    try {
      relative = decodeURIComponent(url.pathname).replace(/^\/+/, '')
    } catch {
      return new Response('bad request', { status: 400 })
    }

    // The sandbox frame document. Served BEFORE any file resolution, because it
    // is not a bundle file — it is the host's own locked-down HTML shell that
    // frames the extension. It embeds the extension's validated `entry` and a
    // per-load nonce, and carries a far stricter CSP than the host document.
    if (relative === RESERVED_FRAME_PATH) {
      const viewId = url.searchParams.get('view')
      const parentOrigin = url.searchParams.get('parentOrigin')
      if (!viewId || !parentOrigin) return new Response('bad request', { status: 400 })

      const record = (await readLedger()).find(row => row.manifest.id === extensionId)
      // A frame for an extension not in the ledger is a stale/removed reference;
      // 404 like a missing bundle rather than serving an empty shell.
      if (!record) return new Response('not found', { status: 404 })

      // The view id must be one this extension actually declares. It was previously
      // taken from the query string verbatim and interpolated into the frame document,
      // where it is an injection sink — and a persisted SessionMeta.extensionViewId is
      // attacker-influenced on the rehydrate path. Checking it against the manifest we
      // already hold costs one `.some()` and removes the sink's most reachable source.
      const declaresView = (record.manifest.contributes?.views ?? []).some(v => v.id === viewId)
      if (!declaresView) return new Response('bad request', { status: 400 })

      const nonce = randomBytes(16).toString('base64')
      const html = buildFrameDocument({
        extensionId,
        viewId,
        entry: record.manifest.entry,
        parentOrigin,
        nonce,
      })
      return new Response(html, {
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          // Both the meta tag inside the document AND this header carry the CSP,
          // with the same nonce. The header cannot be undone by a document.write,
          // so it is the authoritative copy.
          'content-security-policy': childFrameCsp(nonce, extensionId),
          'cache-control': 'no-cache',
        },
      })
    }

    // The id in the URL is a NAME, not authority — the same invariant
    // EditorFsRootRegistry enforces for filesystem roots. It names a candidate
    // directory; whether that directory is legitimate is decided by resolving
    // it against the install root and proving the result stayed inside.
    const root = join(EXTENSIONS_DIR, extensionId)

    let rootReal: string
    try {
      rootReal = await realpath(root)
    } catch {
      // Not installed, or the bundle directory was removed by hand. 404 rather
      // than 403: nothing was forbidden, there is simply nothing there.
      return new Response('not found', { status: 404 })
    }

    let targetReal: string
    try {
      targetReal = await realpath(resolvePath(rootReal, relative))
    } catch {
      return new Response('not found', { status: 404 })
    }

    // The containment check. This is the single most important line in the file.
    //
    // Install-time validation already proves the MANIFEST's entry stays inside
    // the bundle, but this handler serves arbitrary paths on demand, so it needs
    // its own check — and it must be realpath-based, because a symlink committed
    // to the repository survives extraction and points wherever it likes.
    // Without this, `agent-code-ext://x/../../../.ssh/id_rsa` reads an arbitrary
    // file through an origin the renderer is permitted to load SCRIPTS from,
    // which is the worst available combination in this app.
    //
    // The `+ sep` matters: a bare startsWith(rootReal) would accept a sibling
    // directory whose name merely shares the prefix (`extensions/timer-evil`
    // passes a startsWith check against `extensions/timer`).
    if (targetReal !== rootReal && !targetReal.startsWith(rootReal + sep)) {
      return new Response('forbidden', { status: 403 })
    }

    let fileResponse: Response
    try {
      fileResponse = await net.fetch(pathToFileURL(targetReal).toString())
    } catch {
      return new Response('not found', { status: 404 })
    }
    if (!fileResponse.ok || !fileResponse.body) {
      return new Response('not found', { status: 404 })
    }

    return new Response(fileResponse.body, {
      status: 200,
      headers: {
        'content-type': contentTypeFor(targetReal),
        // Required, and the single most likely thing to cost a day if omitted.
        // Module scripts are fetched in CORS mode, and `standard: true` makes
        // this a distinct origin from the document — so without an explicit
        // allow-origin header every `import()` fails with an opaque CORS error
        // that says nothing about the actual cause.
        //
        // ── NOT `*` ──
        // The old value was justified as "there is no ambient authority to leak: this
        // origin serves extension bundle files and nothing else". That is true of the
        // HOST, and false of a sibling EXTENSION: with `*`, extension A could
        // `fetch('agent-code-ext://b/index.js')` and read extension B's entire bundle.
        // Combined with the scheme-wide CSP source it also let A execute B's code.
        //
        // Echo the request Origin only when it is this extension's own origin. Any other
        // origin gets no CORS header at all, so the read fails closed. The host document
        // itself never fetches bundle assets — it only frames them — so it needs nothing
        // here.
        ...corsHeadersFor(request.headers.get('origin'), extensionId),
        // Bundles are replaced wholesale on update, and a stale cached module
        // after an update is a confusing, hard-to-diagnose bug class. Extensions
        // are local files; there is nothing to gain by caching them.
        'cache-control': 'no-cache',
      },
    })
  })
}
