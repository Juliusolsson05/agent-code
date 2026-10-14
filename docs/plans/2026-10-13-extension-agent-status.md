# Extensions: see which agents are working and which have a notification

Fixes #1479. Refs Juliusolsson05/agent-code-extension-api#7, Juliusolsson05/agent-code-skitgubbe#6.
Branch `feat/extension-agent-status` · Worktree `.worktrees/extension-agent-status` · Base `origin/main` @ `1bcba637` (2026-10-13)
Status: implemented; PRs agent-code#1480, agent-code-extension-api#8, agent-code-skitgubbe#7. Owner approved merging all three and a Skitgubbe release (2026-10-13).

This plan covers three repositories, because the feature is one contract that crosses them:

| Repo | PR | What |
|---|---|---|
| agent-code (this branch) | host | project the two fields, nudge on change, consent wording, SDK submodule bump |
| agent-code-extension-api | SDK | optional fields in the type mirror, docs, CHANGELOG, **v0.11.0 release** |
| agent-code-skitgubbe | consumer | always-open agent panel beside the table, in both modals |

## Outcome

While a Skitgubbe game is open, a narrow panel beside the table lists every agent
that is **working** and every agent with a **notification**: title, project folder
and the same badge text Dispatch shows (NEW, ACTION, QUESTION, ERROR …). It updates
live. Any extension with `sessions.observe` gets the same two facts for every
session, through the SDK's v0.11.0 types.

## Evidence (verified, do not re-derive)

- **The SDK does not expose it today.** `ExtensionSessionSnapshot` is
  `{ id, kind, cwd, title }` in both the SDK (`src/api.ts`) and the host's source of
  truth `src/renderer/src/apps/api/types.ts:22`. The host projection is
  `createAppHostApi.ts` `sessions.observe`, which reads only
  `workspaceState.sessions` (metadata).
- **"Working" has exactly one host rule:** `sessionIsWorking(runtime)` in
  `src/renderer/src/session-runtime/working.ts`. It is shared by the Dispatch group
  `running/total` count (`countWorkingSessions`), the worktree panel, `agentFollow`
  and the composer Stop button. A missing runtime is NOT working (#880).
- **"Notification" has exactly one host rule:** `dispatchUnreadBadge(runtime)` in
  `src/renderer/src/workspace/dispatch/DispatchAgentList.tsx:865`. It returns
  `{ kind: 'output' | 'attention', text }` or null. A live provider condition
  (`dispatchAttentionLabelFromConditions`) or `processError` wins as an attention
  label; otherwise `unreadKind` of `output` or `attention` reads `NEW`. The raw
  `unreadKind` field is NOT the answer on its own: it keeps `attention` after the
  prompt is answered. That marker is the one the pane header's completion outline
  and the dwell/engagement acknowledgement clear (#1172, PR #1176).
- `dispatchUnreadBadge` lives in a 1000-line React component file and is imported by
  a test harness (`workspace/hook/ipc/testing/opencodeTerminalPane.tsx`). Importing
  it from the extension API would pull the Dispatch component module into the
  apps API.
- **Runtimes** are `useAppStore().workspaceRuntimes: Record<SessionId, SessionRuntime>`
  (`app-state/types.ts:163`), rebuilt at boot. They change on every streamed chunk.
- **Change nudges:** `apps/host/viewBridge.tsx` subscribes to
  `state.workspaceState` only, coalesces for 120 ms, and pushes
  `{ kind: 'agent-code-ext:event', topic }` for each granted observe topic. A
  runtime change therefore never reaches `sessions.subscribe` today.
- **Data path is pass-through JSON.** `frameHost.perform('sessions.observe')` returns
  `api.sessions.observe()`; the child bootstrap (`src/main/extensions/frameDocument.ts:288`)
  forwards it. No schema strips unknown fields on the way back. Views only:
  the runtime API (`RuntimeApiV2`) has no observe groups.
- **Consent wording** for `sessions.observe` is `CAPABILITY_DISCLOSURE` in
  `src/main/ipc/extensions.ts:46`: "Every open session: its title, its provider,
  and the full folder path it is running in."
- The host does not import `agent-code-extension-api` anywhere, and it is not a
  `file:` dependency of the root `package.json`. The submodule bump is a gitlink
  change only; no lockfile resync (see project memory on submodule bumps).
- SDK index (`src/index.ts`) exports neither `ExtensionSessionSnapshot` nor the
  other snapshot types, so an author cannot name them today.
- Agent Code `package.json` is at `0.1.4` on base. The SDK convention is "Agent Code
  ≥ the first supporting version" in prose, with the CHANGELOG naming the release.
- Skitgubbe: solo root `.sg-root` is a fixed `width: 1240px`; LAN `.sg-lan` is also
  1240px wide. The host scales an oversized modal down to fit 90% of the window
  width (`viewBridge.tsx` "FIT AN OVERSIZED EXTENSION TO THE WINDOW"), so a wider
  frame shrinks rather than clips. `src/api.ts` narrows the game's API to
  `Pick<AgentCodeApiV1, 'storage'>` on purpose ("widening it is a real host-power
  decision").
- Skitgubbe's LAN page is also served to plain browsers (no `api`); a panel there
  would have nothing to read.

## Decisions

1. **Read-only list, or click to jump to the agent?** — *Default: read-only.* Jumping
   needs a new write-ish host API (focus a session) with its own permission.
2. **New fields under the existing `sessions.observe` permission?** — *Default: yes*,
   additive and no new consent prompt. Alternative: a separate `agents.activity` permission.
3. **Skitgubbe base: `main` or stacked on open PR #5?** — *Default: `main`.*

Answered 2026-10-13: all defaults.

## Design

### Host contract (source of truth: `src/renderer/src/apps/api/types.ts`)

```
ExtensionSessionSnapshot = {
  id, kind, cwd, title,                                   // unchanged
  activity: 'working' | 'idle',                           // sessionIsWorking(runtime)
  notification: { kind: 'output' | 'attention'; label: string } | null,  // dispatchUnreadBadge(runtime)
}
```

- `activity` is binary on purpose. Dispatch's richer `starting/running/exited` states
  answer a different question and would make the published contract depend on
  Dispatch presentation. The one question asked is "is this agent busy right now".
- `notification.label` is the exact text Dispatch paints, so an extension can show
  the same word without re-deriving the condition table. `kind` gives a stable
  machine value for styling (`attention` = needs you, `output` = finished, unseen).
- Projection is per session, every kind. Filtering (agents vs shells vs extension
  panes) is the consumer's choice: Dispatch badges shells too (#865).

### One rule, two consumers

- **Move** `dispatchUnreadBadge`, `dispatchAttentionLabel` and
  `DispatchUnreadBadgeModel` to a pure module
  `src/renderer/src/session-runtime/unreadBadge.ts`. Dispatch, the OpenCode test
  harness and the extension projection import it from there. Nothing else changes in
  the function.
- **New** `src/renderer/src/apps/api/sessionStatus.ts`:
  - `projectSessionStatus(runtime: SessionRuntime | undefined): { activity; notification }`
  - `sessionStatusSignature(state: Pick<AppState, 'workspaceState' | 'workspaceRuntimes'>): string`,
    a compact string over every session's `id + activity + notification`. Used as a
    zustand selector, so a listener fires only when that string changes.
- `createAppHostApi.sessions.observe` spreads `projectSessionStatus(runtimes[id])`
  into each row. `sessions.subscribe` listens to both `workspaceState.sessions` and
  the signature.
- `viewBridge.tsx`: when the `sessions` topic is granted, add a second store
  subscription on `sessionStatusSignature`, sharing the existing 120 ms coalescing
  timer, pushing only the `sessions` topic.

**Invariants (each becomes a WHY comment):**
- The extension's answer and Dispatch's answer come from the same function. A
  second derivation is how a list badge and a game panel come to disagree.
- Streaming output that changes neither field must not nudge. The runtime store
  changes on every chunk; nudging on `workspaceRuntimes` identity would flood every
  open extension frame with re-reads.
- The signature selector runs on every store write while such a view is open. It
  is O(sessions) string work with no allocation per runtime beyond the string; it
  only runs while a view with the grant is mounted.

### Consent wording

`sessions.observe` disclosure becomes: "Every open session: its title, its
provider, the full folder path it is running in, and whether it is working or
waiting for you." Ruling recorded below on re-consent.

### SDK (v0.11.0)

- `ExtensionSessionSnapshot` gains `activity?` and `notification?`, both optional,
  plus exported `ExtensionSessionActivity` / `ExtensionSessionNotification` types.
  Optional because hosts before the first supporting release omit them; same
  modelling as `secrets?` and `bodyEncoding?`.
- `index.ts` exports the snapshot types (`ExtensionWorkspaceSnapshot`,
  `ExtensionSessionSnapshot`, `ExtensionPaneSnapshot`, and the two new types).
- README: observation section and permission table; CHANGELOG 0.11.0; version
  `0.11.0` in `package.json`; rebuilt committed `dist/`; README install line moves to
  `#v0.11.0` (it still said v0.8.0).
- Release: merge SDK PR (owner authorized publishing), tag `v0.11.0` on the merge
  commit, GitHub release with the CHANGELOG section as notes.

### Skitgubbe

- `src/agents/agentStatus.ts` (pure): `agentPanelRows(snapshot: unknown)` returns
  `{ supported: boolean; rows: AgentRow[] }`. It accepts the untyped wire value,
  keeps agent kinds only (not `terminal`, not `extension-view`), keeps rows that are
  working or have a notification, and orders attention first, then NEW, then
  working, then by title. `supported` is false when no row carries `activity`
  (older host) and there is at least one session.
- `src/agents/AgentPanel.tsx`: reads `api.sessions.observe()`, re-reads on
  `api.sessions.subscribe`, renders the list. Read-only. Shows "No agents need you"
  when empty and "Update Agent Code to see agent status" when `supported` is false.
  Hidden when the view has no `sessions` API (plain LAN browser, dev harness without
  a stub).
- `src/api.ts`: widen `SkitgubbeApi` to `Pick<AgentCodeApiV1, 'storage' | 'sessions'>`,
  with the WHY updated. That is the host-power decision the comment asked for.
- Layout: the panel is a 232px column to the right of `.sg-root` inside `.sg-frame`
  (solo) and beside `.sg-lan` (Friends). The table keeps its 1240px; the host's
  fit-to-window scaling absorbs the extra width.
- Manifest: add `sessions.observe` to `permissions`. Bump version to `0.2.0`.
  Rebuild and commit `dist/`, `dist-service/`, `lan-dist/`. SDK devDependency to
  `#v0.11.0`, lockfile regenerated (fixes the stale 0.8.0 lock).

## Files

agent-code:
- Create `src/renderer/src/session-runtime/unreadBadge.ts`: the moved badge rule
- Create `src/renderer/src/apps/api/sessionStatus.ts`: projection and signature
- Create `src/renderer/src/apps/api/sessionStatus.renderer.test.ts`
- Modify `src/renderer/src/workspace/dispatch/DispatchAgentList.tsx`: import the moved rule
- Modify `src/renderer/src/workspace/hook/ipc/testing/opencodeTerminalPane.tsx`: import path
- Modify `src/renderer/src/apps/api/types.ts`: snapshot fields
- Modify `src/renderer/src/apps/api/createAppHostApi.ts`: projection and subscribe
- Modify `src/renderer/src/apps/host/viewBridge.tsx`: status nudge
- Modify `src/main/ipc/extensions.ts`: disclosure wording
- Modify `docs/extensions/authoring.md`: the observe section
- Modify `packages/agent-code-extension-api` (gitlink to the v0.11.0 commit)

agent-code-extension-api: `src/api.ts`, `src/index.ts`, `README.md`, `CHANGELOG.md`,
`package.json`, `package-lock.json`, `dist/*`, `examples/counter` (only if it helps the
type check exercise the new fields).

agent-code-skitgubbe: `src/agents/agentStatus.ts`, `src/agents/AgentPanel.tsx`,
`src/agents/agents.css`, `src/view/mount.tsx`, `src/lanView.tsx`, `src/lan/LanApp.tsx`,
`src/api.ts`, `agent-code.extension.json`, `package.json`, `package-lock.json`,
`README.md`, `tests/agent-panel.test.mjs`, `dev/main.tsx` (stub sessions for the dev
harness), built outputs.

## Tests

agent-code, `sessionStatus.renderer.test.ts`:
- **Agreement:** for each runtime shape (no runtime, idle, streaming, running,
  unread output, unread attention with a live condition, answered attention,
  processError), `projectSessionStatus` matches `sessionIsWorking` and
  `dispatchUnreadBadge`. Runtimes are built from `emptyRuntime()` (the real
  factory) plus the fields under test; condition snapshots reuse the shape existing
  conditions tests use. Before the change: the function does not exist.
- **observe end to end:** seed `useAppStore` with two sessions and runtimes, call
  `createAppHostApi(...).sessions.observe()`, and assert `activity` and
  `notification` per row. Fails before the change (fields absent).
- **Nudge contract:** `sessionStatusSignature` changes when a runtime flips working
  or gains/loses a notification, and is unchanged when only `entries` changes. A
  `sessions.subscribe` listener fires on a working flip and not on an entries-only
  update. Mutation check: replace the signature with the runtime map identity and
  the entries-only assertion must fail.

SDK: `npm test` (author fixture + counter example type check) and `check:dist`.

Skitgubbe, `tests/agent-panel.test.mjs` (node:test, same runner as the other tests):
- Filters shells and extension views, keeps working or notified agents, orders
  attention > NEW > working. The fixture is a snapshot copied from the host test's
  expected output, so both sides of the wire are pinned to the same shape.
- An older-host snapshot (no `activity` on any row) gives `supported: false`; an
  empty snapshot gives `supported: true, rows: []`.

## Verification

- agent-code: `NODE_ENV=test npx vitest related --run <changed files>` while
  iterating; `npx tsc -b --pretty false` (Node 24) once at the end; CI quality-gate.
- SDK: `npm test`, `npm run check:dist`.
- Skitgubbe: `npm run verify`, `npm run test:browser` (headless Chrome) and a
  screenshot of the panel from the dev harness with stubbed sessions.
- **Verification boundary:** the app is not launched (standing rule). The
  extension frame inside the real Electron host, live nudges from real agents, and
  the reinstall consent dialog are not observed here. The PRs will say so.

## Out of scope

- Jump-to-agent from the panel (decision 1). This needs a focus-session host API;
  follow-up issue if wanted.
- Exposing session status to background runtimes (`RuntimeApiV2` has no observe
  groups at all; separate decision).
- Re-consent for already-installed extensions with `sessions.observe` (see Rulings).
- Skitgubbe PR #5 (bot engine) is independent and untouched.

## Tasks

- [x] 1. Host: move the badge rule, add `sessionStatus.ts`, project + subscribe in
  `createAppHostApi`, nudge in `viewBridge`, types, disclosure, authoring doc, tests.
- [x] 2. SDK: fields, exports, docs, CHANGELOG, version, dist; PR; one review round.
- [x] 3. Skitgubbe: panel, API widening, manifest, SDK bump, tests, build, browser
  check; PR.
- [x] 4. Review round (one) across the three PRs; fix valid findings.
- [ ] 5. Publish SDK v0.11.0 (merge SDK PR, tag, GitHub release); bump the host
  submodule to the tagged commit; Skitgubbe pins `#v0.11.0`.
- [ ] 6. Report; host and Skitgubbe merges wait for explicit approval.

## Execution notes

- 2026-10-13 task 1: `7347ea80` (badge rule move), `97b66e2f` (projection + nudge), `1cbf4d20` (SDK pointer). tsc -b clean; apps suite 45/45; four mutations caught (confirm-red observed).
- 2026-10-13 task 2: SDK `2dcd691`; npm test 3/3, check:dist clean; required-`activity` mutation caught (TS2578).
- 2026-10-13 task 3: Skitgubbe `7dec2e0`; verify 3/3 + 45/45, test:browser and test:lan-browser pass; screenshots of both modals.
- 2026-10-13 task 4: six Claude reviewers (two per PR). Fixes: host `beb2f71a`, SDK `7b43bcd`, Skitgubbe `5f43419`. Every reviewer-surviving mutation re-run and now caught (9 host, 2 SDK type pins, 2 Skitgubbe loop).

## Rulings

- Ruling: already-installed extensions holding `sessions.observe` start receiving
  the two status fields without a new consent prompt — the grant is approved
  against a bundle hash, not the disclosure text, and the owner chose to keep the
  existing permission — cost if wrong: a privacy-minded user sees more than they
  approved (working/idle and a badge word, no content); fix would be a permission
  version bump.
- Ruling: the Skitgubbe panel gets its own `AgentStatusApi = AgentCodeApiV1['sessions']`
  instead of widening `SkitgubbeApi` as the Design section said — the game code
  has no reason to read sessions — cost if wrong: none (DRIFT from Design, intended).
- Ruling: keep the field name `notification` (sdk-a suggested `badge` because the SDK
  also has a `notifications.show` toast API) — it is the owner's own word for the
  feature, and the JSDoc/README now say it needs `sessions.observe`, not
  `notifications.*` — cost if wrong: a rename after v0.11.0 is a breaking change.
- Ruling: the frame nudge lives in `apps/host/observeNudges.ts`, not inline in
  viewBridge — review showed the inline block could not be tested and every
  mutation of it survived — cost if wrong: none.
- Ruling: Skitgubbe lists agent kinds only, not shell terminals or extension panes —
  the owner asked for "working agents"; Dispatch badges shells, but a shell's
  "command finished" is noise beside a card table — cost if wrong: one filter line.

## Review (2026-10-13, one round)

| Finding | Verdict | Disposition |
|---|---|---|
| host-a/host-b: frame nudge path untested, every viewBridge mutation survives | valid | fixed in `beb2f71a` (observeNudges.ts + fake-timer test) |
| host-a/host-b: badge-only status change never asserted (signature without badge survives) | valid | fixed in `beb2f71a` |
| host-a/host-b: precedence (live prompt vs stale unread / leftover error) unpinned | valid | fixed in `beb2f71a` |
| host-b: unsubscribe untested | valid | fixed in `beb2f71a` |
| host-a: same-realm subscribe fires twice on a session add | valid (nit) | fixed in `beb2f71a` (one selector) |
| host-b/host-a: consent wording omits unseen output / viewing signal | valid | fixed in `beb2f71a` |
| host-b: host type comments not updated | valid | fixed in `beb2f71a` |
| sdk-a/sdk-b/host-b: "clears when the user looks" true only for `output` | valid | fixed in SDK `7b43bcd` + authoring.md |
| sdk-a: "widening is additive" is backwards for a host-written union | valid | fixed in SDK `7b43bcd` |
| sdk-a/sdk-b: contract fixture pins only part of the new surface | valid | fixed in SDK `7b43bcd` (two mutations re-run: caught) |
| sdk-b: CHANGELOG host version placeholder before tag | valid | fixed: names "the first Agent Code release after 0.1.4 (#1480)" |
| sdk-b/sdk-a: README "of SDK 0.11.0", "never fires" too strong | valid (nit) | fixed in SDK `7b43bcd` |
| sdk-a: rename `notification` → `badge` | owner-vocabulary call | declined, see Rulings |
| sg-a: read loop discards answers under steady nudges, can freeze | valid | fixed in Skitgubbe `5f43419` (+ regression tests, mutation caught) |
| sg-a: ordering test does not pin attention > NEW | valid | fixed in `5f43419` |
| sg-a: deny-list trade-off undocumented | valid | documented in `5f43419` |
| sg-a: untitled agents don't match Dispatch names | valid, needs host | follow-up agent-code#1483; provider names fixed in `5f43419` |
| sg-a: panel shrinks the table on narrow windows | valid trade-off | accepted; recorded here and in the Skitgubbe PR |
| sg-a: focus comment wrong, idle dot invisible, no live region | valid (nits) | fixed in `5f43419` |
