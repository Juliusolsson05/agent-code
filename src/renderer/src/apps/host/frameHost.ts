import type { AgentCodeApiV1, JsonValue } from '@renderer/apps/api/types'
import {
  extensionIdFromOrigin,
  FRAME_REQUEST_METHODS,
  frameRequestCorrelationSchema,
  frameRequestEnvelopeSchema,
  type FramePush,
  type FrameReply,
  type FrameRequest,
} from '@renderer/apps/host/frameProtocol'
import type { ExtensionCapability } from '@shared/types/extensions'
import { extensionRevision } from '@shared/types/extensions'
import { useAppStore } from '@renderer/app-state/hooks'

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
  bundleRevision: string
  api: AgentCodeApiV1
  runtime?: { viewId: string; onFailure(message: string): void }
}): FrameHostHandle {
  const { iframe, extensionId, bundleRevision, api } = options
  let disposed = false
  const connectionId = options.runtime ? crypto.randomUUID() : null
  let attachment: ReturnType<typeof window.api.extensionsRuntimeAttach> | undefined
  // Subscribe before attaching: activate() can publish state before the attach
  // reply arrives. The child compares sequences to reject an older snapshot.
  const unsubscribeRuntime = connectionId ? window.api.onExtensionsRuntimeView(event => {
    if (disposed || event.connectionId !== connectionId) return
    if (event.kind === 'state') post({ kind: 'agent-code-ext:runtime-state', snapshot: event.snapshot })
    else options.runtime?.onFailure(event.error)
  }) : undefined

  const assertCurrentInstallation = (): void => {
    const installed = useAppStore.getState().installedExtensions.find(entry => entry.manifest.id === extensionId)
    // Publication updates the store synchronously, while React unmounts frames
    // later. Close that gap here: an old frame loses broker authority as soon as
    // the update/remove event lands, even while its DOM is still on screen.
    if (disposed || !installed || !installed.present || extensionRevision(installed) !== bundleRevision) {
      throw new Error('This extension installation is no longer active.')
    }
  }
  // The origin this frame's messages MUST carry. The scheme gives every extension
  // its own origin (`agent-code-ext://<id>`), so this is both the target for our
  // pushes and the identity we check on every inbound message.
  const expectedOrigin = `agent-code-ext://${extensionId}`

  // Hash once when this generation starts, then reuse its exact approved set.
  // Every request also checks the current generation above. Publication events
  // revoke the old broker before React teardown, so caching does not postpone
  // permission downgrades until the user closes the view.
  const grantPromise: Promise<readonly ExtensionCapability[]> = window.api
    .extensionGrantedCapabilities(extensionId, bundleRevision)
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
    // Requests can finish after a failed startup or explicit retry. A replacement
    // document may share this WindowProxy AND origin, so targetOrigin alone does
    // not prevent a late reply from the old broker reaching the new attempt.
    if (disposed) return
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
    'runtime.attach': null,
    'runtime.request': null,
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
    'fs.readText': 'fs.read',
    'fs.writeText': 'fs.write',
    'notifications.show': 'notifications.show',
    'service.start': 'service.run',
    'service.stop': 'service.run',
    'service.status': 'service.run',
    'service.invoke': 'service.run',
    'service.expose': 'net.listen',
    // NOT pre-gated here: net.fetch needs net.connect for a private address
    // and net.origins for a declared public origin, and only main holds the
    // verified origin list that decides which. Main enforces it before dialing
    // (capabilityService.requireGrantFor); a renderer-side guess could only be
    // wrong in one direction or the other.
    'net.fetch': null,
    // Tier 0: id-scoped by main from the (extensionId, revision) this broker
    // fixed before hearing the child. See main/extensions/secrets.ts.
    'secrets.get': null,
    'secrets.set': null,
    'secrets.delete': null,
  }

  const perform = async (request: FrameRequest): Promise<unknown> => {
    assertCurrentInstallation()
    // One gate, before the dispatch, so no arm can accidentally skip it.
    const needed = REQUIRED_CAPABILITY[request.method]
    if (needed) await requireGrant(needed)
    assertCurrentInstallation()

    switch (request.method) {
      case 'runtime.attach':
        if (!connectionId || !options.runtime) throw new Error('This view uses the legacy extension runtime.')
        attachment ??= window.api.extensionsRuntimeAttach(extensionId, bundleRevision, options.runtime.viewId, connectionId)
        return attachment
      case 'runtime.request':
        if (!connectionId || !attachment) throw new Error('The extension runtime is not attached.')
        await attachment
        assertCurrentInstallation()
        return window.api.extensionsRuntimeRequest(connectionId, request.name, request.input)

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
      // Tier 2 is performed in main. The application renderer remains the
      // authenticated broker, but never receives an arbitrary root or performs
      // filesystem I/O itself.
      case 'fs.readText':
      case 'fs.writeText':
      case 'notifications.show':
      case 'service.start':
      case 'service.stop':
      case 'service.status':
      case 'service.invoke':
      case 'service.expose':
      case 'net.fetch':
      case 'secrets.get':
      case 'secrets.set':
      case 'secrets.delete':
        return window.api.extensionsServiceRequest(extensionId, bundleRevision, request)
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
    // 3. It is OUR envelope (kind tag + correlation id). Anything else — an
    //    unrelated library's postMessage, a devtools bridge — is ignored.
    const correlation = frameRequestCorrelationSchema.safeParse(event.data)
    if (!correlation.success) return
    // 4. The request itself matches the schema. A recognisable request that
    //    does not is ANSWERED with ok:false (#1151 design review): dropping it
    //    left the extension's promise pending forever, while the runtime
    //    transport rejects the same call. The reply is sanitised — it may name
    //    a KNOWN method, never echo a submitted value (a rejected
    //    secrets.set carries the secret; zod's issue text can quote input).
    const parsed = frameRequestEnvelopeSchema.safeParse(event.data)
    if (!parsed.success) {
      const method = (event.data as { request?: { method?: unknown } }).request?.method
      post({
        kind: 'agent-code-ext:reply',
        id: correlation.data.id,
        ok: false,
        error: typeof method === 'string' && FRAME_REQUEST_METHODS.has(method)
          ? `Invalid arguments for ${method}.`
          : 'Unknown extension API request.',
      })
      return
    }

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
  return {
    push: post,
    granted: grantPromise,
    dispose: () => {
      if (disposed) return
      disposed = true
      window.removeEventListener('message', onMessage)
      unsubscribeRuntime?.()
      if (connectionId) void window.api.extensionsRuntimeDetach(connectionId).catch(() => {})
    },
  }
}
