// Floating agent-status overlay contract.
//
// The overlay is a second, always-on-top BrowserWindow that shows a
// compact "which agents are working / waiting / done" readout while the
// user is in another app (Chrome, editor, etc). It deliberately does NOT
// consume the session IPC stream (session:process-state, session:conditions,
// ...): deriving activity, attention labels, and human titles from raw
// events would duplicate the renderer's whole session-runtime layer in a
// second bundle and drift the moment either copy changed.
//
// Instead the MAIN renderer — which already owns all of that derivation
// (dispatchActivity, dispatchAttentionLabelFromConditions, sessionTitle) —
// publishes this precomputed snapshot to main, main caches-and-forwards it
// to the overlay window, and the overlay renders it verbatim. Main and the
// overlay are byte movers; the main renderer is the single source of truth
// for what each field means. Consequence to keep in mind: if the main
// window is closed or hung, the overlay goes stale — acceptable, because
// the overlay is meaningless without a running workspace behind it.

/** Mirrors DispatchAgentActivity (renderer) value-for-value. Redeclared
 *  here rather than imported because shared/ must not depend on renderer
 *  code; the renderer-side reporter is the one place that converts. */
export type OverlayAgentActivity =
  | 'starting'
  | 'working'
  | 'running'
  | 'idle'
  | 'exited'

export type OverlayAgentRow = {
  sessionId: string
  /** Human title, already resolved by the reporter (session title or cwd
   *  basename — same rule as the Dispatch list). */
  title: string
  /** Owning project tab title. The overlay shows it as a small chip only
   *  when the snapshot spans more than one project. */
  projectTitle: string
  pinned: boolean
  activity: OverlayAgentActivity
  /** Non-null when the agent is blocked on the user (permission prompt,
   *  trust dialog, ...). Takes visual priority over `activity` — this is
   *  the state the overlay exists to surface while you're in Chrome. */
  attentionLabel: string | null
  /** Human activity verb from the provider ("running Bash"), if any. */
  statusText: string | null
}

export type AgentOverlaySnapshot = {
  agents: OverlayAgentRow[]
  /** The renderer's Settings object, passed opaquely so the overlay can
   *  call the same applyTheme() the main window uses. Typed as an opaque
   *  record on purpose: the renderer owns the Settings shape (same
   *  "renderer owns the JSON, main is a byte mover" contract as
   *  workspace.json) and shared/ must not import renderer types. */
  theme: Record<string, unknown> | null
}

/** Pushed to the overlay window on `agent-overlay:state`. `expanded` is
 *  only present on the initial post-load push — it restores the persisted
 *  pill/list mode. Later pushes omit it so a snapshot update can never
 *  fight the user's in-flight expand/collapse. */
export type AgentOverlayStateEvent = {
  snapshot: AgentOverlaySnapshot | null
  expanded?: boolean
}
