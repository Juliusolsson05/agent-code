export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

// --- Tier-1 observe snapshots ------------------------------------------------
// Curated, fully-serializable projections of host state — NOT the live store
// objects, which carry renderer-only handles and would not survive the frame
// boundary. These are point-in-time reads; live updates arrive over the push
// channel (Group D). Kept deliberately minimal: an extension gets identity and
// shape, not the host's internal runtime.

export type ExtensionWorkspaceSnapshot = {
  activeTabId: string | null
  tabIds: string[]
  sessionCount: number
}

export type ExtensionSessionSnapshot = {
  id: string
  /** Provider/terminal/extension-view kind, or null if unset. */
  kind: string | null
  cwd: string
  title: string | null
}

export type ExtensionPaneSnapshot = {
  tabId: string
  /** Session ids of the leaves in this tab's tile tree, in tree order. */
  leafSessionIds: string[]
}

/**
 * The Agent Code app host API, version 1.
 *
 * WHY this exists in a stage where apps are compiled into the renderer and could
 * simply `import { useAppStore }`: this object IS the migration boundary. An app
 * that talks only through it can be lifted into its own repository and loaded at
 * runtime — through a custom scheme or an iframe — with no edits inside it. An app
 * that reaches into `@renderer/*` cannot, and the cost of discovering that is a
 * simultaneous rewrite of every app that exists. The rule is binary and checkable
 * with one grep, which is the only kind of architectural rule that survives contact
 * with a codebase this size.
 *
 * WHY every method returns a Promise, including ones that could be synchronous
 * today: under a future postMessage transport nothing can be synchronous, and a
 * signature cannot be widened from `void` to `Promise<void>` later without touching
 * every call site in every app. It costs nothing now. Of everything in this design
 * this is the single highest-value forward-compatibility decision, and it is also
 * the easiest one to lose by accident — if you are tempted to make something here
 * synchronous "because it obviously is," that is the temptation this comment exists
 * to stop.
 *
 * WHY the surface is this small: it is Tier 0 — everything an app may have without
 * asking anyone's permission. Workspace, session, transcript, git, filesystem and
 * network access are Tiers 1-3, each gated behind a manifest capability and a
 * consent flow that do not exist yet. Adding one before a real app needs it means
 * guessing a contract with no consumer to validate it against, and a wrong guess in
 * a versioned ABI is far more expensive than a late one.
 *
 * Versioning: this interface is frozen once an app outside this repo depends on it.
 * A v2 is a new `AgentCodeApiV2` built from the same internals with `createHostV1`
 * kept alongside it, dispatched on a manifest `apiVersion` — not an edit to this
 * file. That is roughly thirty lines and is the whole reason the surface is one
 * object rather than 153 flat methods.
 */
export interface AgentCodeApiV1 {
  readonly extension: {
    /** This app's id. Matches its AppDefinition id and its storage namespace. */
    readonly id: string
    readonly apiVersion: 1
  }

  readonly storage: {
    get<T extends JsonValue>(key: string): Promise<T | undefined>
    set(key: string, value: JsonValue): Promise<void>
    delete(key: string): Promise<void>
    keys(): Promise<string[]>
  }

  readonly ui: {
    /** Close this app's view. */
    close(): Promise<void>
    /**
     * Transient app-wide toast. Deliberately not an OS notification — a background
     * app that can raise system notifications is a Tier 3 capability, because it
     * can interrupt the user while they are working in another application.
     */
    showToast(message: string): Promise<void>
  }

  readonly theme: {
    /**
     * Resolved `--theme-*` custom properties, e.g. `{ '--theme-surface': '#111113' }`.
     *
     * Apps should prefer plain CSS — `background: var(--theme-surface)` — which
     * cascades for free today and keeps working unchanged across a frame boundary
     * once the host pushes the same variables into the child document. This
     * accessor exists only for imperative consumers that cannot use CSS: canvas
     * drawing, inline SVG fill computation, chart libraries.
     *
     * Only the `--theme-*` layer is exposed, never the `--color-*` Tailwind binding
     * layer. The former is a stable contract; the latter is an implementation
     * detail of how the app's utilities are wired, and depending on it would couple
     * an app to the host's build system — exactly what portability forbids.
     */
    tokens(): Promise<Record<string, string>>
  }

  // --- Tier 1 — read-only metadata (capability-gated) ------------------------
  // These require a granted manifest permission (workspace.observe /
  // sessions.observe / panes.observe). The frame broker denies the call with an
  // error if the grant is absent, so an extension that did not request the
  // capability never reaches these. Snapshots today; a live subscription is a
  // Group-D addition, not a signature change here.

  readonly workspace: {
    /** Point-in-time workspace shape. Requires `workspace.observe`. */
    observe(): Promise<ExtensionWorkspaceSnapshot>
    /**
     * Fire `listener` whenever the workspace changes; returns an unsubscribe.
     * The listener receives no argument — call observe() to read fresh state. This
     * is the live half of observe: the host pushes a change nudge, the extension
     * re-reads. Requires `workspace.observe` (the re-read is what's gated).
     */
    subscribe(listener: () => void): () => void
  }

  readonly sessions: {
    /** All sessions' identity/shape. Requires `sessions.observe`. */
    observe(): Promise<ExtensionSessionSnapshot[]>
    /** Fire on any session change; returns an unsubscribe. Re-read via observe(). */
    subscribe(listener: () => void): () => void
  }

  readonly panes: {
    /** The tile layout as leaf ids per tab. Requires `panes.observe`. */
    observe(): Promise<ExtensionPaneSnapshot[]>
    /** Fire on any pane-layout change; returns an unsubscribe. Re-read via observe(). */
    subscribe(listener: () => void): () => void
  }
}
