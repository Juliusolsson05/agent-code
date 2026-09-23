# Lane Browser Pocket — staged decomposition

Issue: #1142. Spec: `docs/superpowers/specs/2026-09-22-lane-browser-pocket-design.md`.
Plan (task-level detail): `docs/superpowers/plans/2026-09-22-lane-browser-pocket.md`.

This document is the **gate** for implementation. It re-cuts the plan's 18
tasks into stages that each produce an inspectable artifact and can be
verified without the stages after them. The plan says *how to write each
piece*; this document says *in what order the pieces become trustworthy*
and *which inputs are recorded rather than imagined*. When they disagree,
this document wins and the plan is edited.

Decisions taken with the user's "implement all of this" (spec §11
recommendations): D1 `lane` cookie jar by default; D2 strip + split above the
size threshold; D3 one page per pocket; D4 raw CDP, no Playwright; D5
Electron 43.7.4; D6 detection only; D7 explicit hand-back + 60 s idle
auto-resume; D8 no PTY output parsing; D9 popups needing `window.opener`
denied with "Open in system browser"; D10 picker → clipboard for
terminal-surface agents.

---

## 1. A and D

**A (exists and trusted today):**

- `SessionMeta` pool + its persistence/merge/adopt/removal paths
  (`src/renderer/src/workspace/types.ts`, `useAutoSave.ts`,
  `workspaceShape.ts`, `pool.ts`), with the two explicit carry lists
  `replaceSession` (`hook/actions/session.ts:~1403`) and
  `carryDurableMeta` (`hook/actions/undoClose.ts:72`).
- `renderWorkspaceLeaf` (`workspace/tile-tree/TileTree.tsx:33`) as the one
  function both the lane grid and Spotlight use to draw a session.
- The composed visibility contexts (`RetainedWorkspaceSurface`,
  `AgentTerminalOwnership.tsx`) that already tell a pane whether it is on
  screen.
- The built-in MCP host (`src/mcp/runtime/*`) that already delivers a
  per-session, bearer-authenticated MCP server to Claude/Codex/OpenCode/Grok,
  with `scope.sessionId` on every request.
- `sessionManager.getProcessTelemetryTargets` + the `ps -axo pid,ppid`
  sampler (`src/main/performance/NativeProcessSampler.ts`) for session PIDs.
- Electron 43.7.4 installed in this worktree (uncommitted; Stage 0).

**D (observable end state):**

With Settings → Experimental → Browser Pocket on:
1. ⌘⇧B on an agent (in a lane or Spotlight) shows a pocket; the lane shows a
   strip or a split by size; Spotlight shows agent | browser.
2. Moving between grid and Spotlight, reordering/inserting/removing lanes,
   opening Settings/Reader/Global Editor, and reloading or provider-switching
   the agent do not reload the page and keep its login.
3. A lane whose own processes serve HTML on a port shows a `:port` chip;
   clicking it opens the pocket there. Two lanes on :3000/:3001 have
   separate cookies.
4. That agent — and only that agent — can `browser_open/snapshot/click/type/
   press/scroll/wait_for/screenshot/console/network/resize/set_appearance/
   lane_ports` its own pocket; the user's composer keeps focus; a user
   click/keypress in the page stops the agent's action and pauses further
   mutations until handed back.
5. The user can pick an element into that agent's composer at the caret.
6. With the setting off: no guests, no scans, tools answer `disabled`.

---

## 2. Stages

Each stage lists **Produces / Verified by / Why separate / Reality check**.
"No-launch rule": agents never run the Agent Code app (`npm run dev`,
`npx electron` harnesses). Anything that only a running app can prove is
routed to the user's manual QA in Stage 10, and says so.

### Stage 0 — Runtime floor

- **Produces:** `package.json` / `package-lock.json` pinning Electron
  `^43.7.4` — a 5-line lockfile diff (version, resolved, integrity, two
  spec strings; the transitive dependency list is identical, checked with
  `npm view`).
- **Verified by:** `npm ci` in a clean `node_modules` succeeds;
  `node_modules/electron/package.json` reads 43.7.4; `npx tsc -b` passes.
- **Why separate:** every guest/debugger stage depends on the
  use-after-free fixes (electron#53376, #53819, #54089). A plain
  `npm install` re-hoisted ~570 unrelated lock lines (vitest's nested
  esbuild); keeping this a surgical, separately reviewable commit is what
  stops that churn riding along.
- **Reality check:** the registry's published 43.7.4 metadata; the
  actual install in this worktree.

### Stage 1 — Instrumentation: record the real inputs

Nothing in later stages may be tested against an input shape that was not
recorded here. This stage renders nothing and is the one most likely to be
skipped; it is also what makes Stages 2–3 honest.

- **Produces:** `scripts/browser-pocket/record-fixtures.mts` and a
  committed corpus under `src/main/browserPocket/__fixtures__/`:
  1. `ps-topology.*.txt` — `pid ppid comm` (basename only, **no argv**:
     argv carries prompts and paths) for real Agent Code runs on this Mac,
     captured while: (a) a Claude agent has run a dev server through its
     Bash tool, (b) a Codex agent has done the same, (c) a tmux-backed
     terminal is running `npm run dev`, (d) a direct-PTY terminal is.
  2. `tmux-panes.txt` — `tmux list-panes -a -F '#{session_name} #{pane_pid}'`
     from the app's bundled tmux for (c), because terminal processes live
     under the **tmux server**, not under the session's PTY (observed
     2026-09-22: the app's tmux server is a direct child of Electron main;
     agents are direct children too).
  3. `lsof-listen.*.txt` — `lsof -nP -a -iTCP -sTCP:LISTEN -F pcn -p …` for
     the same moments, plus one system-wide sample (IPv4/IPv6/wildcard
     binds, multiple fds per port).
  4. `probe.*.json` — status + content-type of `GET /` on each listener
     owned by those trees (Vite, Next, Storybook, and whatever MCP servers
     the agents hold — observed: Claude spawns `npm exec … mcp` children,
     so non-dev listeners inside an agent's tree are real, not
     hypothetical).
  5. `axtree.*.json` — `Accessibility.getFullAXTree` from **real Chrome**
     (system Chrome, `--headless=new --user-data-dir=<scratch>` — a
     non-default profile, so Chrome 136+'s remote-debugging restriction does
     not apply and no user data is touched) loading: a Vite React template
     app, a form-heavy page, a page with an iframe, a long list page.
  6. `cdp-events.*.jsonl` — raw `Runtime.consoleAPICalled`,
     `Runtime.exceptionThrown`, `Log.entryAdded`,
     `Network.requestWillBeSent/responseReceived/loadingFailed` streams from
     the same Chrome runs, with a page that logs errors, 404s an asset and
     fails a fetch.
  7. `quads.*.json` — `DOM.getContentQuads` / `DOM.getBoxModel` /
     `DOM.describeNode` responses for a handful of backend node ids from (5).
  8. `README.md` in the fixture dir: Chrome version, macOS version, date,
     the exact commands, and what was scrubbed.
- **Verified by:** the recorder is re-runnable and deterministic in shape
  (not bytes); a `record-fixtures --check` mode asserts every fixture has
  its provenance header and no argv/paths/hostnames leaked (grep for
  `/Users/`, `@`, home dir). Reviewer inspects the corpus by eye.
- **Why separate:** if parsers and formatters are written first, their tests
  will be written against the shapes I imagined (the "40%" failure). The
  tmux finding above is exactly the kind of shape imagination misses.
- **Reality check:** it *is* the reality check. Linux `/proc/net/tcp` and
  Windows `netstat -ano` cannot be recorded on this machine → see Unknowns
  U1; they are **not** implemented until recorded.

**Needs the user for (1a–1d):** those captures require the real app
running with agents and terminals doing real work. I will prepare the
recorder and ask you to run one command while those four situations are
live. Everything else in Stage 1 I can record myself.

### Stage 2 — Pure cores, tested first against Stage-1 fixtures

- **Produces:** `src/main/browserPocket/core/` (pure TypeScript, **no
  `electron` import**, enforced by a unit test that greps the directory):
  - `lanePorts.ts` — `parseLsofListen`, `collectTree`, `attributePorts`,
    `classifyProbe`.
  - `axSnapshot.ts` — `formatAxTree`, `refToBackendId`.
  - `cdpBuffers.ts` — reducer from raw CDP events to bounded console/network
    rings (with requestId→url join).
  - `quads.ts` — quad → click point, box → size.
  - plus `src/shared/browserPocket/url.ts` (`normalisePocketUrl`,
    `isAllowedTopLevelUrl`) and `elementChip.ts` (`formatElementChip`,
    `insertAtCaret`).
- **Verified by:** vitest, tests written **before** the code, each reading a
  Stage-1 fixture (except `url.ts`, see Reality check). Example contracts:
  every `[ref=eN]` in formatted output resolves; a port held only by the
  tmux-server subtree of a terminal attributed to lane A is reported for A
  and not B; an MCP child's JSON listener sorts after the HTML dev server.
- **Why separate:** these are the reconciliation-heavy parts (process trees
  × listeners × probes; AX nodes → text). Keeping them pure means their
  bugs are found with fixtures, not by clicking around a running app we
  may not launch.
- **Reality check:** Stage-1 recordings. `url.ts` and the guard policy
  (Stage 5) are security boundaries whose inputs are an *adversarial*
  enumeration (schemes, partitions, preload keys) taken from the Electron
  security checklist and T3/Orca/Emdash block-lists — that is a list of
  attacks, not imagined happy paths, and is labelled as such in the tests.

### Stage 3 — Pocket ownership on the session

- **Produces:** `BrowserPocketConfig` + `SessionMeta.browserPocket`; carry
  in `replaceSession` and `carryDurableMeta`; pure transforms in
  `features/browser-pocket/actions.ts`; the four settings.
- **Verified by:** renderer tests using the existing **recorded** workspace
  fixtures (`workspaceShape.ownerV2Fixture.ts`,
  `workspaceShape.recorded.test.ts`) extended with a pocket, run through
  migrate → autosave → rehydrate; the existing
  `successorRelationships.renderer.test.tsx` harness for id swap; undo carry
  via exported `carryDurableMeta`.
- **Why separate:** everything visual keys off `pocketId`; if identity is
  wrong (e.g. re-minted on reload) every later stage "works" and silently
  logs the user out. Proving identity survival before any UI exists keeps
  that bug out of the UI's debugging surface.
- **Reality check:** the repo's recorded v2/v3 workspace files.

### Stage 4 — Placement reconciliation (isolated hard part #1)

- **Produces:** `src/renderer/src/features/browser-pocket/placement/`:
  slot registry store + `pickWinningSlot` + `resolvePlacement` → **one**
  `Placement` object per pocket: `{ mode: 'shown', rect, clip, dimmed } |
  { mode: 'parked', size, mustPaint } | { mode: 'asleep' }`, plus the
  sleep policy and crash back-off.
- **Verified by:** pure tests over sequences of slot reports modelled on the
  real mount order React produces for: lane → Spotlight → back; mirrored
  lanes; lane splice under the pocket; stage hidden by Settings; sleep after
  idle; agent lease keeps a hidden guest painting. The *sequences* are
  captured from the real component tree in Stage 6 via a dev-only logger
  and replayed here (see Fixture plan); until then Stage 4 is verified
  against sequences derived from reading `MainSurface.tsx`/
  `TiledDispatchLayout.tsx` and is marked provisional.
- **Why separate:** several slots claim the same guest. If each consumer
  (lane leaf, Spotlight, strip, host) arbitrates on its own, the bugs look
  like rendering bugs (double guests, flicker, a page that "randomly"
  reloads) but are ownership bugs. One layer emits one answer.
- **Isolation:** only `BrowserPocketHost` imports `placement/resolve*`;
  slots only import `placement/report*`. See §3.

### Stage 5 — Guest boundary in main

- **Produces:** `guestGuard.ts` (pure `decideGuestAttach`,
  `hardenGuestPreferences` + binding), `partition.ts`, `guestPolicies.ts`
  (window-open, navigation, permissions, certs, chord forwarding,
  human-input tap), registration IPC + preload bridge, `webviewTag: true`.
- **Verified by:** pure tests for the decision/hardening functions and the
  chord formatter; IPC handler test that rejects a `webContentsId` that is
  not a `webview` hosted by the caller (fake `webContents.fromId`).
  Whether the guard *actually* fires on Electron 43.7.4 is a Stage 10 QA
  item (no-launch rule).
- **Why separate:** `webviewTag: true` turns a renderer XSS into a way to
  create a browser; the guard must exist and be reviewed on its own before
  any code creates guests.
- **Reality check:** Electron security checklist; Orca/T3 handler source
  read during research.

### Stage 6 — Surface: host, slots, pocketed leaf, chrome, strip, commands

- **Produces:** `BrowserPocketHost` (app root, outside
  `RetainedWorkspaceSurface`), `PocketSlot`, `PocketedLeaf` wired through
  `renderWorkspaceLeaf` (lanes + Spotlight), `PocketChrome`, `PocketStrip`,
  `PocketEmptyState`, Spotlight presets, ⌘⇧B + Spotlight allowlist, chord
  relay; a **dev-only placement trace** (`localStorage` flag) that logs slot
  reports and placements to feed Stage 4's replay fixtures.
- **Verified by:** renderer tests (happy-dom, Node 24) that `PocketedLeaf`
  renders slot/strip/nothing per state and that the lane and Spotlight
  trees register slots for the same `pocketId`; command availability.
  Guest behaviour (no reload on moves, macOS parking) → Stage 10.
- **Why separate:** it is the first stage the user can see; everything under
  it must already be trustworthy so visual bugs here are layout bugs, not
  identity or ownership bugs.
- **Reality check:** placement traces recorded by the user during Stage 10
  QA are committed as Stage-4 fixtures (closing the loop).

### Stage 7 — Lane port watcher (isolated hard part #3)

- **Produces:** `LanePortWatcher` (scheduling, back-off, zero-cost when
  idle) using Stage-2 cores; real deps: `ps`, `lsof`, **tmux pane PIDs** as
  terminal roots, owned-only probe; broadcast → renderer store; lane `:port`
  chip; localhost links into the pocket.
- **Verified by:** watcher tests with fake deps replaying Stage-1 topology +
  lsof fixtures in sequence (server appears, moves, dies); the terminal→lane
  attribution rule tested against recorded tmux/topology fixtures.
- **Why separate:** attribution reconciles three sources (agent tree,
  terminals by cwd, tmux panes) into one per-session list; mixing that into
  UI code is how "wrong lane's port" bugs (Antigravity, Claude #90661) ship.
- **Isolation:** only the watcher imports `core/lanePorts`; the renderer only
  sees `LanePort[]` per session.

### Stage 8 — Agent control (isolated hard part #2)

- **Produces:** `src/main/browserPocket/controller/` —
  `BrowserPocketController` (registry, lazy debugger attach, per-pocket
  queue, per-action deadline, reset-only-this-pocket on timeout, control
  epoch with expected-input window, DevTools refusal, detach-before-destroy,
  driving events), `actions.ts` (click/type/press/scroll/wait/screenshot
  over CDP); `src/mcp/runtime/browserTools.ts` + `browser` domain
  registration; renderer relay for `open-request` (collapsed, no focus);
  driving indicators and take-over/hand-back UI.
- **Verified by:** controller tests with a fake `Debugger` that **replays
  Stage-1 CDP responses and event streams** (not invented `{}`); MCP tests
  over `InMemoryTransport` (tool list gating, caller targeting, error
  codes). Real focus behaviour and real input-event echo → Stage 10.
- **Why separate:** control ownership (agent vs human, one queue, one
  epoch) is the part that went wrong most in T3 (#12273, #10980, #13051).
- **Isolation:** only `browserTools.ts` and `ipc/browserPocket.ts` import
  `controller/`; nothing in the renderer does.

### Stage 9 — Picker and polish

- **Produces:** CDP picker (`Overlay.setInspectMode`), element chip into the
  composer at the caret (images via `setDraftImages` where the provider
  accepts them; clipboard for terminal-surface agents), device presets,
  appearance, zoom isolation, DevTools, profile switch, clear storage.
- **Verified by:** pure tests for selector building and chip/caret
  insertion against Stage-1 `describeNode` fixtures; renderer test that the
  chip lands in the right session's draft.
- **Why separate:** none of it is load-bearing for D1–D4; it must not be
  able to destabilise them.

### Stage 10 — Real-app verification (user) + PR

- **Produces:** full gates (`npx tsc -b`, `check:keybindings`, `npm test`
  under Node 24), the manual QA checklist in the PR (plan Task 18) executed
  by the user, and placement traces + any surprises committed as fixtures.
- **Verified by:** the user running the app; CI.
- **Why separate:** the no-launch rule means the only proof that guests
  really survive moves, that macOS parking doesn't blank them, and that
  focus is not stolen is a human with the app open.

---

## 3. What is isolated

| Hard part | Lives in | Single consumer | Forbidden importers |
|---|---|---|---|
| Placement reconciliation (many slots → one guest placement) | `src/renderer/src/features/browser-pocket/placement/` | `BrowserPocketHost` (resolve) and `PocketSlot` (report only) | chrome row, strip, commands, anything in `workspace/` |
| Agent/human control of a guest (CDP, queue, epoch) | `src/main/browserPocket/controller/` | `src/mcp/runtime/browserTools.ts`, `src/main/ipc/browserPocket.ts` | renderer (by construction — main only), `LanePortWatcher` |
| Port attribution (agent tree × terminals × tmux panes × listeners) | `src/main/browserPocket/core/lanePorts.ts` via `LanePortWatcher.ts` | `LanePortWatcher` | MCP tools (read the watcher's cache), renderer |
| Guest attach decision | `src/main/browserPocket/guestGuard.ts` | `appWindow.ts` | everything else |

A test in Stage 2 asserts `core/` has no `electron` import; a test in
Stage 8 asserts no file under `src/renderer` imports `controller/`.

---

## 4. Unknowns (not yet enumerated)

- **U1** Linux `/proc/net/tcp{,6}` and Windows `netstat -ano` output shapes
  — cannot be recorded here. v1 ships port detection on **macOS only**;
  Linux/Windows return no ports (chip hidden) until someone records
  fixtures. (Change from the plan, which specified all three.)
- **Answered by Stage 1 (2026-09-22), see `__fixtures__/README.md`:** U2 for
  Claude (agent-started servers are descendants: `claude → zsh → npm exec →
  node`), U3 (tmux panes descend from a daemonized tmux SERVER shared by every
  app instance on the default socket; roots come from `list-panes` filtered by
  `tmuxName`). New rules forced by the recordings: exclude listeners held by
  the session ROOT itself (OpenCode serves its own UI as 200 text/html); 5xx is
  never a page (per-session `mitmdump` proxies answer 502 text/html); a 404 at
  `/` is still listed (a real Vite dev server did that). Codex-started dev
  servers are still unrecorded.
- **U2** Where a Claude agent's Bash-tool background dev server sits in the
  tree (child of `claude`? reparented to launchd after the tool call?).
  Codex likewise (its children observed: `node_repl`, `node`). Recorded in
  Stage 1; attribution rule may change.
- **U3** Which PID `getProcessTelemetryTargets` returns for a tmux-backed
  terminal (tmux client? nothing?) versus the pane PID from
  `list-panes`. Recorded in Stage 1.
- **U4** Whether a `<webview>` parked at −100000px on Electron 43.7.4/macOS
  keeps compositing enough for `capturePage`; whether `visibility:hidden`
  really blanks it (T3's comment, unverified by us). Stage 10.
- **U5** Whether `webContents.debugger` coexists with an open DevTools on
  43.7.4 (T3 refuses; VS Code coexists). v1 refuses; Stage 10 may relax.
- **U6** Whether guest `input-event` reports mouseDown coordinates in the
  same space as our `Input.dispatchMouseEvent` (needed for the
  expected-input filter). Stage 10; until then the filter also accepts a
  100 ms "we just dispatched" window.
- **U6b** Whether CDP `Input.dispatchKeyEvent` / `dispatchMouseEvent` echo
  through the guest's `before-input-event` / `input-event`. Unverified, so
  the controller filters every reported input against what it is itself
  dispatching (keys by time window, mouse by point) instead of trusting the
  event source. Stage 10.
- **U7** How the React tree actually mounts/unmounts slots across
  Spotlight toggles (Stage 4's replay fixtures) — recorded in Stage 10.
- **U8** Whether the app's CSP or `backgroundThrottling:false` on the host
  window affects guests in ways not in the docs.
- **U9** AX tree size and shape on large real apps (the 20k-char cap is a
  guess); measured in Stage 1 on the long-list page.

---

## 5. Fixture plan

| Fixture | Produced by | Consumed by |
|---|---|---|
| `ps-topology.*`, `tmux-panes.*`, `lsof-listen.*`, `probe.*` | Stage 1 recorder; (1a–1d) run by the user with the real app | Stage 2 `lanePorts`, Stage 7 watcher |
| `axtree.*` | Stage 1 recorder (headless system Chrome, scratch profile) | Stage 2 `axSnapshot`, Stage 8 snapshot tool test |
| `cdp-events.*` | Stage 1 recorder | Stage 2 `cdpBuffers`, Stage 8 controller fake debugger |
| `quads.*`, `describe-node.*` | Stage 1 recorder | Stage 2 `quads`, Stage 8 click/type, Stage 9 picker |
| Workspace v2/v3 files | already in repo (`workspaceShape.*`) | Stage 3 |
| Placement traces | Stage 6 dev-only tracer, recorded by the user in Stage 10 QA | Stage 4 replay tests (provisional until then) |

Rule: a failing test against one of these is never weakened; the code or
this document changes.
