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
  /** The extension this frame belongs to. Already validated by the scheme handler —
   *  used to build a per-ORIGIN CSP rather than a per-scheme one (see childFrameCsp). */
  extensionId: string
  /** The contributed view id to mount once the parent sends the mount message. */
  viewId: string
  /** The manifest `entry`, relative to the bundle root (already path-validated). */
  entry: string
  /** Contributed command ids from the manifest. The frame refuses to register a
   *  handler for anything outside this list — see assertDeclared in the bootstrap. */
  declaredCommands: string[]
  /** Contributed view ids, same contract. */
  declaredViews: string[]
  /** Per-load nonce authorizing exactly the one inline bootstrap script. */
  nonce: string
}

/**
 * The child Content-Security-Policy — far stricter than the host's.
 *
 * ── PER-ORIGIN, NOT PER-SCHEME ──
 * Every source below names THIS extension's origin explicitly. The previous version
 * used the bare `agent-code-ext:` scheme-source, which matches
 * `agent-code-ext://<any-other-id>` — and since `'self'` already covers the document's
 * own origin, the bare scheme granted ONLY the cross-extension case. Extension A could
 * fetch and, worse, `<script src>`-execute extension B's bundle. That is what turned
 * an HTML-injection bug into arbitrary code execution across extension identities.
 *
 * `base-uri` and `form-action` are listed explicitly because NEITHER falls back to
 * `default-src`. Without `base-uri 'none'`, an injected `<base>` repoints the
 * bootstrap's relative `import()`; without `form-action 'none'`, a form can POST to
 * any origin — an egress channel the connect-src restriction does not cover.
 *
 * Note what CSP still cannot do: it has no directive governing `window.open`
 * (`navigate-to` was never shipped). That hole is closed by the iframe's `sandbox`
 * attribute in viewBridge.tsx, not here.
 *
 * ── WHY THERE IS NO `frame-ancestors` ──
 * Genuinely absent, not overlooked. It would name who may EMBED this document, and
 * no value expresses "the Agent Code renderer": the host origin is
 * `http://localhost:<port>` in dev and an opaque `file://` in production, so any
 * literal list is either wrong in one mode or so wide it asserts nothing. (It also
 * only takes effect as a response header — the meta form is ignored — so writing it
 * into the document would silently do nothing.)
 *
 * What actually prevents cross-embedding is `default-src 'none'`: `frame-src` and
 * `child-src` both fall back to it, so no extension frame can create a nested frame,
 * and one extension therefore cannot embed another's view. The only embedder that
 * exists is the host, which is trusted. If the host ever gains a stable origin, add
 * the header — until then this is the record that the absence was reasoned about.
 */
export function childFrameCsp(nonce: string, extensionId: string): string {
  const self = `agent-code-ext://${extensionId}`
  return [
    "default-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    `script-src '${`nonce-${nonce}`}' ${self}`,
    `style-src 'unsafe-inline' ${self}`,
    `img-src ${self} data: blob:`,
    `font-src ${self} data:`,
    `connect-src ${self}`,
  ].join('; ')
}

export function buildFrameDocument(input: FrameDocumentInput): string {
  const { extensionId, viewId, entry, declaredCommands, declaredViews, nonce } = input
  // The bootstrap. Everything the child needs to (a) expose a Tier-0 API that
  // proxies to the parent over postMessage, (b) import and activate the extension,
  // (c) mount its view on the parent's signal. Kept in one nonced module.
  const bootstrap = `
// ── CONFIG COMES FROM A JSON BLOCK, NOT FROM INTERPOLATED JS ──
// These values used to be spliced straight into this script as
// \`const VIEW_ID = \${JSON.stringify(viewId)}\`. JSON.stringify escapes quotes and
// backslashes but NOT \`<\` or \`/\`, so a value carrying a script CLOSING TAG ended
// this element from inside a string literal and everything after it became markup.
// The entry path passed all four of the manifest's negative refinements with that
// payload embedded, and viewId was taken from the query string unchecked.
//
// Parsing a JSON island removes the sink entirely: a closing tag inside JSON text is
// still just text to the JS parser, and the HTML tokenizer never sees it because
// buildFrameDocument escapes \`<\` when emitting the block.
//
// NOTE TO ANYONE EDITING THIS FILE: never write a literal script closing tag
// anywhere inside this template, not even in a comment. The HTML tokenizer ends a
// script element at the first one it sees, with no regard for JavaScript context —
// which is the entire bug described above, and which this very comment previously
// caused by quoting the payload verbatim.
const CFG = JSON.parse(document.getElementById('agent-code-ext-cfg').textContent);
const VIEW_ID = CFG.viewId;
const ENTRY = CFG.entry;
const DECLARED_COMMANDS = CFG.declaredCommands;
const DECLARED_VIEWS = CFG.declaredViews;

// ── ANNOUNCE THAT THIS DOCUMENT IS THE REAL FRAME, IMMEDIATELY ──
// The host cannot tell a successful load from a failed one any other way. An
// iframe fires 'load' for an HTTP ERROR BODY just as it does for a real page, and
// never fires 'error' for one — so the host's onError handler was dead code, and a
// 404/403 from the scheme handler (missing bundle, unknown view id, an id that
// failed validation) rendered as a permanently blank "ready" frame with no message
// anywhere. This is the first statement that runs, before the dynamic import can
// throw, so its ARRIVAL means "the host's own document is executing" and its
// ABSENCE within the host's timeout means the load failed for any reason at all —
// including a CSP violation that stops the bootstrap outright.
window.parent.postMessage({ kind: 'agent-code-ext:boot' }, '*');

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
// ── REGISTERING AN UNDECLARED ID IS AN ERROR, AND THE FRAME IS WHERE THAT LIVES ──
// This check used to be in the host-realm ExtensionHost, which imported the module
// and could compare against the manifest it already held. That host is gone — the
// extension runs only here — and the check went with it, silently: the bootstrap
// just wrote into the maps, while the type, moduleContract and the authoring guide
// all still promised rejection.
//
// It matters because the failure it prevents is invisible. Contributions are
// DECLARED in the manifest so the palette can list a command before the module is
// imported; a handler registered under an id the manifest does not declare can
// therefore never be invoked by anything. Without this, an author who typos an id
// gets a command that does nothing, no error anywhere, and no way to tell the typo
// from a broken host.
//
// The declared ids are passed in through the config island rather than fetched,
// because the host already validated them at install and the frame has no way to
// ask. Throwing here propagates to the import().catch below, which reports the
// message to the host and shows it on the extension's Settings row.
function assertDeclared(kind, id, declared) {
  if (declared.indexOf(id) !== -1) return;
  throw new Error(
    'register' + kind + '("' + id + '") — not declared in contributes.' +
      (kind === 'Command' ? 'commands' : 'views'),
  );
}

const context = {
  api,
  // Handlers are invoked by the host's 'command' push above — the frame is the ONE
  // place an extension's command runs, so its handlers must actually be kept.
  registerCommand: (id, run) => {
    assertDeclared('Command', id, DECLARED_COMMANDS);
    commands.set(id, run);
    return { dispose() { commands.delete(id); } };
  },
  registerView: (id, mount) => {
    assertDeclared('View', id, DECLARED_VIEWS);
    views.set(id, mount);
    return { dispose() { views.delete(id); } };
  },
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
  // Height comes from #root: it is height:auto, so scrollHeight IS the content height,
  // and growing the iframe never changes it — no resize feedback loop.
  const height = root.scrollHeight;
  // WIDTH MUST BE MEASURED FROM THE CHILDREN, NOT FROM #root.
  //
  // #root is width:100%, and scrollWidth is by definition never smaller than clientWidth.
  // So root.scrollWidth returns at least the CURRENT iframe width, always. The modal
  // could therefore grow but never shrink: switching from a wide view to a narrow one
  // (a 892px game to a 375px one) left the modal stuck at the old width with the new
  // content marooned in the corner — which is exactly the "cropping works weird" report.
  //
  // The children carry their own intrinsic width, so measuring them lets the report go
  // DOWN as well as up. Fall back to scrollWidth if an extension mounts nothing we can
  // measure. Note this deliberately reads getBoundingClientRect rather than offsetWidth:
  // it is sub-pixel accurate and, unlike offsetWidth, correct for transformed children.
  let width = 0;
  for (let i = 0; i < root.children.length; i++) {
    width = Math.max(width, Math.ceil(root.children[i].getBoundingClientRect().width));
  }
  if (width <= 0) width = root.scrollWidth;
  if (height > 0) window.parent.postMessage({ kind: 'agent-code-ext:resize', height: height, width: width }, '*');
}

let mounted = false;
// The cleanup a view's mount() returned, if any. The ViewMount contract is
// (element) => void | (() => void), and the authoring guide documents "a view
// mount returns its own cleanup; it runs when the view closes" — but the return
// value was DISCARDED here, so that promise was never kept. An extension whose
// view starts an interval, an AudioContext or a listener leaked it on every close,
// and the author had no way to notice, because the documented hook simply never
// fired. Captured here, called from the pagehide teardown below.
let unmountView = null;
function mountView(viewId) {
  if (mounted) return;
  const mount = views.get(viewId);
  if (!mount) return;
  mounted = true;
  const root = document.getElementById('root');
  if (!root) return;
  const cleanup = mount(root);
  if (typeof cleanup === 'function') unmountView = cleanup;
  // Report once now, then on every content change (a picker expands, digits
  // reflow), so the modal tracks the view instead of freezing at first paint.
  reportSize();
  if (typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver(function () { reportSize(); });
    // Observing #root alone is NOT enough. It is width:100%, so a content change that
    // only alters WIDTH never changes #root's own box and the observer stays silent —
    // the modal would keep a stale width until something happened to change the height
    // too. Observe the children, whose boxes track the content, and re-sync that list
    // when the extension swaps its tree (a router switching screens replaces the child).
    observer.observe(root);
    const syncChildren = function () {
      for (let i = 0; i < root.children.length; i++) observer.observe(root.children[i]);
      reportSize();
    };
    syncChildren();
    if (typeof MutationObserver !== 'undefined') {
      new MutationObserver(syncChildren).observe(root, { childList: true });
    }
  }
}

// ── ESCAPE IS FORWARDED TO THE HOST, EVERYTHING ELSE IS NOT ──
// A cross-origin frame consumes every keystroke: the host document never sees
// them, so while focus is inside an extension view NO application shortcut fires.
// For most chords that is merely a limitation. For Escape it is a trap — Escape is
// the universal "get me out of this" in this app, and a user pressing it inside an
// extension modal got nothing at all, with no indication that the key had been
// swallowed rather than ignored.
//
// Only Escape is forwarded. Forwarding arbitrary chords would mean reconstructing
// the host's whole keybinding router across a postMessage boundary, and would let a
// frame synthesize application commands — a capability nothing here should have.
// Escape carries no argument and can only ever mean "close the thing in front of
// me", so it is safe to hand over.
//
// defaultPrevented is the extension's opt-out and the reason this listens in the
// BUBBLE phase: an extension that wants Escape for its own popover calls
// preventDefault(), and the host never hears about it. An extension that does
// nothing gets the behaviour the rest of the app has.
window.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || event.defaultPrevented) return;
  window.parent.postMessage({ kind: 'agent-code-ext:escape' }, '*');
});

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
    const message = (error && error.message) || String(error);
    const root = document.getElementById('root');
    if (root) root.textContent = 'Extension failed to load: ' + message;
    // ALSO tell the host. Writing the message into this document only put it
    // inside the frame — and a frame that fails during activate() is often not
    // even visible (a queued command opened it), so the user saw nothing at all
    // and Settings showed a healthy row. The host-realm ExtensionHost used to
    // collect these from its own try/catch around import+activate; that host is
    // gone, so the frame is now the only thing that can observe the throw.
    window.parent.postMessage({ kind: 'agent-code-ext:error', message: message }, '*');
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
  // Innermost first: the view's own cleanup, then the module's deactivate(), then
  // the registered subscriptions in reverse. That is the reverse of the order in
  // which they were established, which is the only order in which a later hook
  // cannot depend on something an earlier one already tore down.
  try {
    if (typeof unmountView === 'function') unmountView();
  } catch (e) {
    console.error('[extension] view cleanup failed:', e);
  }
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
    `<meta http-equiv="Content-Security-Policy" content="${childFrameCsp(nonce, extensionId)}" />`,
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
    // The config island. `<` is escaped to \u003c so no value can close this element
    // (or open another) regardless of what the manifest or query string contained.
    // JSON.parse reads \u003c back as `<`, so values round-trip exactly.
    `<script type="application/json" id="agent-code-ext-cfg">${JSON.stringify({
      viewId,
      entry,
      declaredCommands,
      declaredViews,
    }).replace(/</g, '\\u003c')}</script>`,
    `<script type="module" nonce="${nonce}">${bootstrap}</script>`,
    '</body>',
    '</html>',
  ].join('\n')
}
