// The HTML document a sandboxed extension frame loads (WS4, Decision A).
//
// The scheme handler serves this for the reserved path `__agent-code-frame__.html`.
// It is a DISTINCT document, at the extension's own origin, framed by the host — so
// it cannot reach `window.api`, the parent DOM, or another extension. Its only
// channel is postMessage to `window.parent`, brokered by frameHost.ts.
//
// WHY generated in main rather than shipped as a static file: the document embeds
// the extension's own `entry` path (from its validated manifest) and a per-load
// nonce, neither of which a static file can carry. `entry` has already passed the
// manifest's path refinements + install-time realpath containment, so it is safe to
// interpolate; it is JSON-encoded here anyway as defence in depth.
//
// RUNTIME NOTE: the bootstrap below is the one part of WS4 that cannot be
// type-checked into correctness — it runs only inside a live frame. It is
// deliberately minimal (Tier-0 API proxy + activate + mount) and converges with the
// SDK's child runtime (WS8); treat a real in-frame load as its acceptance test.

export type FrameDocumentInput = {
  /** The contributed view id to mount once the parent sends the mount message. */
  viewId: string
  /** The manifest `entry`, relative to the bundle root (already path-validated). */
  entry: string
  /** The parent (host) document origin, so the child posts replies only to it. */
  parentOrigin: string
  /** Per-load nonce authorizing exactly the one inline bootstrap script. */
  nonce: string
}

/**
 * The child Content-Security-Policy — far stricter than the host's.
 *
 * `default-src 'none'` denies everything not re-granted below. Scripts are limited
 * to the extension's own origin plus the single nonced inline bootstrap (no
 * 'unsafe-inline', so injected script cannot run). There is NO `connect-src` beyond
 * the origin and NO `frame-src`: a sandboxed extension cannot open sockets to the
 * network or nest further frames. Styles/img/font allow the extension's own assets
 * and inline styles (canvas/React need them); that is the widest concession.
 */
export function childFrameCsp(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'self' agent-code-ext: 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline' agent-code-ext:",
    'img-src agent-code-ext: data: blob:',
    'font-src agent-code-ext: data:',
    "connect-src 'self' agent-code-ext:",
  ].join('; ')
}

export function buildFrameDocument(input: FrameDocumentInput): string {
  const { viewId, entry, parentOrigin, nonce } = input
  // The bootstrap. Everything the child needs to (a) expose a Tier-0 API that
  // proxies to the parent over postMessage, (b) import and activate the extension,
  // (c) mount its view on the parent's signal. Kept in one nonced module.
  const bootstrap = `
const PARENT_ORIGIN = ${JSON.stringify(parentOrigin)};
const VIEW_ID = ${JSON.stringify(viewId)};
const ENTRY = ${JSON.stringify(entry)};

// Correlate replies to requests over the single channel to the parent.
let seq = 0;
const pending = new Map();
window.addEventListener('message', (event) => {
  // Authenticate the SENDER by window reference, not by origin string. When the
  // host renderer is loaded from file:// (the packaged/preview build), its origin
  // is opaque: a message it posts arrives here with event.origin === "null" (or a
  // non-matching serialization), so an === PARENT_ORIGIN check silently drops
  // every reply and mount signal — the view then never mounts and there is no
  // error anywhere. event.source is a live WindowProxy the child cannot forge and
  // the browser never rewrites, so it holds across every origin quirk. This is the
  // exact mirror of frameHost.ts's inbound gate (event.source === iframe.contentWindow).
  if (event.source !== window.parent) return;
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;
  if (msg.kind === 'agent-code-ext:reply') {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result); else p.reject(new Error(msg.error));
  } else if (msg.kind === 'agent-code-ext:mount') {
    mountView(msg.viewId);
  } else if (msg.kind === 'agent-code-ext:theme') {
    for (const [name, value] of Object.entries(msg.tokens || {})) {
      document.documentElement.style.setProperty(name, value);
    }
  } else if (msg.kind === 'agent-code-ext:command') {
    // Invoke a contributed command's handler, registered by the extension in
    // activate() via context.registerCommand. This is the whole point of unifying
    // activation onto the frame: the handler runs HERE, against the same engine the
    // view shows, not a second host-realm instance. A missing handler is silent —
    // an "open my view" command is routed by the host and never dispatched here.
    const handler = commands.get(msg.commandId);
    if (handler) {
      try {
        Promise.resolve(handler()).catch((e) => console.error('[extension] command failed:', msg.commandId, e));
      } catch (e) {
        console.error('[extension] command failed:', msg.commandId, e);
      }
    }
  } else if (msg.kind === 'agent-code-ext:event') {
    // A change nudge for a Tier-1 observe topic. Fan out to registered listeners;
    // each typically re-reads via observe(). Snapshot the set before iterating so a
    // listener that unsubscribes mid-notify does not skip a sibling.
    const set = eventListeners.get(msg.topic);
    if (set) {
      for (const cb of Array.from(set)) {
        try { cb(); } catch (e) { console.error('[extension] observe listener failed:', msg.topic, e); }
      }
    }
  }
});

function request(method, extra) {
  const id = 'q' + (++seq);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    // targetOrigin '*' rather than PARENT_ORIGIN: a file:// parent's origin does
    // not reliably match a specific-string targetOrigin, so pinning it to
    // "file://" makes the browser refuse to deliver the request and activate()
    // hangs on its first storage read. This is safe because the message is sent to
    // window.parent EXPLICITLY (only the host receives it — the child CSP forbids
    // nested frames, so there is no other embedder) and the requests carry no host
    // secrets; the host's frameHost re-authenticates every request by the child's
    // own unforgeable agent-code-ext://<id> origin before performing it.
    window.parent.postMessage(
      { kind: 'agent-code-ext:request', id, request: Object.assign({ method }, extra) },
      '*',
    );
  });
}

// The Tier-0 AgentCodeApiV1, proxied. Same method names as the same-realm object.
const api = {
  // id from the frame's own origin host (agent-code-ext://<id>) — unforgeable and
  // exactly the id the host attributes this frame to. AgentCodeApiV1 promises it;
  // the same-realm createAppHostApi already provided it, this closes the frame gap.
  extension: { id: location.hostname, apiVersion: 1 },
  storage: {
    get: (key) => request('storage.get', { key }),
    set: (key, value) => request('storage.set', { key, value }),
    delete: (key) => request('storage.delete', { key }),
    keys: () => request('storage.keys', {}),
  },
  ui: {
    close: () => request('ui.close', {}),
    showToast: (message) => request('ui.showToast', { message }),
  },
  theme: { tokens: () => request('theme.tokens', {}) },
  // Tier-1 observe. The host broker gates each on the extension's grant, so a call
  // here rejects if the capability was not consented to at install. subscribe() is
  // local: it registers a listener the host wakes with a change nudge (the extension
  // then re-reads via observe). Returns an unsubscribe, matching AgentCodeApiV1.
  workspace: { observe: () => request('workspace.observe', {}), subscribe: (cb) => subscribeTopic('workspace', cb) },
  sessions: { observe: () => request('sessions.observe', {}), subscribe: (cb) => subscribeTopic('sessions', cb) },
  panes: { observe: () => request('panes.observe', {}), subscribe: (cb) => subscribeTopic('panes', cb) },
};

// Listeners for host-pushed change nudges (Tier-1 observe live updates), keyed by
// topic. A function declaration so the api object above can reference it regardless
// of source order; it is only ever CALLED at runtime, after the whole bootstrap ran.
const eventListeners = new Map();
function subscribeTopic(topic, cb) {
  let set = eventListeners.get(topic);
  if (!set) { set = new Set(); eventListeners.set(topic, set); }
  set.add(cb);
  return function () { set.delete(cb); };
}

const views = new Map();
const commands = new Map();
const subscriptions = [];
const context = {
  api,
  // Real now (was a no-op). Handlers are invoked by the host's 'command' push
  // above — the frame is the ONE place an extension's command runs, so its
  // handlers must actually be kept.
  registerCommand: (id, run) => { commands.set(id, run); return { dispose() { commands.delete(id); } }; },
  registerView: (id, mount) => { views.set(id, mount); return { dispose() { views.delete(id); } }; },
  subscriptions,
};

// Report the mounted view's natural content height to the parent, which sizes
// the iframe (and therefore the host modal) to it. Without this the iframe has no
// definite height to give an 'height:100%' child, so it collapses to the host's
// minimum and a taller extension is clipped. #root is height:auto (see the child
// CSS), so scrollHeight is the CONTENT height, and growing the iframe never
// changes it — so the ResizeObserver below cannot enter a resize feedback loop.
function reportSize() {
  const root = document.getElementById('root');
  if (!root) return;
  // scrollHeight/scrollWidth capture the CONTENT extent even when #root itself is
  // width:100% of a smaller iframe — a fixed-width extension (a game canvas) overflows
  // and its true width is reported, so the host can grow the modal to fit it.
  const height = root.scrollHeight;
  const width = root.scrollWidth;
  if (height > 0) window.parent.postMessage({ kind: 'agent-code-ext:resize', height: height, width: width }, '*');
}

let mounted = false;
function mountView(viewId) {
  if (mounted) return;
  const mount = views.get(viewId);
  if (!mount) return;
  mounted = true;
  const root = document.getElementById('root');
  if (!root) return;
  mount(root);
  // Report once now, then on every content change (a picker expands, digits
  // reflow), so the modal tracks the view instead of freezing at first paint.
  reportSize();
  if (typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver(function () { reportSize(); });
    observer.observe(root);
  }
}

// Import, activate, mount, then announce readiness.
let extensionModule = null;
import('./' + ENTRY)
  .then((mod) => { extensionModule = mod; return mod.activate(context); })
  .then(() => {
    mountView(VIEW_ID);
    // Signal the host that activate() has resolved — meaning registerCommand() has
    // run and command handlers exist. The host registers this frame's command
    // dispatcher on this signal and flushes any command queued while the view was
    // closed, so a flushed command can never arrive before its handler is registered.
    window.parent.postMessage({ kind: 'agent-code-ext:ready' }, '*');
  })
  .catch((error) => {
    const root = document.getElementById('root');
    if (root) root.textContent = 'Extension failed to load: ' + (error && error.message || error);
  });

// Run the extension's cleanup when the frame is torn down. The host closes a view
// by navigating the iframe to about:blank (viewBridge), which fires pagehide on
// this document; app quit fires it too. Mirrors the same-realm host's deactivate:
// call the module's deactivate(), THEN dispose registrations in reverse order (so a
// later subscription built on an earlier one tears down first). Best-effort and
// synchronous — the document is going away, so async cleanup cannot be awaited; the
// timer's engine.dispose()/removeStyles() are exactly this shape. Without this an
// extension leaks its intervals/AudioContext/listeners every time its view closes.
window.addEventListener('pagehide', () => {
  try {
    if (extensionModule && typeof extensionModule.deactivate === 'function') extensionModule.deactivate();
  } catch (e) {
    console.error('[extension] deactivate failed:', e);
  }
  for (const sub of subscriptions.slice().reverse()) {
    try { sub.dispose(); } catch (e) { /* one bad disposer must not strand the rest */ }
  }
});
`.trim()

  return [
    '<!doctype html>',
    '<html>',
    '<head>',
    '<meta charset="utf-8" />',
    `<meta http-equiv="Content-Security-Policy" content="${childFrameCsp(nonce)}" />`,
    // #root is width:100% but height:AUTO on purpose: it sizes to the extension's
    // content, which reportSize() measures and the host uses to size the iframe.
    // A height:100% here would make #root track the (initially collapsed) iframe
    // instead, and the content-height signal would always read the clamp.
    //
    // overflow:hidden kills the frame's OWN scrollbars. The host already sizes the
    // iframe to the reported content height, so there is nothing legitimate to
    // scroll — but a view whose background bleeds a pixel past the edge (the timer
    // uses margin:-1px to reach the modal corners) would otherwise raise a stray
    // horizontal bar, which then steals height and raises a vertical one too. The
    // measurement reads #root.scrollHeight, which is unaffected by this.
    '<style>html,body{margin:0;width:100%;overflow:hidden}#root{width:100%}</style>',
    '</head>',
    '<body>',
    '<div id="root"></div>',
    `<script type="module" nonce="${nonce}">${bootstrap}</script>`,
    '</body>',
    '</html>',
  ].join('\n')
}
