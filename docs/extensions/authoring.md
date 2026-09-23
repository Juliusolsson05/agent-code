# Writing an Agent Code extension

> **Status:** this branch implements API versions **1 and 2**. API v2 requires
> the host and SDK changes in PR #577 and companion SDK PR #1.
>
> This document is the contract. Where it and the code disagree, the code wins and
> this document is the bug — it has been wrong before, in the way described in §3.

An extension is a GitHub repository or local folder containing a manifest and
built ES modules. Agent Code validates and snapshots the bundle, then runs its
code in isolated browser contexts. Nothing is compiled into the app.

```
Settings → Extensions → owner/repo → Install
```

---

## 0. Runtime and view ownership

API v2 separates two browser contexts. One sandboxed, hidden runtime owns an
extension's commands and shared state. Every open view runs a separate module in
its own sandboxed iframe at `agent-code-ext://<extension-id>/`. Closing the last
view leaves the runtime alive. A command can activate it without opening a view.

A view owns DOM, theme and window-specific UI; a runtime has no implicit focused
window or project. Functions never cross this boundary. Views send named JSON
requests to the runtime and subscribe to published JSON state. Both contexts have
namespaced durable storage; module variables and browser localStorage are not a
persistence contract across app restart or replacement.

Bundle your own dependencies, including React. There is no host React instance,
Node API or generic application preload available to extension code. Cross-origin
DOM access, external network requests, popups, top-level navigation, nested frames
and permission prompts are denied by the host's sandbox and policy.

API v1 remains supported with its original per-view `activate/registerView`
contract. It does not gain a shared background runtime; see compatibility below.

## 1. Manifest and activation

Put `agent-code.extension.json` at the repository root:

```json
{
  "id": "counter",
  "name": "Counter",
  "description": "Shared state across independent views.",
  "version": "0.1.0",
  "apiVersion": 2,
  "entry": "dist/runtime.js",
  "activationEvents": ["onCommand:counter.increment", "onView:counter.main"],
  "contributes": {
    "commands": [
      { "id": "counter.open", "title": "Counter: Open" },
      { "id": "counter.increment", "title": "Counter: Increment" }
    ],
    "views": [
      { "id": "counter.main", "title": "Counter", "mount": "panel", "entry": "dist/view.js" }
    ],
    "settings": [
      { "id": "counter.step", "title": "Increment amount", "type": "number", "default": 1 }
    ]
  }
}
```

| Field | Rules |
| --- | --- |
| `id` | `/^[a-z][a-z0-9-]{0,63}$/`; permanent storage namespace and origin host. |
| `name`, `description` | Required, nonempty display metadata. |
| `version` | Display text, recorded without version ordering. |
| `apiVersion` | This host accepts `1` and `2`; checked at install and load. |
| `entry` | Built runtime ES module for v2; legacy activation module for v1. |
| `contributes.views[].entry` | Required for v2. Built view ES module, independent of runtime. |
| `contributes.themes` | Up to 16 declarative palettes; see §7. No runtime activation or permission. |
| Entry paths | Relative `.js`/`.mjs` paths within the bundle; no `..`, backslashes or absolute paths. Installer validates actual files and symlink containment. |
| Contribution ids | Must start with `<extension-id>.`. |
| `permissions` | Only implemented capabilities are accepted; see §6. |

Contributions are discoverable before any author code executes. A v2 cold runtime
starts only for an explicit event: `onStartupFinished` or `*` starts it after host
startup and after installation/update; `onCommand:<declared-id>` or
`onView:<declared-id>` permits that command or view to start it lazily. Absent
activation events never start a cold runtime. Once active, registered commands
execute without requiring another matching activation event.

An `onStartupFinished` or `*` extension may also be started by any of its own
commands or views. This lets its engine come back after a crash, a command
deadline or a failed activation without an app restart, so a startup-only
manifest does not need to list `onCommand`/`onView` events as well.

A command matching a view id opens that view. `<extension-id>.open` also opens the
view of a single-view extension. Other v2 commands run in the shared runtime and
return an acknowledged result/error; they do not open a view. Declare startup or
command activation for command-only extensions.

## 2. Independent modules

The SDK's `defineRuntime` and `defineView` helpers return their module objects.
Named `activate`/`mount` exports also work. See the
[SDK counter fixture](../../packages/agent-code-extension-api/examples/counter)
for a typed example built and installed by the real Electron integration test.

```ts
// src/runtime.ts
import { defineRuntime } from 'agent-code-extension-api'

export default defineRuntime({
  async activate(context) {
    let count = (await context.api.storage.get<number>('count')) ?? 0
    context.registerCommand('counter.increment', async () => {
      const step = (await context.api.storage.get<number>('counter.step')) ?? 1
      const next = count += step
      // Shutdown revokes write authority and has a deadline; persist on mutation.
      await context.api.storage.set('count', next)
      await context.views.publish('counter.main', { count: next })
      return next
    })
    context.registerRequest('readCount', (_input, view) => ({ count, instanceId: view.instanceId }))
    await context.views.publish('counter.main', { count })
  },
})
```

```ts
// src/view.ts
import { defineView } from 'agent-code-extension-api'

export default defineView<{ count: number }>({
  mount(element, context) {
    const render = (state: { count: number } | undefined) => {
      element.textContent = `Count: ${state?.count ?? 0}`
    }
    render(context.runtime.state())
    return context.runtime.subscribe(render)
  },
})
```

`views.publish(viewId, json)` replaces that view type's latest state for all its
attached instances. `runtime.state()` reads the current snapshot, possibly
undefined before the first publication; `subscribe` receives subsequent changes.
`runtime.request(name, input)` invokes a registered request handler with validated
JSON and a host-issued `{ id, instanceId }`. Validate your application's input
shape in the handler; transport validation only establishes bounded JSON.

Runtime messages allow at most 4096 JSON values, depth 32 and 128 Ki characters
(one exception: a `net.fetch` result may be as large as the broker's 256 KiB
cap after base64 expansion, so runtimes and views receive the same responses).

**Invalid arguments reject in both places.** A view call that fails the host's
validation (an empty secret, an oversized value, an extra field) rejects with
`Invalid arguments for <method>.`, exactly as a runtime call does. Older hosts
dropped such a view request silently, leaving the promise pending forever.
Startup has a 10-second deadline; an invocation has 30 seconds, with at most 32
pending calls per extension. Keep published state compact and coalesce rapid UI
changes instead of treating the bridge as an unbounded event stream.

Closing a view rejects pending replies and prevents calls still awaiting startup
from dispatching. An already dispatched action may finish. Requests and commands
are never automatically replayed; a command timeout reports an unknown outcome.

View `mount` and returned cleanup are synchronous. Mount runs after runtime
attachment and theme delivery. Runtime `deactivate` and subscriptions may be async,
but normal retirement revokes API authority immediately and allows at most 500 ms
for cleanup. Forced termination may skip cleanup entirely. Use subscriptions to
release local timers/listeners; save durable state when it changes.

### View placement and keyboard behavior

`mount: "modal"` opens an automatically sized floating dialog; `"panel"` opens a
workspace pane. Restored panes retain their extension/view identity and display a
missing-extension state when the bundle is unavailable.

Application shortcuts inside cross-origin views use the host's configured
keybindings. Genuine keyboard input selects the focused extension pane before
routing its command, so closing a pane targets that view. In a modal, palette
access and the configured close command remain available; close dismisses the
modal, while native editing stays in the view. Extension-dispatched DOM events
and messages cannot invoke this application shortcut route.

Escape is forwarded to the host unless the view calls
`event.preventDefault()`; unhandled Escape closes the view. Provide visible
controls where needed, and use `context.api.ui.close()` to close your own view.

### API v1 compatibility

A v1 entry exports `activate(context)` and optionally `deactivate()`, or uses
`defineExtension`. Its context supports `registerCommand` and
`registerView(id, element => cleanup)`. That module activates separately in every
visible view. Its activationEvents are validated metadata, with no background
execution. A cold non-view command opens the sole declared view to dispatch; a
viewless v1 extension cannot execute an action cold.

Legacy view cleanup, deactivate and subscriptions run synchronously on document
teardown, with subscriptions visited in reverse order. Migrate shared command/state
ownership to a v2 runtime, move DOM work to view modules, declare each view's entry,
and choose explicit activation events. Changing only `apiVersion` is insufficient.

---

## 3. React (and every other dependency): bundle it

**Bundle your own React. Normally. Like any web app.**

If you have seen an older version of this document telling you to alias `react` to
`globalThis.__agentCodeHost` — that guidance was for a previous architecture where
extensions ran inside Agent Code's own renderer and would have collided with the
host's React instance. **It is wrong now and will break your extension**, because a
cross-origin frame cannot see the host's globals at all: the shim would read
`undefined` at module-evaluation time and your extension would fail before
`activate()` ran.

Your frame is its own document with its own realm. Two React instances in two
documents are not a conflict; they never meet.

The SDK ships types and a Vite preset that produces the right output. It is **not
on npm** — install it from GitHub, which works because its `dist/` is committed:

```bash
npm i -D github:Juliusolsson05/agent-code-extension-api
```

```ts
// vite.config.ts
import { extensionViteConfig } from 'agent-code-extension-api'
export default extensionViteConfig({
  entries: { runtime: 'src/runtime.ts', view: 'src/view.ts' },
})
```

For React, spread the whole preset and add the plugin:
`{ ...extensionViteConfig({ entries }), plugins: [react()] }`. Do not copy selected keys
out of it: the preset also pins the production JSX transform, so the build works
whatever `NODE_ENV` your shell exports. Author packages are expected to be ESM
(`"type": "module"`).

The SDK is optional. It gives you `ExtensionManifest`, `ExtensionContext` and
`AgentCodeApiV1` types plus the build preset; an extension is a plain ES module and
nothing in the host requires you to depend on it.

---

## 4. Build output

Two hard requirements:

1. **Built ES modules** at the runtime and every v2 view entry path. Commit all
   imported shared chunks too; the installer serves contained bundle assets.
2. **Committed to the repository.** The installer downloads your repo's source
   tarball, not a release asset, so a `dist/` that only exists in CI means every
   install fails with *"Manifest points at … which does not exist"*.

For a legacy v1 single-entry build without the preset:

```ts
build: {
  lib: { entry: 'src/index.ts', formats: ['es'], fileName: () => 'index.js' },
  rollupOptions: { output: { inlineDynamicImports: true } },
  cssCodeSplit: false,
},

// REQUIRED if you depend on anything from the React ecosystem.
define: { 'process.env.NODE_ENV': JSON.stringify('production') },

// REQUIRED with JSX. Vite otherwise picks the dev transform from your shell's
// NODE_ENV, and the production React bundled by the define above has no jsxDEV:
// the view installs cleanly, then throws "jsxDEV is not a function" on render.
esbuild: { jsxDev: false },
```

### ⚠️ `process is not defined` — read this before you debug it

**Vite's library mode does not replace `process.env.NODE_ENV`.** A normal app build
does; a library is expected to leave it for the consuming bundler. There is no
consuming bundler here — your output is loaded straight into a browser document
where `process` does not exist.

Nearly every React-ecosystem package guards its dev warnings with
`process.env.NODE_ENV !== "production"`, so the first one to execute throws and
your extension fails during `activate()` — **after** installing and importing
cleanly, which makes it look like your code rather than your build.

The `define` above is the fix. Do **not** shim a global `process` object instead:
libraries would then take Node code paths inside a browser realm, which fails later
and far less obviously.

**CSS must be loaded by your view.** The host does not automatically request
emitted sibling stylesheets. Import CSS with `?inline` and inject a `<style>` tag,
or explicitly load a contained stylesheet from your view module.

**Symlinks must be relative.** If your bundle aliases a file with a symlink, make
it relative. An absolute symlink points outside the installed bundle once the
extension has been copied into place, and the installer refuses it.

---

## 5. The API

The v2 runtime API provides identity, storage, scoped files and permissioned
background notifications. The v2 view API (and v1 context API) additionally
provides UI, theme and permissioned observation below. Remote reads/actions return
Promises; view state reads and subscription setup are local synchronous operations.
Background runtimes have no implicit window-scoped observation or view UI API.

### Tier 0 — always available, no permission needed

```ts
api.extension.id                     // your id
api.extension.apiVersion             // 1 or 2, matching your manifest

api.storage.get(key)                 // your own namespace, persisted
api.storage.set(key, value)
api.storage.delete(key)
api.storage.keys()

api.ui.close()                       // close your view (the modal or the pane)
api.ui.showToast(message)            // app-wide toast

api.theme.tokens()                   // resolved --theme-* values

// API v2 only — credentials, encrypted by the OS keychain in the host (§5a)
api.secrets.get(key)                 // string | null
api.secrets.set(key, value)
api.secrets.delete(key)
```

### Tier 1 — requires a permission (see §6)

```ts
api.workspace.observe()              // { activeTabId, tabIds, sessionCount }
api.workspace.subscribe(listener)    // returns an unsubscribe

api.sessions.observe()               // [{ id, kind, cwd, title }]
api.sessions.subscribe(listener)

api.panes.observe()                  // [{ tabId, leafSessionIds }]
api.panes.subscribe(listener)
```

`subscribe` gives you a change *nudge* carrying no data — re-read with `observe()`
when it fires. Calling `observe()` without the matching permission rejects.

### Tier 2/3 — scoped project files (API v2)

```ts
const file = await api.files.readText({
  sessionId: 'the-session-you-are-targeting',
  path: 'src/index.ts',
})

await api.files.writeText({
  sessionId: file.sessionId,
  path: file.path,
  text: file.text.replace('old value', 'new value'),
  expectedVersion: file.version,
})
```

Declare `"fs.read"` and/or `"fs.write"` in `permissions`. The session must still be active, and main
derives its project root from the session's spawn record. Paths are relative to
that root; absolute paths, traversal, symlink escapes, directories, binary data and
invalid UTF-8 reject. Reads are capped at 96 KiB so their result fits the bounded
extension transport. Writes are capped at 64 KiB, publish atomically, and share the
editor's mutation queue and cache invalidation.

Every write is an explicit compare-and-swap. Pass `expectedVersion: null` to create
a file only if it does not exist. To replace a file, pass the opaque `version` from
`readText`; if an editor, agent or other extension changed or deleted that version,
the write rejects and preserves the newer bytes. Both the v2 runtime and its views
expose the same methods.

There is deliberately no implicit focused session. Background code has no focused
window, and a view's focus can change while an asynchronous read is pending. Use a
session id from your own workflow or from `sessions.observe` when that separately
granted metadata permission is appropriate.

### Background status notifications (API v2)

```ts
await api.notifications.show('Focus session complete')
```

Declare `"notifications.show"` in `permissions`. Runtime and view modules can send
a short app-wide toast of at most 200 characters. Agent Code prefixes it with the
installed extension's name, so pass only the status text. This channel remains
available after the last view closes and does not create an OS notification.

### Reading a contributed setting

A `contributes.settings` entry renders a row in Agent Code's Settings, and the value
the user picks is written to **your own storage under the setting's full id**. The
manifest `default` is what the row displays before anything is stored; it is not
written for you. So read it with the same default:

```ts
const minutes = (await api.storage.get('timer.defaultMinutes')) ?? 30
```

### Storage notes

- Namespaced by extension id; you cannot read another extension's data.
- Values must be JSON-serializable. **`NaN` and `Infinity` are rejected** rather
  than silently stored as `null`.
- Keys may not be `__proto__`, `constructor` or `prototype`.
- Concurrent writes are serialized, so `void set('a',1); void set('b',2)` is safe.
- **Survives uninstall.** Uninstall-then-reinstall is a normal troubleshooting
  move; destroying user data as a side effect of it would be hostile.
- A modal, pane and runtime of the same extension share one namespace.
- Each namespace is limited to 256 keys and 1 MiB of encoded state. Each value
  must also fit the bounded JSON transport limits. Over-limit writes preserve the
  previous snapshot; use compact application state rather than large file contents.
- Reads and writes are ordered together, with at most 32 pending operations per
  extension and 256 globally. A rejected burst can be retried after it drains.
- Corrupt, unreadable or oversized saved files produce an error and are preserved.
  They are never treated as empty and overwritten by the next mutation.

### 5a. Secrets (API v2, no permission)

**Feature-detect it.** `secrets` is optional (`secrets?`) on every API-v2
context: it requires Agent Code ≥ the first supporting version (see the SDK
CHANGELOG), older hosts do not provide it, and a secrets-only extension
requests no new permission, so nothing at install stops it from loading on an
older host:

```ts
if (context.api.secrets) {
  await context.api.secrets.set('example.apiKey', key)
} else {
  // Say so, and do not fall back to api.storage: that would silently turn
  // "encrypted by the OS keychain" into a plain JSON file.
  showMessage('Update Agent Code to save this key.')
}
```

`api.secrets` is for credentials the user gives your extension — an API key,
a token. It is **not** a second `api.storage`:

- **Encrypted by the OS.** The host encrypts each value with Electron
  `safeStorage` (macOS Keychain, Windows DPAPI, Linux libsecret/kwallet) and
  writes one 0600 blob per key. If the OS cannot encrypt (for example a Linux
  session with no keyring), `set` **rejects** instead of storing plaintext;
  tell the user their key was not saved.
- **Your namespace only.** Scoped by your extension id, which the host takes
  from your frame origin / runtime, never from an argument. That is also why
  there is no permission: you can only read back what you stored.
- **Limits.** Keys are 1–64 characters of `[a-zA-Z0-9._-]`; values are strings
  of 1–4096 characters; at most 32 keys per extension.
- **Unreadable reads as `null`.** After a keychain reset (or a copied profile)
  the blob cannot be decrypted; `get` returns `null` and you ask again.
- **Deleted on uninstall.** Unlike `api.storage`, secrets do not survive an
  uninstall: a later install of the same id from another source must not
  inherit someone's key.
- **Never logged.** The host never logs values, and its error messages never
  include them. Keep it that way in your own code: do not put a secret into
  `ui.showToast`, a thrown `Error`, or `api.storage`.

---

## 6. Permissions

Declare what you need in `permissions`. The user approves them in a blocking
dialog at install time, and the grant is bound to the exact bytes installed — if
you ship new code, the user is asked again.

**Eleven permissions are currently implemented:**

| Permission | Grants |
|---|---|
| `workspace.observe` | `api.workspace.observe` / `subscribe` |
| `sessions.observe` | `api.sessions.observe` / `subscribe` |
| `panes.observe` | `api.panes.observe` / `subscribe` |
| `fs.read` | API v2 `api.files.readText({ sessionId, path })` in runtimes and views |
| `fs.write` | API v2 atomic `api.files.writeText(...)` with create-only/version checks |
| `notifications.show` | API v2 `api.notifications.show(message)` app toast, including from a background runtime |
| `service.run` | API v2 `api.services.*` — start/stop/status/invoke of your bundled native services (see §6a) |
| `service.transport` | Fetch your own running service through the host proxy (see §6b) |
| `net.listen` | `api.services.expose(id, true)` — host-owned LAN exposure of a running service (see §6c) |
| `net.connect` | API v2 `api.net.fetch(url, init)` — brokered outbound fetch to private addresses (see §6d) |
| `net.origins` | API v2 `api.net.fetch(url, init)` to the exact HTTPS origins you list in `networkOrigins` (see §6e) |

Anything else fails the install with a message naming what this build supports.
Transcript, git and prompt-sending capabilities **do
not exist** — they are unimplemented, and asking for one is an install error rather
than a silent no-op. Scoped file, background notification, service and network
permissions require API
v2 because v1's per-view API is frozen.
Omit `permissions` entirely to stay Tier 0, which installs with no prompt at all.

### 6a. Services (`service.run`) — read this trust note

A service is a **native Node program the host launches as a child process with
this user's privileges**. That is the entire point — language servers, dev
servers, device bridges, LAN game hosts are native code — and the install dialog
says so plainly. The permission is the user's consent decision, not a sandbox:
native code you ship can read and write what the user's account can. Keep that
in mind before adding `service.run` to a manifest, and expect users to judge you
for it.

Declare services in the manifest (v2 only, entries must stay inside the bundle):

```json
"contributes": { "services": [{ "id": "myext.lan-host", "entry": "dist/host.js" }] }
```

The host never auto-starts anything. Your runtime or view starts a service
explicitly, and only code the user installed can:

```ts
const handle = await api.services.start('myext.lan-host')   // → { pid, endpoints: [{ name, port }] }
const reply  = await api.services.invoke('myext.lan-host', 'status', { deep: true })
await api.services.stop('myext.lan-host')
```

The entry exports the service contract (`defineService` + `runService` from the
SDK package) and speaks the host's message protocol over `process.parentPort`:

```ts
import { defineService, runService } from 'agent-code-extension-api'

const service = defineService({
  start(context) {
    context.onRequest('status', () => ({ up: true }))
    // Bind LOOPBACK only; exposure beyond this machine is a separate,
    // host-owned decision (§6c).
    context.ready([{ name: 'http', port: 5192 }])
  },
})
runService(service)
```

One live instance per service id; `start` on a running service joins it.
Update/uninstall/app-quit terminate the process. A request whose result is
unknown (timeout) kills the process rather than replaying it.

### 6b. Talking to your own service (`service.transport`)

Views and runtimes have no network at all — their CSP permits only their own
origin. With `service.transport`, a frame may fetch its **own** running service
through a host proxy on that same origin:

```ts
// from a view frame — same origin, so CSP allows it
const state = await fetch('./__service/myext.lan-host/api/state').then(r => r.json())
```

Plain HTTP methods only (WebSockets are not proxied). Ungranted or not-running
answers 404. The proxy forwards only `accept`, `content-type` and
`authorization`, caps request bodies at 1 MiB, and re-checks the grant and
running state on every request.

Every proxied request arrives with `x-agent-code-transport: service`, set by
the host. It means "this came from your own extension's frame", so your
service can treat the request like its own same-origin page, even though the
frame's `Origin` never reaches it. Read it through the SDK's
`TRANSPORT_ATTESTATION_HEADER` and `TRANSPORT_ATTESTATION.service` / `.lan`
exports (`agent-code-extension-api`), not a hand-typed string.

What the host guarantees, and what it doesn't:

- **In-app callers can't forge the marker.** Frames and runtimes reach
  services only through this proxy, which always sets `service`, or through
  `net.fetch`. `net.fetch` refuses `x-agent-code-transport`, `forwarded` and
  every `x-forwarded-*` header. It also refuses loopback targets on any
  extension's service or LAN-listener port, so no extension can dial another
  extension's service directly.
- **Web pages can't forge it**, provided your service never answers CORS
  preflights. A page can only attach a custom header cross-origin through a
  preflight.
- **Local programs can.** Any process on this machine can dial your loopback
  port with any headers, including every extension's service child, which is
  ordinary unsandboxed Node. Treat the marker as "not a web page and not
  another extension's sandbox", never as "not a local program". Only trust it
  on a loopback socket, and give loopback callers no more than the local user
  already has.

### 6c. LAN exposure (`net.listen`)

`net.listen` does not let your service bind the network — it lets the **host**
do it for you. Your service bound loopback at ready(); expose it and share the
returned port on a trusted network:

```ts
const { port } = await api.services.expose('myext.lan-host', true)
// friends open http://<your-lan-ip>:<port> in any normal browser
await api.services.expose('myext.lan-host', false)  // close it
```

The host owns that listener: OS-chosen port, only private-source connections
admitted, closed automatically when your service stops or the extension is
updated/removed. Exposure can never outlive the thing it exposes.

The listener dials your service over loopback, so the socket peer is always
`127.0.0.1`. It forwards `accept`, `content-type`, `authorization`, `origin` and
`sec-fetch-site`, and sets these itself (a peer can't supply or change them):

- `x-agent-code-transport: lan`
- `x-forwarded-for`: the peer's address
- `x-forwarded-host`: the Host the peer used

Treat a `lan` request as the forwarded peer, never as local. The one
exception proves the rule: a client on this same machine that dials the
listener on 127.x arrives with a loopback `x-forwarded-for`. That is local
access, and treating it as local grants nothing a local program doesn't
already have. The listener always dials your service with
`Host: 127.0.0.1:<your port>`, so a `lan` request carrying any other Host
didn't come from the listener. `x-forwarded-for` can be an IPv6 address:
the listener admits private IPv6 peers, and it's your service's choice
whether to serve them. Check its `Origin`
against `http://<x-forwarded-host>`, and require that host to be an IP literal
if you need a DNS-rebinding defence. The listener doesn't know your service's
rules; it only reports the facts. Your service's `content-security-policy`,
`x-content-type-options`, `referrer-policy` and `x-frame-options` response
headers reach the LAN browser. Other response headers (cookies, CORS) don't.

### 6d. Outbound fetch (`net.connect`)

`api.net.fetch(url, init)` asks the host to fetch for you. The sandbox never
opens a socket. v1 policy is deliberately narrow: **literal private/loopback IP
hosts only** (`http://192.168.1.42:5192/...`) — no DNS names (they resolve
anywhere), no public addresses. Bodies are capped at 64 KiB, responses at
256 KiB, and the whole call times out at 10s. Redirects are refused: a private
address cannot bounce your request to a host the policy never checked.

```ts
const result = await api.net.fetch('http://192.168.1.42:5192/api/state', {
  httpMethod: 'POST',                               // GET | HEAD | POST | PUT | DELETE | PATCH
  headers: [{ name: 'content-type', value: 'application/json' }],
  body: JSON.stringify({ hello: 1 }),               // string, ≤ 64 KiB
  responseType: 'text',                             // or 'base64' for binary bodies
})
// { status, contentType, body, bodyEncoding: 'text' | 'base64' }
```

The verb field is **`httpMethod`** (the transport already uses `method`).
Hosts before #1150 read `init.method` instead, so an SDK-typed POST went out as
a GET; current hosts accept both. `bodyEncoding` echoes what the host did —
check it if you asked for `'base64'`, because an older host ignores the field
and returns text.

**Limits, and where they come from.** The limits are fixed by the host; there
are no per-call options. Every request and result crosses a bounded transport,
and the caps are sized to fit it:
- A request body of 64 KiB fits inside the 128 Ki-character JSON envelope both
  the view broker and the runtime channel accept, with room for the URL and
  headers.
- A response of 256 KiB is the most a view receives. The host stops reading
  at the cap, even when the server streams without a Content-Length.
- A **view and a background runtime receive the same responses.** The runtime
  channel's generic JSON bound is 128 Ki characters, but it admits a
  `net.fetch` result up to the broker's own cap: 256 KiB after base64 expansion
  plus a small fixed metadata budget (the server's Content-Type is clamped to
  256 characters). Earlier builds refused a runtime `base64` body above about
  96 KiB; that was a transport artefact, not a policy.

Headers the host uses to tell services who is calling (`x-agent-code-transport`,
`forwarded`, `x-forwarded-*`) are refused on every `net.fetch`, private or public.

### 6e. Declared public origins (`net.origins`)

To call one specific public web API, list its **exact origins** and request
`net.origins`:

```json
{
  "apiVersion": 2,
  "permissions": ["net.origins"],
  "networkOrigins": ["https://api.example.com"]
}
```

- The consent dialog shows every origin. The list is bound to your bundle hash
  like every grant, so a new list in an update is asked about again.
- Each entry must be exactly `https://<dns-name>` (optionally `:port`): no
  wildcards, paths, trailing slash, query, credentials, IP literals,
  `localhost` or `.local` names, and no trailing-dot hosts
  (`https://localhost.` is still this machine). HTTPS is required for the credentials these
  calls carry, and because a certificate is what stops a declared name from
  being re-pointed (DNS rebinding) at a device on the user's network. Local
  addresses belong to `net.connect`.
- `networkOrigins` without `net.origins` (or the reverse) fails the install.
  At most 4 origins.
- `api.net.fetch` routes by target: a private literal needs `net.connect`; a URL
  whose origin is **exactly** a declared one (same scheme, host and port) needs
  `net.origins`; anything else is refused with a message naming your list.
- Redirects are refused (a declared API must not forward your key elsewhere),
  responses are capped at 256 KiB (limits above), and the call times out after
  15 s. Use `responseType: 'base64'` for audio, images or other binary bodies.
- Certificate validation is always on and cannot be relaxed. It is what makes
  HTTPS a DNS-rebinding defence, so there is no "insecure" option.
- The host never logs request headers or bodies, and its errors never echo
  them. Combine with `api.secrets` so a user's key never sits in `api.storage`:

```ts
// Same feature detection as §5a, plus the "not set yet" case: get() resolves
// null, and sending `Bearer null` would leak nothing but fail confusingly.
const key = api.secrets ? await api.secrets.get('example.apiKey') : null
if (!key) {
  showMessage(api.secrets ? 'Add your API key in settings first.' : 'Update Agent Code to use this feature.')
  return
}
const image = await api.net.fetch('https://api.example.com/v1/render', {
  httpMethod: 'POST',
  headers: [{ name: 'authorization', value: `Bearer ${key}` }, { name: 'content-type', value: 'application/json' }],
  body: JSON.stringify({ prompt: 'a lighthouse' }),
  responseType: 'base64',
})
```

---

## 7. Theming

Agent Code pushes its palette into your frame as `--theme-*` custom properties,
**before** your view mounts, and again whenever the theme changes. Use them in CSS
and you inherit the user's theme for free:

```css
.my-extension {
  background: var(--theme-surface);
  color: var(--theme-ink);
  border: 1px solid var(--theme-border);
}
```

Common tokens: `--theme-canvas`, `--theme-surface`, `--theme-ink`,
`--theme-ink-dim`, `--theme-muted`, `--theme-border`, `--theme-accent`,
`--theme-accent-fg`, `--theme-font-code`.

You do not need a fallback palette — the tokens are guaranteed present before your
first paint. Prefer plain CSS over `api.theme.tokens()`; the accessor exists for
canvas and inline-SVG consumers that cannot use the cascade.

**Only the `--theme-*` layer is contract.** The `--color-*` Tailwind bindings are
an implementation detail of how the app wires its utilities.

### Contributing an application theme

Both manifest versions accept declarative themes. They appear in the appearance
picker without executing your extension or requiring an extra permission:

```json
"themes": [{
  "id": "counter.night",
  "title": "Counter Night",
  "colors": { "canvas": "#102030", "ink": "#f0e0d0", "accent": "#78abcd" }
}]
```

Place this array inside `contributes`, with ids in your extension's namespace.
The SDK exports `EXTENSION_THEME_COLOR_KEYS` and `ExtensionThemeContribution`.
Only those color tokens are accepted; omitted tokens inherit the default palette.
Values must be `#RGB`, `#RGBA`, `#RRGGBB`, `#RRGGBBAA`, or `transparent`. CSS
functions, variables, URLs and non-color properties are rejected. Each theme
needs at least one color; a manifest can contain at most 16 themes.

The user selects the theme. Updating your bundle replaces its palette, while
uninstall falls back to Dark and preserves the selection for reinstall. Themes
do not overwrite built-ins, saved user themes, font choices or corner settings.
The picker identifies the providing extension; New theme copies the current
colors into a separate user-owned palette.

---

## 8. Developing locally

Cutting a GitHub release for every change is not a dev loop. Use **Load folder…**:

```
Settings → Extensions → Load folder… → pick your built folder
```

That takes a *snapshot copy* of the folder through the exact same validation as a
GitHub install. Rebuild, press **Reload** on the extension's row, and reopen your
view. Because the grant is bound to the installed bytes, a rebuild that changes
installed bytes asks for consent again when permissions are requested.

---

## 9. Publishing

```bash
npm run build          # produces the declared runtime/view files and shared chunks
git add dist && git commit
git tag v0.1.0 && git push --tags
gh release create v0.1.0
```

Agent Code prefers **the latest release tag** and falls back to the default
branch — a release is the author saying *this is ready*, whereas a branch is
whatever was pushed thirty seconds ago. Either way it downloads the **source
tarball**, which is why `dist/` must be committed.

The installer records the resolved ref, a SHA-256 of the tarball, and a SHA-256 of
the installed bundle, so "which bytes am I running" stays answerable.

Archives are capped at **32 MB**.

---

## 10. Failure modes you will hit

| Symptom | Cause |
|---|---|
| *"Repository has no agent-code.extension.json"* | manifest missing, or not at the repo root |
| *"Manifest points at … which does not exist in the repository"* | `dist/` not committed, or a wrong `entry` |
| *"contribution id … must start with …"* | a contributed id outside your namespace |
| *"registerCommand(x) — not declared"* | id missing from `contributes.commands` |
| *"View entry must export mount(element, context)."* (v2) or *"Extension entry must export activate(context) or a default extension module."* (v1) | wrong export, or the bundle is not an ES module |
| *"unknown capability … not available yet"* | you asked for a permission this build does not implement (§6) |
| *"extension targets Agent Code API v3, this build implements v2"* | Agent Code is older than your extension |
| *"The repository contains a symlink … that points outside"* | make internal symlinks relative (§4) |
| *"Extension failed to load: process is not defined"* | missing `define` — see §4 |
| *"The extension frame did not start"* | the bundle could not be served or was blocked by the frame CSP |
| renders unstyled | emitted CSS was never loaded by the view |
| `fetch` fails | you have no network access — see §0 |
| a shortcut does nothing while your view has focus | check Settings bindings and command context; modals expose palette/close while retaining native editing (§2) |

Install/load failures appear in Settings. Frame startup errors appear in the view
with Retry, and rejected commands reach the host command error path. Background
startup failures still need a dedicated management status surface; they currently
reach host diagnostics. One failed extension does not prevent others from starting.

---

## 11. What v1 deliberately does not have

Recorded so you know these are decisions, not oversights:

- **No background execution.** Activation events do not fire; your code runs while
  a view of yours is open (§1).
- **No network.** The frame's CSP permits only your own origin (§0). API v2
  reaches the network only through the brokered `api.net.fetch` (§6d, §6e).
- **No filesystem, transcript, git or prompt access.** The scoped filesystem APIs
  belongs to v2; v1 remains frozen (§6).
- **No marketplace.** The repo name is the trust decision.
- **No cross-extension communication.** Each extension is its own origin and cannot
  see another's frame, storage, or bundle.
