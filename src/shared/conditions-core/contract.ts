// conditions-core / contract.ts
//
// This file is the APP-SIDE SOURCE OF TRUTH for the condition wire format
// and the (forward-looking) headless module contract.
//
// WHY this file exists
// --------------------
// The "conditions" system models interactive TUI scenarios that a provider
// (Claude / Codex) surfaces while a session is live: trust dialogs, permission
// prompts, resume/compaction strips, command-approval overlays, slash pickers.
// Both providers emit a UNIFIED snapshot shape over the wire:
//
//   ProviderConditionSnapshot =
//     { provider, conditions: Record<kind, { kind, state, actions }>, ts }
//
// Until now the action types (ConditionAction & friends) lived only in
// `src/shared/types/providerConditions.ts`. That file mixes the generic
// wire primitives (actions) with the provider-SPECIFIC state shapes
// (ClaudeTrustDialogState, CodexApprovalState, …). For the registry framework
// we want the GENERIC, provider-agnostic primitives to have a clean home that
// neither provider's renderer nor the (future) headless core has to reach
// "sideways" into a types file to import.
//
// So the canonical definitions of the action union now live HERE, and
// `providerConditions.ts` re-exports them. That keeps every existing import
// site working byte-for-byte (no churn in dozens of files) while giving the
// core a dependency-clean anchor. See docs/design/conditions-system.md.

// ── Wire action primitives ──────────────────────────────────────────────────
//
// An action is something the UI can DO in response to a condition. Today every
// live action is a `pty` action: a raw keystroke string we write straight back
// into the session's PTY (e.g. '\r' to accept a trust dialog, '3\r' to deny a
// permission prompt). The keystrokes ARE the contract with the underlying TUI —
// the provider's real terminal program reads them and advances its own state.
//
// `custom` actions are the escape hatch for conditions that cannot be safely
// represented as one raw keystroke. AskUserQuestion uses this path: the renderer
// sends semantic labels/text, then the Claude headless resolver reparses the
// live terminal between writes so multi-question and multi-select prompts fail
// closed instead of spraying stale digits into the PTY.

export type ConditionPtyAction = {
  kind: 'pty'
  id: string
  label: string
  // Raw bytes/keystrokes written verbatim to the session PTY. This string is
  // the load-bearing value — it must match exactly what the provider's TUI
  // expects for the corresponding choice.
  data: string
}

export type ConditionCustomAction = {
  kind: 'custom'
  id: string
  label: string
  // Logical name of a resolver the headless/main side knows how to run. The
  // renderer routes this through `session:resolveCondition`; provider modules
  // claim only the names they own and unknown names must become structured
  // failures, not silent success.
  name: string
  // Optional structured payload consumed by the named resolver. This stays
  // deliberately untyped at the core layer: a parser/driver pair owns its own
  // protocol, and forcing every condition through a shared payload schema would
  // recreate the rigid, hardcoded plumbing the conditions framework is meant to
  // retire. Provider-specific modules narrow this value at the edge where they
  // know what their resolver accepts.
  payload?: unknown
}

export type ConditionAction = ConditionPtyAction | ConditionCustomAction

// ── Generic condition record + snapshot shapes ──────────────────────────────
//
// These describe the wire format in a provider-agnostic way. Each provider's
// concrete union (ClaudeCondition / CodexCondition in providerConditions.ts)
// is a more strongly-typed specialization of ConditionRecord; the GENERIC
// forms here are what the core outlet routes over (it only reads `kind`, never
// `state`, so erasing the precise state type is sound — see ConditionOutlet).

export type ConditionRecord<K extends string = string, S = unknown> = {
  kind: K
  state: S
  actions: ConditionAction[]
}

export type ConditionSnapshot<P extends string = string> = {
  provider: P
  // Partial map keyed by kind. At most one record per kind is live at a time.
  conditions: Record<string, ConditionRecord>
  ts: number
}

// ── Headless module contract (FORWARD-LOOKING; not consumed in this PR) ──────
//
// A ConditionModule is the HEADLESS half of a condition: given some input `I`
// (typically a parsed screen buffer / event), `detect` decides whether the
// condition is currently live and, if so, produces its `state` `S` (or null).
// `actions` maps that state to the list of choices the UI can dispatch.
//
// CRITICAL DESIGN NOTE — detect is a FREE-FORM FUNCTION.
// `detect: (input: I) => S | null` is deliberately typed as an arbitrary
// function with NO imposed structure. The planned detection toolkit (regex/
// cursor helpers) is an OPTIONAL helper library, never a straitjacket: any
// parser may use its own ad-hoc regex/cursor logic and reach for shared
// helpers only where they happen to fit. Nothing here constrains how detect
// arrives at its answer.
//
// This type is defined now for documentation + so the future headless core can
// be authored against a stable contract. It is NOT imported by any runtime
// path in this PR (the renderer framework only consumes the VIEW half — see
// view.ts). Migrating the live emitters onto these modules is a later PR.

// WHY the 4th generic `Ctx` (defaulting to `unknown`)
// ---------------------------------------------------
// `resolve` is the slot a headless module uses to settle a `custom` action
// through something OTHER than a single keystroke. The first real consumer
// (PR roadmap step 4-5: the AskUserQuestion module + the `sendThenReparse`
// answering driver) needs to write a keystroke, wait for the screen to settle,
// re-run detect, and possibly send again — a MULTI-STEP exchange. That driver
// must hand `resolve` a live handle (the terminal / `sendThenReparse`
// capability) so the module can drive the back-and-forth.
//
// We make that handle a GENERIC `Ctx` rather than baking a concrete type in now
// for two reasons: (1) the handle's exact shape isn't designed yet (it lands
// with the driver PR), and pinning it prematurely would force a contract change
// — and a re-sync of the vendored headless copy — the moment it's wrong; (2)
// different modules may need different capabilities, so each module specifies
// the `Ctx` it actually consumes while the contract itself stays stable.
// Defaulting to `unknown` keeps every forward-looking module that DOESN'T
// resolve (all of them today) writing `ConditionModule<K, I, S>` with no extra
// param and no behavior change.
//
// The action arg is narrowed to `ConditionCustomAction` (not the full
// `ConditionAction` union): `pty` actions resolve via the dispatch pty arm and
// never reach `resolve`, so a resolver only ever sees `custom` actions.
// Narrowing here means consumers don't have to re-discriminate the union inside
// every resolver body.
export type ConditionModule<K extends string, I, S, Ctx = unknown> = {
  kind: K
  // Free-form detector. Returns the condition state when live, else null.
  detect: (input: I) => S | null
  // State → the actions the UI may dispatch for this condition.
  actions: (state: S) => ConditionAction[]
  // Optional structured resolver for `custom` actions. Dormant today; present
  // so headless modules that one day need non-keystroke resolution have a slot.
  // `ctx` carries the live-terminal / `sendThenReparse` handle for multi-step
  // answering — see the `Ctx` generic WHY above.
  resolve?: (action: ConditionCustomAction, ctx: Ctx) => unknown | Promise<unknown>
}

// Identity helper. Exists purely so module-definition call sites read as
// `defineModule({ ... })` and get full inference of K/I/S/Ctx from the literal,
// mirroring `defineView`. No runtime behavior — it returns its argument.
export function defineModule<K extends string, I, S, Ctx = unknown>(
  module: ConditionModule<K, I, S, Ctx>,
): ConditionModule<K, I, S, Ctx> {
  return module
}
