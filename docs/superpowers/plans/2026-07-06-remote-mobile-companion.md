# Remote Mobile Companion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the owner watch every Agent Code session and send prompts / permission replies from a phone browser — LAN first, optional tunnel later — driving the real agents.

**Architecture:** Introduce a `SessionFeed` contract that abstracts "how the UI gets session events and sends input." The desktop keeps working via `IpcSessionFeed` (wraps today's `window.api.onSession*` + input calls). A new isolated main-process subsystem (`RemoteServer`) serves a phone web client that implements the same contract over WebSocket. A hard one-way dependency wall keeps all remote code out of core.

**Tech Stack:** Electron + React 18, TypeScript (ESM, `@main`/`@renderer`/`@shared`/`@mcp` path aliases), `ws` (already a dep), `zod` (already a dep), electron-vite (already multi-target), Vitest. Phase 2 adds bundled `cloudflared` under `third_party/` following the tmux/mitmproxy convention.

**Spec:** `docs/superpowers/specs/2026-07-06-remote-mobile-companion-design.md`

## Global Constraints

- **One-way dependency wall.** Core (`src/main/**` except `src/main/remote`, `src/main/ipc/remote.ts`; `src/renderer/**` except `features/remote` and `features/sessionFeed`; `src/providers/**`) MUST NOT import from `src/main/remote/**` or `src/remote-client/**`. If you deleted the remote tree, core must still compile. Enforced by review, not tooling (repo convention: no CI grep locks).
- **The only shared coupling is `SessionFeed`** in `src/shared/sessionFeed/`, importable by both renderer and remote client.
- **v1 phone scope is prompts + permission replies only.** No shell exec, no session spawn/kill, no provider switch — those message types do not exist in `protocol/messages.ts`.
- **ESM imports use `.js` suffixes** in `src/main`/`src/mcp` (NodeNext) and path aliases elsewhere — match each file's existing neighbours exactly.
- **Thick WHY comments** are mandatory (see `CLAUDE.md`): explain why, what constraint forced the shape, what breaks if an invariant fails.
- **No new permanent test files / no new `test:*` scripts** in feature PRs (repo convention). Co-locate Phase 0/1 tests as `*.test.ts` next to the unit under test (matches existing `sessionManager.wake.test.ts`, `BuiltInMcpHttpHost.test.ts`); a separate coverage pass owns broader suites.
- **Verification gate:** `tsc` must pass on both projects (`tsconfig.node.json` and `tsconfig.web.json`) — electron-vite build + vitest do NOT type-check (see project memory `project_verification_tsc_gate`). Run both before declaring any task done.
- **Server + tunnel are OFF by default**; both are explicit opt-in toggles.
- **Do branch/worktree work under `.worktrees/<name>`**, main checkout stays on `main` (repo convention).

---

# PHASE 0 — The `SessionFeed` refactor (standalone, ships alone)

**Deliverable:** The desktop renderer consumes session events + sends input through an injected `SessionFeed` instead of reaching for `window.api` directly. Zero user-visible change. The renderer becomes testable against a fake feed with no Electron. This is the enabling seam for the phone and aligns with provider plug-and-play (#394).

**Scope boundary (important, avoids scope creep):** `SessionFeed` covers ONLY the per-session event stream the phone needs and the input commands. It does NOT abstract desktop-only side channels that the phone will never call: `window.api.ghostAppend`, `window.api.gitWorktrees`, feed-debug, perf, LSP, editor FS. Those stay as direct `window.api` calls inside `useIpcSubscriptions.ts`.

## File Structure (Phase 0)

- Create `src/shared/sessionFeed/types.ts` — re-exports of the event payload types + the input DTOs, provider-neutral.
- Create `src/shared/sessionFeed/SessionFeed.ts` — the interface.
- Create `src/renderer/src/features/sessionFeed/IpcSessionFeed.ts` — desktop impl (delegates to `window.api`).
- Create `src/renderer/src/features/sessionFeed/SessionFeedContext.tsx` — React context + `useSessionFeed()` hook + provider.
- Create `src/renderer/src/features/sessionFeed/FakeSessionFeed.ts` — test double.
- Modify `src/renderer/src/app/App.tsx` — wrap the tree in `<SessionFeedProvider value={ipcSessionFeed}>`.
- Modify `src/renderer/src/workspace/hook/ipc/useIpcSubscriptions.ts` — take a `feed: SessionFeed` param; swap the ~9 `window.api.onSession*` calls for `feed.*`.
- Modify the input call sites to use the feed: `src/renderer/src/workspace/hook/actions/session.ts`, `.../actions/pane.ts`, `.../actions/provider.ts` (whichever call `api.session.sendInput` / `deliverPrompt` / `resolveCondition` — confirm with grep in Task 1).

## The contract (defined once; every later task depends on these exact names)

```ts
// src/shared/sessionFeed/SessionFeed.ts
import type {
  SessionStartedEvent, SessionScreenEvent, SessionJsonlEntriesEvent,
  SessionJsonlErrorEvent, SessionSemanticEvent, SessionConditionsEvent,
  SessionSubAgentsEvent, SessionExitEvent,
} from '@shared/sessionFeed/types'
import type { ConditionCustomAction, ResolveConditionResult } from '@shared/sessionFeed/types'

export type Unsub = () => void

/** The one seam between "UI wants session I/O" and "where it physically comes
 *  from". IpcSessionFeed (desktop) and WebSocketSessionFeed (phone) implement
 *  it. Listeners mirror the existing global one-listener-per-event-type shape
 *  in useIpcSubscriptions — each fires for ALL sessions and the callback
 *  dispatches by `sessionId`. We did NOT switch to per-session subscription:
 *  that would be a behavioural rewrite of the subscription hub, out of scope
 *  for a pure decoupling. */
export interface SessionFeed {
  // Listeners (subscribe once, dispatch by sessionId in the callback)
  onSessionStarted(cb: (e: SessionStartedEvent) => void): Unsub
  onSessionScreen(cb: (e: SessionScreenEvent) => void): Unsub
  onSessionJsonlEntries(cb: (e: SessionJsonlEntriesEvent) => void): Unsub
  onSessionJsonlError(cb: (e: SessionJsonlErrorEvent) => void): Unsub
  onSessionSemanticEvent(cb: (e: SessionSemanticEvent) => void): Unsub
  onSessionConditions(cb: (e: SessionConditionsEvent) => void): Unsub
  onSessionProcessState(
    cb: (e: { sessionId: string; active: boolean; status?: string }) => void,
  ): Unsub
  onSessionSubAgents(cb: (e: SessionSubAgentsEvent) => void): Unsub
  onSessionExit(cb: (e: SessionExitEvent) => void): Unsub

  // Commands (the v1 phone-allowed input surface)
  sendInput(sessionId: string, data: string, pasteId?: string): Promise<boolean>
  deliverPrompt(
    sessionId: string, prompt: string,
  ): Promise<{ ok: true } | { ok: false; message: string }>
  resolveCondition(
    sessionId: string, action: ConditionCustomAction,
  ): Promise<ResolveConditionResult>
}
```

`src/shared/sessionFeed/types.ts` re-exports the existing payload types from wherever they currently live (`@preload/api/types` today — Task 1 confirms the canonical source; if they live in preload, move the pure type declarations to `@shared/sessionFeed/types` and have preload re-export them, so `@shared` doesn't depend on `@preload`).

---

### Task 1: Confirm the seam and lock the contract types

**Files:**
- Read only: `src/preload/api/types.ts`, `src/preload/api/session.ts`, `src/renderer/src/workspace/hook/ipc/useIpcSubscriptions.ts`, and grep results.

- [ ] **Step 1: Enumerate every renderer call the feed must cover**

Run:
```bash
cd /Users/juliusolsson/Desktop/Development/agent-code
grep -rn "api\.session\.onSession\|window\.api\.onSession" src/renderer/src
grep -rn "api\.session\.sendInput\|api\.session\.deliverPrompt\|api\.session\.resolveCondition\|\.sendInput(\|\.deliverPrompt(\|\.resolveCondition(" src/renderer/src
```
Expected: the `onSession*` hits concentrate in `useIpcSubscriptions.ts`; the input hits are a small set of call sites in `workspace/hook/actions/*`. Record the exact file:line list — later tasks edit exactly these.

- [ ] **Step 2: Locate the canonical home of the payload types**

Run:
```bash
grep -rn "export type SessionScreenEvent\|export interface SessionScreenEvent\|SessionSemanticEvent\|SessionConditionsEvent" src/preload src/shared
```
Expected: types are declared in `src/preload/api/types.ts` (or re-exported from `@shared`). Decision rule: if declared in preload, the pure type declarations move to `src/shared/sessionFeed/types.ts` in Task 2 and preload re-exports them; if already in `@shared`, just re-export.

- [ ] **Step 3: Commit the finding as a comment block (no code yet)**

Write the grep results into the top of a scratch note in the plan's worktree (`.worktrees/remote-companion/NOTES-phase0.md`) so subsequent tasks reference the exact call-site list. Commit:
```bash
git add NOTES-phase0.md
git commit -m "chore(remote): record SessionFeed call-site inventory for phase 0"
```

---

### Task 2: Create the `SessionFeed` contract + shared types

**Files:**
- Create: `src/shared/sessionFeed/types.ts`
- Create: `src/shared/sessionFeed/SessionFeed.ts`
- Test: `src/shared/sessionFeed/SessionFeed.contract.test.ts`

**Interfaces:**
- Produces: the `SessionFeed` interface and `Unsub` type exactly as shown in "The contract" above; `types.ts` re-exporting `SessionStartedEvent`, `SessionScreenEvent`, `SessionJsonlEntriesEvent`, `SessionJsonlErrorEvent`, `SessionSemanticEvent`, `SessionConditionsEvent`, `SessionSubAgentsEvent`, `SessionExitEvent`, `ConditionCustomAction`, `ResolveConditionResult`.

- [ ] **Step 1: Write the failing test** — a structural test that the interface is satisfiable and that a minimal object shape type-checks.

```ts
// src/shared/sessionFeed/SessionFeed.contract.test.ts
import { describe, it, expect } from 'vitest'
import type { SessionFeed } from '@shared/sessionFeed/SessionFeed'

// A no-op feed proves the interface is implementable with the exact member
// names later tasks rely on. If a name drifts, this file fails to compile.
const noop: SessionFeed = {
  onSessionStarted: () => () => {},
  onSessionScreen: () => () => {},
  onSessionJsonlEntries: () => () => {},
  onSessionJsonlError: () => () => {},
  onSessionSemanticEvent: () => () => {},
  onSessionConditions: () => () => {},
  onSessionProcessState: () => () => {},
  onSessionSubAgents: () => () => {},
  onSessionExit: () => () => {},
  sendInput: async () => true,
  deliverPrompt: async () => ({ ok: true }),
  resolveCondition: async () => ({ ok: true } as never),
}

describe('SessionFeed contract', () => {
  it('is implementable and exposes the v1 command surface', () => {
    expect(typeof noop.sendInput).toBe('function')
    expect(typeof noop.deliverPrompt).toBe('function')
    expect(typeof noop.resolveCondition).toBe('function')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `NODE_ENV=test npx vitest run src/shared/sessionFeed/SessionFeed.contract.test.ts`
Expected: FAIL — cannot resolve `@shared/sessionFeed/SessionFeed`.

- [ ] **Step 3: Create `types.ts` then `SessionFeed.ts`**

Create `src/shared/sessionFeed/types.ts` re-exporting (or declaring, per Task 1 Step 2 decision) the payload types. Create `src/shared/sessionFeed/SessionFeed.ts` with the exact interface from "The contract". Add thick WHY comments on the listener-shape decision.

- [ ] **Step 4: Run test to verify it passes**

Run: `NODE_ENV=test npx vitest run src/shared/sessionFeed/SessionFeed.contract.test.ts`
Expected: PASS.

- [ ] **Step 5: Type-check both projects**

Run: `npx tsc -p tsconfig.node.json --noEmit && npx tsc -p tsconfig.web.json --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/shared/sessionFeed/
git commit -m "feat(remote): add SessionFeed contract and shared event types"
```

---

### Task 3: Implement `IpcSessionFeed` (desktop delegates to `window.api`)

**Files:**
- Create: `src/renderer/src/features/sessionFeed/IpcSessionFeed.ts`
- Test: `src/renderer/src/features/sessionFeed/IpcSessionFeed.test.ts`

**Interfaces:**
- Consumes: `SessionFeed` (Task 2), `window.api.onSession*` + `window.api.session.sendInput/deliverPrompt/resolveCondition` (existing preload surface — confirm exact access path from Task 1; it is `window.api.onSessionScreen(...)` etc. per `src/preload/api/session.ts`).
- Produces: `export const ipcSessionFeed: SessionFeed`.

- [ ] **Step 1: Write the failing test** — a fake `window.api` records delegation.

```ts
// src/renderer/src/features/sessionFeed/IpcSessionFeed.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

beforeEach(() => {
  const calls: string[] = []
  ;(globalThis as any).window = {
    api: {
      onSessionScreen: (cb: unknown) => { calls.push('onSessionScreen'); return () => {} },
      onSessionStarted: () => () => {},
      onSessionJsonlEntries: () => () => {},
      onSessionJsonlError: () => () => {},
      onSessionSemanticEvent: () => () => {},
      onSessionConditions: () => () => {},
      onSessionProcessState: () => () => {},
      onSessionSubAgents: () => () => {},
      onSessionExit: () => () => {},
      sendInput: vi.fn(async () => true),
      deliverPrompt: vi.fn(async () => ({ ok: true })),
      resolveCondition: vi.fn(async () => ({ ok: true })),
    },
    __calls: calls,
  }
})

describe('IpcSessionFeed', () => {
  it('delegates onSessionScreen to window.api', async () => {
    const { ipcSessionFeed } = await import('./IpcSessionFeed')
    ipcSessionFeed.onSessionScreen(() => {})
    expect((globalThis as any).window.__calls).toContain('onSessionScreen')
  })

  it('delegates sendInput to window.api', async () => {
    const { ipcSessionFeed } = await import('./IpcSessionFeed')
    await ipcSessionFeed.sendInput('s1', 'hi')
    expect((globalThis as any).window.api.sendInput).toHaveBeenCalledWith('s1', 'hi', undefined)
  })
})
```

Note: adjust the `window.api` access path to match the real preload shape from Task 1 (e.g. `window.api.session.sendInput` vs `window.api.sendInput`).

- [ ] **Step 2: Run test to verify it fails**

Run: `NODE_ENV=test npx vitest run src/renderer/src/features/sessionFeed/IpcSessionFeed.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `IpcSessionFeed`** — one thin delegating object; each method is the corresponding `window.api` call. WHY comment: this is the desktop's transport; it must stay a pure pass-through so the renderer's behaviour is byte-identical to before the refactor.

- [ ] **Step 4: Run test to verify it passes**

Run: `NODE_ENV=test npx vitest run src/renderer/src/features/sessionFeed/IpcSessionFeed.test.ts`
Expected: PASS.

- [ ] **Step 5: Type-check** — `npx tsc -p tsconfig.web.json --noEmit`. Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/features/sessionFeed/IpcSessionFeed.ts src/renderer/src/features/sessionFeed/IpcSessionFeed.test.ts
git commit -m "feat(remote): add IpcSessionFeed desktop implementation"
```

---

### Task 4: `SessionFeedContext` + `FakeSessionFeed`

**Files:**
- Create: `src/renderer/src/features/sessionFeed/SessionFeedContext.tsx`
- Create: `src/renderer/src/features/sessionFeed/FakeSessionFeed.ts`
- Test: `src/renderer/src/features/sessionFeed/SessionFeedContext.test.tsx`

**Interfaces:**
- Produces: `SessionFeedProvider` (React component, prop `{ value: SessionFeed; children }`), `useSessionFeed(): SessionFeed` (throws if used outside provider), `createFakeSessionFeed(): FakeSessionFeed` where `FakeSessionFeed` implements `SessionFeed` plus test helpers `emitScreen(e)`, `emitSemantic(e)`, ... and records `sendInput`/`deliverPrompt`/`resolveCondition` calls.

- [ ] **Step 1: Write the failing test**

```tsx
// src/renderer/src/features/sessionFeed/SessionFeedContext.test.tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SessionFeedProvider, useSessionFeed } from './SessionFeedContext'
import { createFakeSessionFeed } from './FakeSessionFeed'

function Probe() {
  const feed = useSessionFeed()
  return <div>{typeof feed.sendInput === 'function' ? 'has-feed' : 'no-feed'}</div>
}

describe('SessionFeedContext', () => {
  it('provides the injected feed to consumers', () => {
    const fake = createFakeSessionFeed()
    render(
      <SessionFeedProvider value={fake}>
        <Probe />
      </SessionFeedProvider>,
    )
    expect(screen.getByText('has-feed')).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run test to verify it fails** — `NODE_ENV=test npx vitest run src/renderer/src/features/sessionFeed/SessionFeedContext.test.tsx`. Expected: FAIL — modules not found.

- [ ] **Step 3: Implement** the context (`createContext<SessionFeed | null>(null)`, provider, `useSessionFeed` that throws a clear error outside a provider) and `FakeSessionFeed` (holds per-event callback sets; `emitX` invokes them; command methods push to a `calls` array and return canned results).

- [ ] **Step 4: Run test to verify it passes** — same command. Expected: PASS.

- [ ] **Step 5: Type-check** — `npx tsc -p tsconfig.web.json --noEmit`. Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/features/sessionFeed/SessionFeedContext.tsx src/renderer/src/features/sessionFeed/FakeSessionFeed.ts src/renderer/src/features/sessionFeed/SessionFeedContext.test.tsx
git commit -m "feat(remote): add SessionFeed React context and FakeSessionFeed test double"
```

---

### Task 5: Route `useIpcSubscriptions` through the injected feed

**Files:**
- Modify: `src/renderer/src/workspace/hook/ipc/useIpcSubscriptions.ts` (the ~9 `window.api.onSession*` call sites — see `useIpcSubscriptions.ts:525,542,689,698,761,810,1163,1202,1227`)
- Modify: `src/renderer/src/workspace/hook/index.ts` (where `useIpcSubscriptions` is called — pass the feed in)
- Test: extend `src/renderer/src/features/sessionFeed/SessionFeedContext.test.tsx` or add `useIpcSubscriptions.feed.test.tsx`

**Interfaces:**
- Consumes: `useSessionFeed()` (Task 4), the existing `useIpcSubscriptions(refs, setState, setRuntimes, updateRuntime, appendFeedDebug)` signature.
- Produces: `useIpcSubscriptions(feed, refs, setState, setRuntimes, updateRuntime, appendFeedDebug)` — `feed` added as the FIRST param.

- [ ] **Step 1: Write the failing test** — mount the hook with a `FakeSessionFeed`, emit a screen event, assert the runtime updated. (A thin harness component that calls the hook.)

```tsx
// assert: fake.emitScreen({ sessionId: 's1', plain: 'hello', recent: 'hello',
//   markdown: '', recentMarkdown: '', picker: { visible: false, items: [] } })
// then the session runtime for 's1' has screen === 'hello'
```

Expected: FAIL — hook still reads `window.api`, ignores the fake.

- [ ] **Step 2: Run test to verify it fails** — Expected: FAIL (runtime not updated from the fake).

- [ ] **Step 3: Swap the calls** — add `feed: SessionFeed` as the first parameter; replace every `window.api.onSessionStarted/Screen/JsonlEntries/JsonlError/SemanticEvent/Conditions/ProcessState/SubAgents/Exit` with `feed.onSession*`. Leave `window.api.ghostAppend` and `window.api.gitWorktrees` untouched (desktop-only, out of scope — add a WHY comment stating this boundary explicitly so a future reader doesn't "finish the job" and couple the phone to git). Update the caller in `workspace/hook/index.ts` to pass `useSessionFeed()`.

- [ ] **Step 4: Run test to verify it passes** — Expected: PASS.

- [ ] **Step 5: Type-check both projects** — `npx tsc -p tsconfig.node.json --noEmit && npx tsc -p tsconfig.web.json --noEmit`. Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/workspace/hook/ipc/useIpcSubscriptions.ts src/renderer/src/workspace/hook/index.ts src/renderer/src/features/sessionFeed/
git commit -m "refactor(remote): drive useIpcSubscriptions from injected SessionFeed"
```

---

### Task 6: Route input commands through the feed + mount the provider

**Files:**
- Modify: the input call sites found in Task 1 (`workspace/hook/actions/session.ts`, and any of `actions/pane.ts`, `actions/provider.ts` that call `sendInput`/`deliverPrompt`/`resolveCondition`)
- Modify: `src/renderer/src/app/App.tsx` (wrap tree in `<SessionFeedProvider value={ipcSessionFeed}>`)
- Test: a focused test asserting an action calls `feed.deliverPrompt` with the right args using `FakeSessionFeed`

**Interfaces:**
- Consumes: `useSessionFeed()` / the feed threaded through the action context.

- [ ] **Step 1: Write the failing test** — invoke the send-prompt action with a fake feed; assert `fake.calls` contains the expected `deliverPrompt`/`sendInput` entry. Expected: FAIL (action still calls `window.api`).

- [ ] **Step 2: Run test to verify it fails** — Expected: FAIL.

- [ ] **Step 3: Swap the input calls** to the feed; mount `<SessionFeedProvider value={ipcSessionFeed}>` at the top of the renderer tree in `App.tsx`. WHY comment on the provider: this is the single desktop feed-selection point named in the spec's isolation section.

- [ ] **Step 4: Run test to verify it passes** — Expected: PASS.

- [ ] **Step 5: Full type-check + run the existing renderer suite** — `npx tsc -p tsconfig.node.json --noEmit && npx tsc -p tsconfig.web.json --noEmit && NODE_ENV=test npx vitest run --project renderer`. Expected: no errors, existing tests green.

- [ ] **Step 6: Manual smoke** — `npm run dev`, spawn a Claude session, send a prompt, answer a permission prompt. Confirm identical behaviour to `main`. (Per skill `verify`: drive the real flow, don't just trust tsc.)

- [ ] **Step 7: Commit + open PR**

```bash
git add -A
git commit -m "refactor(remote): route session input through SessionFeed; mount desktop provider"
```
Then open a PR titled `Phase 0: SessionFeed decoupling` per repo convention (do NOT auto-merge; open and stop).

**Phase 0 exit criteria:** both `tsc` projects clean; renderer suite green; manual smoke identical to `main`; deleting `src/shared/sessionFeed` would break only the renderer feed files, nothing in `src/main`.

---

# PHASE 1 — LAN companion (task map; expand into its own plan after Phase 0 lands)

**Deliverable:** Enable a "Remote" toggle on the desktop → a QR appears → scan it on your phone → see all sessions live and send prompts / permission replies over the LAN.

**Why a task map, not full TDD here:** Phase 1's exact server/message shapes depend on the `SessionFeed` surface finalized in Phase 0 (e.g. the concrete `SessionEvent` union the server will serialize). Authoring literal test code now would fabricate types that Phase 0 may adjust. Expand this into `docs/superpowers/plans/2026-NN-remote-companion-phase1.md` once Phase 0 is merged, using the same bite-sized TDD structure as Phase 0.

**New files (all behind the isolation wall):**

- `src/main/remote/RemoteServer.ts` — HTTP + `ws` server. Modeled on `src/mcp/runtime/BuiltInMcpHttpHost.ts` (same start/stop lifecycle, same journal wiring). Constructed in `src/main/index.ts` next to `builtInMcpHost` (the ONE core construction line); subscribes to `SessionFeedSource`; serves the built `remote-client` bundle; upgrades WS with token check.
- `src/main/remote/SessionFeedSource.ts` — adapts `SessionManager`'s existing event emissions into the serialized `SessionEvent` frames sent to phones. Second subscriber alongside `src/main/sessions/forwarder.ts`; MUST NOT change the forwarder.
- `src/main/remote/protocol/messages.ts` — zod schemas for every inbound/outbound WS message. Outbound: `session-list`, `session-event`. Inbound (v1 ONLY): `send-prompt`, `submit`, `interrupt`, `permission-reply`. No shell/lifecycle messages exist.
- `src/main/remote/protocol/scope.ts` — the allow-list gate; rejects any message type not in the v1 set before it reaches `SessionManager`.
- `src/main/remote/auth/secret.ts` — per-install HMAC secret, created once under `src/main/storage/paths.ts` convention.
- `src/main/remote/auth/DevicePairing.ts` — one-time code issue/verify, HMAC token mint/verify.
- `src/main/remote/auth/deviceRegistry.ts` — persisted paired-device list + revoke.
- `src/main/remote/transport/RemoteTransport.ts` + `LanTransport.ts` — bind LAN interface, report `http://<ip>:<port>` for the QR.
- `src/main/ipc/remote.ts` — desktop↔RemoteServer control IPC: `remote:enable`, `remote:disable`, `remote:status` (URL + QR payload), `remote:list-devices`, `remote:revoke-device`. Register in `src/main/ipc/index.ts` (mirror the existing `registerAllIpc` pattern).
- `src/preload/api/remote.ts` — preload bridge for the above (mirror `src/preload/api/session.ts`).
- `src/renderer/src/features/remote/RemotePanel.tsx` — desktop control UI: enable/disable, LAN QR, device list + revoke. (Uses a bundled QR renderer — inline SVG QR, no external CDN.)
- `src/remote-client/` — the phone web app as a new electron-vite build target (add a build config mirroring `testing/rendering/electron.vite.config.ts`): `index.html`, `main.tsx`, `WebSocketSessionFeed.ts` (implements `SessionFeed` over WS with reconnect/backfill), `pairing/` (scan/enter code, store token in `localStorage`), `ui/` (session switcher, sticky prompt box, big approve/deny buttons). Imports the renderer's presentational transcript components and drives them with `WebSocketSessionFeed`.

**Core touch-points (the entire allowed blast radius in core):**
1. `src/main/index.ts` — construct + `start()`/`stop()` `RemoteServer` (mirror `builtInMcpHost`, lines ~452-475, ~511, ~527).
2. `src/main/ipc/index.ts` — one line registering `remote` IPC.
3. `src/preload/api/index.ts` — one line exposing the `remote` API.
4. electron-vite config — add the `remote-client` build target.

**Test focus (co-located `*.test.ts`, no new suites):**
- `protocol/scope.test.ts` — every out-of-scope message type is rejected; each in-scope type is accepted.
- `auth/DevicePairing.test.ts` — mint→verify round-trips; tampered token rejected; revoked device rejected; expired one-time code rejected.
- `RemoteServer.integration.test.ts` — `WebSocketSessionFeed` ↔ `RemoteServer` against a real `SessionManager` with a fake PTY: a screen event on the Mac side reaches the phone feed; a `send-prompt` from the phone reaches `SessionManager.sendInput`/`deliverPrompt`.

**Suggested task order (each a bite-sized TDD unit when expanded):** secret → DevicePairing → deviceRegistry → protocol/messages → protocol/scope → LanTransport → SessionFeedSource → RemoteServer (wire it all) → ipc/remote + preload → RemotePanel → WebSocketSessionFeed → remote-client UI → end-to-end smoke over LAN.

---

# PHASE 2 — Remote tunnel (task map)

**Deliverable:** A "Tunnel" toggle in `RemotePanel` spawns bundled `cloudflared`, yields a public `https://<random>.trycloudflare.com` URL, and shows it as a QR. Control from anywhere.

**New files (matching the `third_party/` convention — see `third_party/tmux/`):**
- `third_party/cloudflared/manifest.json` — version + per-arch sha256 + URL template.
- `third_party/cloudflared/{README.md,LICENSE.md,.gitignore}` — `.gitignore` keeps `cache/`, `build/` out of git; binary is NEVER committed.
- `scripts/runtime-tools/fetch-cloudflared.mjs` + `verify-cloudflared.mjs` — mirror `fetch-tmux.mjs`/`verify-tmux.mjs`; add `runtime:fetch:cloudflared` / `runtime:verify:cloudflared` npm scripts and fold into `runtime:prepare:mac`.
- `src/main/remote/transport/CloudflaredTunnel.ts` — resolves the bundled binary via `src/main/setup/runtimeTools.ts` (`resolveBundledTool('cloudflared')`), spawns `cloudflared tunnel --url http://localhost:<port>`, parses the `trycloudflare.com` URL from stderr/stdout, exposes it, and tears the child down on disable/quit.

**Core touch-points:** none beyond `RemotePanel` (add the tunnel toggle) and the transport seam already built in Phase 1. The `RemoteTransport` interface from Phase 1 is why Phase 2 needs no server changes.

**Test focus:** `CloudflaredTunnel.parseUrl.test.ts` against a captured stdout fixture (the URL-line format); manual end-to-end over a live tunnel.

**Known caveat (document in `RemotePanel` copy):** quick-tunnel URLs are ephemeral (regenerate the QR each enable) and best-effort/rate-limited. A stable URL needs a Cloudflare account + domain — out of scope for v1.

---

## Self-Review (against the spec)

- **Spec §"Isolation Boundary"** → Global Constraints (one-way wall) + Phase 1 "Core touch-points" enumerating the exactly-4 holes. ✔
- **Spec §"SessionFeed (the contract)"** → Phase 0 Tasks 2-6. ✔ (Note: the spec sketched a per-session `subscribe(sessionId, cb)`; this plan deliberately implements the existing global one-listener-per-type shape instead, because switching to per-session subscription would be a behavioural rewrite of the 2048-line subscription hub — out of scope for a pure decoupling. The WebSocket feed in Phase 1 can still fan per-session on the wire; the renderer-side contract stays global. This divergence is intentional and documented in `SessionFeed.ts`.)
- **Spec §"RemoteServer / DevicePairing / RemoteTransport / remote-client"** → Phase 1 file list + task order. ✔
- **Spec §"Data Flow" (second subscriber, forwarder untouched)** → `SessionFeedSource.ts` note. ✔
- **Spec §"Security Posture" (token on upgrade + every message, scope by protocol shape, off by default)** → `protocol/scope.ts`, `auth/*`, Global Constraints. ✔
- **Spec §"Phasing"** → three phases, each independently shippable, Phase 0 fully detailed. ✔
- **Spec §"cloudflared in third_party"** → Phase 2 file list mirrors `third_party/tmux`. ✔
- **Placeholder scan:** Phase 0 has complete code/commands; Phases 1-2 are explicitly task maps (not placeholders) with a stated expand-later trigger, per the writing-plans "independent subsystems → separate plans" guidance. ✔
- **Type consistency:** `SessionFeed` member names are identical across Tasks 2, 3, 4, 5, 6. ✔
```
