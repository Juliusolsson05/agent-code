# Conditions System — Design

> Status: evergreen design doc. Reflects the architecture as of the
> condition-module registry framework (PR-1). Updated alongside the code, not
> after it. If this drifts from the code, the code wins — fix this doc.

## What a "condition" is

A **condition** models an interactive TUI scenario that a provider (Claude /
Codex) surfaces while a session is live and that the GUI must render and let the
user resolve. Today's live conditions:

| Provider | Kind                       | UI                          | Resolves by |
|----------|----------------------------|-----------------------------|-------------|
| Claude   | `claude.trust-dialog`      | modal "Trust this folder?"  | keystroke   |
| Claude   | `claude.permission-prompt` | modal permission request    | keystroke   |
| Claude   | `claude.resume-prompt`     | inline strip                | keystroke   |
| Claude   | `claude.compaction`        | inline strip (read-only)    | —           |
| Claude   | `claude.slash-picker`      | (not rendered via outlet)   | keystroke   |
| Claude   | `claude.ask-user-question` | feed row + terminal picker  | custom      |
| Codex    | `codex.trust-dialog`       | modal "Trust this dir?"     | keystroke   |
| Codex    | `codex.approval`           | inline approval strip       | keystroke   |

Most live conditions resolve by writing a **raw keystroke string into the
session PTY**. Those keystrokes are the entire contract with the underlying
provider's real terminal program: `'\r'` accepts, `'3\r'` denies a permission
prompt, `'\x1b'` cancels, arrow escapes (`'\x1b[A'` / `'\x1b[B'`) move a
selection. AskUserQuestion is the exception: it resolves through a named
`custom` action because a single semantic answer can require several reparsed
terminal steps.

## Wire format (UNCHANGED by the registry framework)

Both providers emit a unified snapshot:

```ts
ProviderConditionSnapshot =
  | { provider: 'claude'; conditions: ClaudeConditionMap; ts: number }
  | { provider: 'codex';  conditions: CodexConditionMap;  ts: number }
```

where each map is `Partial<Record<kind, { kind, state, actions }>>` — at most
one live record per kind. `state` is provider-specific; `actions` is the
generic `ConditionAction[]` (a `pty` keystroke action, or a named `custom`
resolver action). See `src/shared/types/providerConditions.ts` (provider state shapes +
unions) and `src/shared/conditions-core/contract.ts` (the generic action/record
primitives that file now re-exports).

## Three-layer architecture

```
┌─ Layer 1: conditions-core (provider-agnostic) ──────────────────────────────┐
│  src/shared/conditions-core/                                                 │
│    contract.ts       wire action primitives + ConditionRecord/Snapshot +     │
│                      the FORWARD-LOOKING headless ConditionModule contract    │
│    view.ts           ConditionView / ConditionViewProps / AttentionLevel      │
│    ConditionOutlet.tsx  the ONE generic outlet (routes snapshot by kind)      │
│    dispatch.ts       makeDispatch / makeDispatchFromOnSend (pty arm wired,    │
│                      custom arm delegates to a resolver when provided)         │
├─ Layer 2: provider modules ─────────────────────────────────────────────────┤
│  src/providers/claude/renderer/conditions/views.tsx  → CLAUDE_VIEWS           │
│  src/providers/codex/renderer/conditions/views.tsx   → CODEX_VIEWS            │
│  (thin adapters wrapping the existing modal components)                       │
├─ Layer 3: unchanged relay ──────────────────────────────────────────────────┤
│  headless emit → sessionManager → forwarder → IPC → applyConditionSnapshot    │
│  (this PR touches NONE of it; see "Deferred seam")                            │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Layer 1 — conditions-core (the framework)

The core knows **nothing about specific kinds**. It defines two halves of a
condition's contract and the machinery to route + dispatch:

- **The view half** (`view.ts`, consumed now): a `ConditionView<K,S>` bundles
  everything the renderer needs for ONE kind — its `Component`
  (`React.ComponentType<ConditionViewProps<S>>`), an optional `attention(state)`
  classifier, and a `layout` hint. `ConditionViewProps<S> =
  { state: S; actions: ConditionAction[]; dispatch }`.
- **The headless half** (`contract.ts`): a `ConditionModule<K,I,S>` bundles a
  `detect(input) → state | null`, an `actions(state) → ConditionAction[]`, and
  an optional `resolve`. The app-side copy is the source that is vendored into
  the headless submodules so provider emitters and resolvers share the same
  contract.

The **generic outlet** (`ConditionOutlet.tsx`) takes `{ snapshot, registry,
dispatch }`, iterates `Object.values(snapshot.conditions)`, looks each record's
`kind` up in `registry`, and renders `<View.Component state actions dispatch/>`.

**On render order.** The old per-provider outlets rendered their modals in a
fixed, hand-written JSX order. The new outlet instead renders in
`Object.values(snapshot.conditions)` **insertion order** (the order the headless
emitter inserted kinds into the snapshot map). These are NOT guaranteed to be
the same sequence — so this is not "byte-identical render order" in general.
They ARE behaviorally equivalent under the system's current invariant: **at most
one live overlay is shown at a time**, so there is never a stack to order. While
that invariant holds, render order is unobservable and the difference is moot.
If a future change ever ships **multiple simultaneous overlays**, insertion
order would become load-bearing and is the wrong thing to depend on; at that
point the outlet should sort by an explicit per-view `priority` field (a
forward reference — `priority` is not defined on `ConditionView` today).

The outlet also **skips unknown kinds** (an older app paired with a newer
headless emitter simply doesn't draw a condition it has no view for — the same
graceful-old-client posture the wire format already assumes).

The **dispatch driver** (`dispatch.ts`) turns a chosen action into a side
effect. The `pty` arm calls `sendInput`/`onSend` with the action's raw `data`.
The `custom` arm calls the resolver callback passed by the host surface; if no
resolver is provided it throws rather than silently dropping the action.

Type-safety guardrail: the core stores **erased** views
(`ConditionView<string, unknown>`) in `Record<string, ConditionView>`. That
erasure is sound precisely because the core's only job is to route by `kind`; it
never reads `state`. The strongly-typed `S` is re-established inside each view
module (which knows its own kind). No `any` in the core — `unknown` + the
kind-keyed registry. The precise→erased crossing is performed by a single
documented helper, `eraseRegistry` (`view.ts`), whose input is a checked
`Partial<ViewRegistry<M>>`; this proves the kind↔view binding BEFORE erasing `S`,
replacing the earlier per-view `as unknown as ConditionView` casts that bypassed
the check. See "Layer 2" for the call shape.

### Layer 2 — provider modules (adapters over existing modals)

Each provider owns a `views.tsx` that wraps its **existing** modal components as
thin view adapters and exports a `Record<string, ConditionView>` registry. The
registry is an **explicit object literal** checked against a per-provider
`StateByKind` map (the source of truth binding each kind to its concrete state
type) by the `eraseRegistry` helper:

```ts
type CodexStateByKind = {
  'codex.approval': CodexApprovalState
  'codex.trust-dialog': CodexTrustDialogState
}

export const CODEX_VIEW_LIST = [approvalView, codexTrustView] as const

export const CODEX_VIEWS: Record<string, ConditionView> = eraseRegistry<CodexStateByKind>({
  'codex.approval': approvalView,
  'codex.trust-dialog': codexTrustView,
})
```

with `ViewRegistry<M> = { [K in keyof M & string]: ConditionView<K, M[K]> }` and
`eraseRegistry<M>(reg: Partial<ViewRegistry<M>>): Record<string, ConditionView>`
(both in `view.ts`). The literal is type-checked against `CodexStateByKind` by
`eraseRegistry`'s parameter, so filing `approvalView` under `'codex.trust-dialog'`
is a **compile error at the call site**. `Partial` is needed because some
conditions intentionally have no outlet view (`claude.slash-picker` is consumed
by the composer path instead).

**Why a helper instead of a plain `satisfies` + annotation.** The outlet stores
erased views and renders each Component with `state: unknown`. Because `state`
sits in the Component's (contravariant) parameter position, a precise
`ConditionView<'codex.approval', CodexApprovalState>` is genuinely NOT a subtype
of the erased `ConditionView<string, unknown>` — so assigning the precise literal
to a `Record<string, ConditionView>` annotation does not type-check, and the old
code reached for a per-view `as unknown as ConditionView` (which ALSO discarded
the kind↔view check). `eraseRegistry` localizes that unavoidable erasure to a
SINGLE documented cast whose INPUT is fully checked (`Partial<ViewRegistry<M>>`):
the kind↔view binding is proven before the cast, and the cast only erases `S` for
routing. The erasure is sound by the runtime invariant the types can't see — the
outlet only ever feeds a Component the state from the same snapshot record under
the same kind. See `eraseRegistry`'s WHY block in `view.ts`.

The `as const` list is retained as the source of truth for later PRs to derive
the provider's kind union via `typeof CODEX_VIEW_LIST[number]['kind']` without
restating it.

**Adapter shape.** We do NOT rewrite the modals. Each adapter renders the
existing modal with its EXACT current prop shape, and translates its
`onSend(data)` callback into `dispatch({ kind: 'pty', id: 'raw', label: '',
data })`. The dispatch pty arm then calls `onSend(data)` / `sendInput` — the
byte-for-byte same send path the old per-provider outlets used. The modals keep
their exact keystrokes, their capture-phase keydown handlers, and their
state→props mappings (e.g. Codex approval's `commandParts ?? command.split(/\s+/)`
fallback, compaction's `visible && phase` guard, each modal's `visible` gate).

`attention` per view matches today's `selectors.ts` behavior
(permission/approval → `ACTION`, trust → `TRUST`, resume → `RESUME`,
compaction-with-error → `ERROR`). **It is defined but not consumed in PR-1** —
see "Deferred seam".

### Layer 3 — unchanged relay (the data-flow seam)

The path from "headless saw a condition" to "renderer applies a snapshot" is
untouched by the registry framework:

```
headless emitter
  → sessionManager (emits a 'conditions' payload, ~sessionManager:457)
  → forwarder.ts:60   manager.on('conditions', p => sendToMainWindow('session:conditions', p))
  → IPC 'session:conditions'
  → useIpcSubscriptions.ts: applyConditionSnapshot(current, snapshot) (~:195, applied ~:1065)
  → runtime.conditions
  → TileLeaf.tsx (~:510)  <ProviderConditionOutlet conditions={runtime.conditions} onSend={send}/>
```

`send` (TileLeaf's prop) is already bound to the active session and ultimately
reaches `window.api.sendInput(sessionId, data)` → `session:input`. PR-1 reuses
that `onSend` verbatim via `makeDispatchFromOnSend`.

## Why `custom` actions exist

The wire `ConditionAction` union includes a `custom` action (resolve via a named
structured resolver instead of a keystroke). AskUserQuestion uses it because the
renderer has semantic answers while Claude's TUI exposes only the currently
visible question. The resolver path is:

```
AskUserQuestionRow
  → window.api.resolveCondition(sessionId, action)
  → main session:resolveCondition
  → ClaudeSession.resolveCondition
  → ClaudeCodeHeadless.resolveConditionAction
  → claude.askUserQuestion.answer module resolver
```

The dispatch `custom` arm still throws if a surface does not pass a resolver.
That is intentional: a custom action without its named resolver would otherwise
look clickable while doing nothing.

## CRITICAL DESIGN NOTE — `detect()` is free-form

**`detect()` is a free-form function — the detection toolkit is an OPTIONAL
helper library, never a straitjacket; any parser may use its own regex/cursor
logic and reach for shared helpers only where they fit.**

`ConditionModule.detect` is typed as an arbitrary `(input: I) => S | null`. The
type imposes NO structure on HOW detection happens. Shared detection helpers
(regex/cursor helpers) and provider-local drivers such as Claude's
`sendThenReparse` loop are **helper libraries** a parser may opt into. A parser
is free to use entirely ad-hoc regex/cursor logic and reach for shared helpers
only where they happen to fit.

## Registration model

- Each provider exports an `as const` array of `defineView({...})` results.
- The `Record<string, ConditionView>` registry is derived from that array.
- Provider unions are derived from the array via `typeof` where practical; the
  core stores erased views (sound because it routes by `kind` only).
- `defineModule` / `defineView` are identity helpers — they exist only to give
  call sites clean inference of `K`/`I`/`S` from the object literal.

## Vendor-sync plan for the headless core (packages are submodules)

`packages/claude-code-headless` and `packages/codex-headless` are **git
submodules**. The condition-module headless core (the `detect`/`actions`/
`resolve` implementations that run inside the headless processes) cannot simply
`import` from the app's `src/shared/conditions-core` across the submodule
boundary. The rule:

- The app's `src/shared/conditions-core/contract.ts` is the **authoritative**
  definition of the `ConditionModule` contract and the wire action primitives.
- The headless side gets a **vendored copy** of the contract (sync'd from the
  app, not a live import) so the submodule stays self-contained and buildable on
  its own. A check (golden/diff) keeps the vendored copy byte-identical to the
  app's source of truth; drift is a CI/review failure.
- App↔headless agreement is verified by keeping the vendored files synced in
  review and CI. If `src/shared/conditions-core/{contract,evaluator}.ts`
  changes, run `node scripts/sync-conditions-core.mjs` and commit the submodule
  copies too.

## Current integration state

The integration branch has the renderer framework, Codex/Claude headless
module evaluators, Claude AskUserQuestion liveness/answering, and Claude
slash-picker snapshot migration wired. Remaining cleanup is intentionally
smaller than the original roadmap: retire the legacy per-event Claude modal
channels once all consumers are proven gone, collapse duplicate public wire
types where practical, and keep docs/API references aligned with the vendored
submodule surfaces.
