import type { AgentCodeApiV1, JsonValue } from '@renderer/apps/api/types'
import {
  extensionIdFromOrigin,
  frameRequestEnvelopeSchema,
  type FramePush,
  type FrameReply,
  type FrameRequest,
} from '@renderer/apps/host/frameProtocol'
import type { ExtensionCapability } from '@shared/types/extensions'

// The trusted host-side broker for one extension frame (WS4, Decision A).
//
// It is the ONLY thing that both (a) can perform a capability and (b) can hear the
// frame. The extension iframe holds no capability; it posts a request, this broker
// verifies the request came from that exact frame at the expected origin, performs
// it against the real AgentCodeApiV1, and posts back a reply. Every trust decision
// lives here, in the parent realm, never in the child.
//
// The `api` passed in is the same `createAppHostApi(...)` instance the same-realm
// path uses, so storage/ui/theme behave identically across the boundary and there
// is exactly one implementation of each capability to audit.

export type FrameHostHandle = {
  /** Push theme tokens (or a mount command) into the child. */
  push: (message: FramePush) => void
  /**
   * The capabilities granted to this frame's extension, resolved once.
   *
   * Exposed so the view bridge can gate its observe subscription on the SAME
   * promise the broker gates requests on. It previously made its own
   * `extensionGrantedCapabilities` call, which meant every frame open recomputed
   * the bundle hash TWICE in the main process — and the IPC handler's comment
   * claimed it happened once, citing this cache.
   */
  granted: Promise<readonly ExtensionCapability[]>
  /** Detach the listener. Idempotent. */
  dispose: () => void
}

/** Compile-time proof that every FrameRequest method is handled. */
function assertNeverMethod(request: never): never {
  throw new Error(`unhandled frame request method: ${JSON.stringify(request)}`)
}

export function createFrameHost(options: {
  iframe: HTMLIFrameElement
  extensionId: string
  api: AgentCodeApiV1
}): FrameHostHandle {
  const { iframe, extensionId, api } = options
  // The origin this frame's messages MUST carry. The scheme gives every extension
  // its own origin (`agent-code-ext://<id>`), so this is both the target for our
  // pushes and the identity we check on every inbound message.
  const expectedOrigin = `agent-code-ext://${extensionId}`

  // The capability grant, fetched ONCE and cached as a promise. This is the "teeth"
  // of the tiered permission model: every Tier 1-3 request is gated on it below. The
  // grant is keyed on the installed sha256 in main (grantedCapabilities), so bytes
  // that were never consented to authorize nothing. Read here rather than in main's
  // per-feature IPC because that surface is deliberately NOT sender-bound — the frame
  // broker is the one renderer chokepoint every capability call already passes through.
  const grantPromise: Promise<readonly ExtensionCapability[]> = window.api
    .extensionGrantedCapabilities(extensionId)
    .catch(() => [])

  const requireGrant = async (capability: ExtensionCapability): Promise<void> => {
    const granted = await grantPromise
    if (!granted.includes(capability)) {
      // Becomes an `ok:false` reply automatically (perform's rejection is caught
      // below), which the child surfaces as a rejected api call. A denied capability
      // must fail loudly at the call, never silently return empty.
      throw new Error(`capability "${capability}" is not granted to ${extensionId}`)
    }
  }

  const post = (message: FrameReply | FramePush): void => {
    // targetOrigin is pinned to the extension's origin, never '*': a reply carrying
    // storage contents must not be deliverable to a frame that was navigated away
    // or replaced between request and reply.
    iframe.contentWindow?.postMessage(message, expectedOrigin)
  }

  /**
   * Which capability each method requires — DATA, not a convention inside a switch.
   *
   * The tier gate used to exist only as `await requireGrant(...)` lines sprinkled
   * through the switch below. Adding a Tier-2/3 member to frameRequestSchema and
   * forgetting its requireGrant line was a one-line, review-invisible privilege
   * escalation; there was nothing to notice the omission. As a Record keyed by the
   * method union, a new schema member does not COMPILE until its tier is declared.
   *
   * `null` means Tier 0 — no grant needed, available to every extension.
   */
  const REQUIRED_CAPABILITY: Record<FrameRequest['method'], ExtensionCapability | null> = {
    'storage.get': null,
    'storage.set': null,
    'storage.delete': null,
    'storage.keys': null,
    'ui.close': null,
    'ui.showToast': null,
    'theme.tokens': null,
    'workspace.observe': 'workspace.observe',
    'sessions.observe': 'sessions.observe',
    'panes.observe': 'panes.observe',
  }

  const perform = async (request: FrameRequest): Promise<unknown> => {
    // One gate, before the dispatch, so no arm can accidentally skip it.
    const needed = REQUIRED_CAPABILITY[request.method]
    if (needed) await requireGrant(needed)

    switch (request.method) {
      case 'storage.get':
        return api.storage.get(request.key)
      case 'storage.set':
        await api.storage.set(request.key, request.value as JsonValue)
        return undefined
      case 'storage.delete':
        await api.storage.delete(request.key)
        return undefined
      case 'storage.keys':
        return api.storage.keys()
      case 'ui.close':
        await api.ui.close()
        return undefined
      case 'ui.showToast':
        await api.ui.showToast(request.message)
        return undefined
      case 'theme.tokens':
        return api.theme.tokens()
      // Tier 1 — the grant was already enforced above by REQUIRED_CAPABILITY.
      case 'workspace.observe':
        return api.workspace.observe()
      case 'sessions.observe':
        return api.sessions.observe()
      case 'panes.observe':
        return api.panes.observe()
      default:
        // Exhaustiveness. Without it an unhandled method fell off the end returning
        // undefined, which the caller reported as `ok: true, result: undefined` — a
        // silent false success for a capability that was never performed.
        return assertNeverMethod(request)
    }
  }

  const onMessage = (event: MessageEvent): void => {
    // Three gates, all before the payload is trusted:
    // 1. It came from THIS frame's window (not another frame, not the top window).
    if (event.source !== iframe.contentWindow) return
    // 2. It carries this extension's origin. The browser stamps event.origin; the
    //    child cannot forge it. A message whose origin resolves to a different
    //    extension id — or to no valid id — is dropped, never mis-attributed.
    if (event.origin !== expectedOrigin) return
    if (extensionIdFromOrigin(event.origin) !== extensionId) return
    // 3. It matches the request schema. Anything else (an unrelated library's
    //    postMessage, a malformed frame) fails the parse and is ignored.
    const parsed = frameRequestEnvelopeSchema.safeParse(event.data)
    if (!parsed.success) return

    const { id, request } = parsed.data
    void perform(request).then(
      result => post({ kind: 'agent-code-ext:reply', id, ok: true, result }),
      error =>
        post({
          kind: 'agent-code-ext:reply',
          id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
    )
  }

  window.addEventListener('message', onMessage)
  let disposed = false
  return {
    push: post,
    granted: grantPromise,
    dispose: () => {
      if (disposed) return
      disposed = true
      window.removeEventListener('message', onMessage)
    },
  }
}
