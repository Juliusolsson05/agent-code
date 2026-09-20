# Decomposition: usable first run without pre-installed CLIs

Refs #995 (audit + acceptance criteria), #994 (opencode bundling, in flight), #993 (state-lock incident)

## A — what exists and is trusted (named)

- `src/main/setup/runtimeTools.ts` — bundled-artifact resolution (tmux/mitmproxy/cloudflared),
  manifest-pinned, noexec-probed, asar-unpack aware. Trusted; do not redesign.
- `src/main/setup/binaryResolver.ts` + `prerequisites.ts` — PATH/login-shell/well-known-dir
  probing with manual-override precedence and persisted cache (`setupState.ts`).
- `src/main/sessionManager.ts:2556-2587` — spawn-time absolute-path-or-fail + late re-resolve.
- `src/renderer/src/features/setup/ui/SetupGate.tsx` — the gate overlay as it exists.
- `src/renderer/src/workspace/hook/persistence/useBootstrap.ts` — fresh-install bootstrap.
- The three read-only audits of 2026-09-18 (issue #995) — evidence base.

## D — end state in observable behavior

A clean machine (no brew, no git CLT, no provider CLIs, fresh `~/.config/agent-code`) can:
1. Open the app and reach a usable workspace **without ever installing claude or codex** —
   via a terminal pane, or via bundled opencode once #994 lands.
2. See, per missing provider, a copyable install command and a link in the gate.
3. Always have "Continue anyway" (with an explicit acknowledgment) instead of a lockout.
4. Keep autosave/persistence on even when the first spawn fails or never happens.
5. Get a first-project cwd of the home directory, never `/`.
6. Reopen Setup from the menu/command palette; the "open Setup to locate it" toast opens it.
7. See provider pickers mark missing providers instead of failing after cwd selection.

## Stage 1 — Fresh-run recorder (instrumentation; no visible product change)

- **Produces**: `testing/first-run/fixtures/` — recorded outputs of the REAL
  `checkPrerequisites()` and `workspace:default-cwd` handler and the bootstrap decision
  (`useBootstrap` state transitions), captured by a harness that runs the real main-process
  code against (a) a temp STATE_DIR with stripped PATH (simulated clean machine) and
  (b) the current dev machine (rich PATH), on current `main` BEFORE any policy change.
- **Verified by**: harness runs green in `vitest --project system` and the fixture files
  exist and show the clean-machine WALL (gate not ready) and cwd=`/` — the recorded
  baseline that every later test asserts against.
- **Why separate**: stages 2–6 must be tested against recorded reality, not typed-in
  literals. Merging the recorder forward = imagined fixtures = vanity tests.
- **Reality check**: it records the actual code paths the audits cited
  (prerequisites.ts:85-165, ipc/workspace.ts:64-66, useBootstrap.ts:87-121).

## Stage 2 — Readiness policy (the wall)

- **Produces**: `src/main/setup/readiness.ts` — single module emitting one readiness
  object (`{ usableProviders, blocking: never, warnings, installHints }`); gate becomes
  dismissible-with-acknowledgment whenever zero providers are usable; per-provider
  copyable install commands (from the same strings `cliUpdateOrchestrator.ts:589,622`
  already uses) + links in `SetupGate.tsx`. `required:true` flags die for providers.
- **Verified by**: tests from Stage-1 fixtures — clean-machine fixture now yields
  "continue allowed (terminal-only)" + warning instead of `ready:false`; claude-only
  machine yields continue; both-providers machine unchanged.
- **Why separate**: policy semantics must exist in exactly one place before UI, bootstrap
  and toasts all consume it; otherwise each consumer re-derives requiredness (the exact
  ownership bug class the audits found).
- **Reality check**: built directly on recorded fixture #1 (the wall) and #2 (dev machine).
- **Isolation**: ONLY the gate, bootstrap (stage 4), and spawn toast (stage 3) may import
  `readiness.ts`. Forbidden: any other module re-computing required/blocked.

## Stage 3 — Reopenable gate + actionable toast + Settings tool paths

- **Produces**: "Open Setup…" menu entry (`appMenu.ts`) + command palette command;
  spawn-error toast action that opens the gate; Settings → Setup rows for manual tool
  paths reusing the existing `setup:set-tool-path` IPC.
- **Verified by**: unit/system tests that the command dispatches to the gate surface;
  recorded-fixture test that the sessionManager toast string resolves to a real action.
- **Why separate**: pure surface wiring over stage-2 policy; independent of bootstrap.
- **Reality check**: audit F2/dead-end #2 and #6 (gate-only override).

## Stage 4 — Bootstrap de-race + persistence latch

- **Produces**: gate-aware bootstrap in `useBootstrap.ts`: never spawn while the gate
  blocks; on continue-without-providers open a terminal-pane default project;
  `bootstrapComplete` no longer hostage to first-spawn failure (persistence stays on).
- **Verified by**: Stage-1 recorded bootstrap transitions replayed as system tests:
  missing-CLI run must end `bootstrapComplete === true`, zero-spawn, persistence active.
- **Why separate**: touching persistence latches while also changing policy hides which
  change fixed what; the recorded baseline pins the current broken behavior first.
- **Reality check**: audit F2/F4 with exact file:line evidence.

## Stage 5 — cwd + picker availability

- **Produces**: `workspace:default-cwd` falls back to homedir for Finder launches;
  provider pickers (`providerChoices.ts`, `PathPickerModal.tsx`, `NewAgentPlacementOverlay`)
  render missing providers as disabled with "not installed — open Setup" hint from
  readiness state.
- **Verified by**: fixture from Stage 1 (cwd=`/`) inverted to homedir; picker snapshot
  tests with readiness injected.
- **Why separate**: small, user-visible polish isolated from policy machinery.

## Stage 6 — First-run integration sweep

- **Produces**: one system test simulating the entire fresh run (temp STATE_DIR, stripped
  PATH, no provider CLIs): launch → gate informs → continue → terminal workspace →
  persistence writes → reopen Setup from palette. Runs in CI.
- **Verified by**: it is the verification — green against real code, red on the
  pre-change baseline (demonstrated once by running it against a stash).
- **Why separate**: the sweep depends on all stages; it is the acceptance test for #995.

## What is being isolated

`readiness.ts` (stage 2) is the hard part: reconciling tool presence, bundling (#994),
and user acknowledgment into one object. Consumers: gate UI, bootstrap, spawn toast,
pickers. Nothing else may import it or recompute its inputs.

## Unknowns (explicit)

1. **#994 overlap**: the bundling branch touches `prerequisites.ts`/`toolchain.ts`/
   `runtimeTools.ts` concurrently. Sequencing: rebase this branch after #994 merges;
   readiness must treat bundled opencode as a usable provider via its `source:'bundled'`.
2. **Install-command copy per provider**: must match reality (npm specs in
   `cliUpdateOrchestrator.ts:589,622`); verify opencode's canonical install string once
   #994 lands (bundled = no command needed).
3. **Terminal-only default project shape**: what exactly bootstrap should create on
   continue-without-providers (single tmux/direct-PTY pane project in Dispatch?) — needs
   one UX decision from the user before stage 4.
4. **Login detection** (provider-not-ready forever-panes) — explicitly OUT of scope here;
   follow-up issue after this lands.
5. **App self-update** — separate issue, not in this decomposition.

## Fixture plan

All behavioral fixtures come from Stage 1's recorder: two environments × three code paths
(prerequisites check, default-cwd, bootstrap transitions), stored as JSON under
`testing/first-run/fixtures/` with the harness committed beside them. No hand-typed
plausible-looking inputs anywhere in this feature's tests.

## Status (2026-09-19, branch `fix/onboarding-first-run`)

All six stages are built in one PR. They are coupled: the policy's output shape
is what the gate, the bootstrap and the pickers read.

| Stage | Artifact | Verified by |
|---|---|---|
| 1 Recorder | `testing/system/first-run/prerequisites.firstRun.test.ts` and `testing/fixtures/first-run/` (3 environments, plus `baseline-main-82babd21.json`) | The live drift check re-runs both clean simulations on every push and compares provider rows. The baseline shows the wall: `ready:false, blocking:[claude,codex]` on both clean machines. |
| 2 Policy | `src/shared/setup/readiness.ts`; `required` removed from providers; `SetupCheckResult` = `usableProviders` + `firstSessionKind`; per-provider install command and docs URL in `registry.setup.ts` | `readiness.test.ts` over the recordings; the live verdict in the system test |
| 3 Reopenable | `open-setup` command, File › Setup…, and the new spawn error text | `firstRun.renderer.test.tsx` (reopen and re-probe), catalog native-menu contract |
| 4 Bootstrap | `awaitFirstRunDecision` plus `openFirstProject` (terminal fallback) in `useBootstrap.ts` | `firstRun.renderer.test.tsx`: 5 of 6 fail against main's bootstrap |
| 5 cwd and pickers | `defaultWorkspaceCwd` (home for a launchd `/`); `useMissingProviders` hint and `preferredPickerProvider` | `workspace.test.ts`, `PathPickerModal.renderer.test.tsx` |
| 6 Sweep | `firstRun.renderer.test.tsx`: the real `useWorkspace` plus the real SetupGate fed the recorded checks | Fail-first as above |

### Deviations from the plan, and why

- **`readiness.ts` lives in `src/shared/setup`, not `src/main/setup`.** Main still
  runs it, inside checkPrerequisites. It is in `shared` so renderer tests can run
  the same policy over the recordings. The isolation rule is kept: production
  consumers read the stamped fields and never import it.
- **No toast action.** The global toast is text-only, and adding actions to it
  is its own change. The spawn error now names a place that exists: "Open Setup
  (File › Setup…)", which is also a palette command.
- **Pickers hint and never disable.** A probe can be wrong (#495 A1), and the
  spawn re-resolves the CLI itself. A disabled row would turn a false negative
  back into a lockout.
- **No Settings → Setup rows for tool paths.** The reopenable Setup panel
  already hosts the manual path override, available at any time. A second copy
  in Settings would be a second owner for the same state.
- **Unknown 3 (the terminal-only default project)** took the ledger's
  recommended default: a single terminal project, opened only after the user
  presses "Continue with a terminal". Pressing Retry after installing a CLI
  opens an agent instead.
- **Unknown 1 (#994)** had already merged as #1002: a bundled OpenCode is
  `found` with `source:'bundled'` and counts as a usable provider.

### Review findings resolved after the first implementation

Two adversarial reviews (UI/keyboard, then policy/bootstrap) found these, all
fixed on the branch:

- **The install command pointed where the resolver never looked.** OpenCode's
  installer writes `~/.opencode/bin` and exports it from `~/.zshrc`, which
  `zsh -lc` does not source — so "install, press Retry" still said "Not
  installed". `WELL_KNOWN_BIN_DIRS` now includes that directory and `~/.grok/bin`,
  with a system test that installs a stub there and fails without the change.
- **The panel claimed modality without focus.** It is a real `Dialog` now.
- **The acknowledgment could be lost or repeated.** It closes in `finally`, and
  "continue without a provider" is persisted in `setup.json` beside the skipped
  helpers, so it does not reopen every launch and in every window.
- **Only the panel that asked records an answer**, so Close and Escape no longer
  differ in durable effect.
- **`open-setup` can no longer answer a parked panel.**
- **The test seam settles a parked waiter**, so one test's bootstrap cannot
  resolve into the next.
- **The live policy assertion is concrete per environment** instead of restating
  the policy function.

### Accepted, with reasons

- The first project waits on the prerequisites probe with no independent
  deadline (worst case two login-shell layers at 10 s each; measured 0.02–0.03 s
  here). A deadline would have to invent a verdict for a slow machine, which is
  what the lockout did; if this ever bites, bound the PROBE rather than the
  wait.

### Still open

- Login detection (#995 finding 7) is out of scope here, as planned.
- App self-update (finding 5) is a separate issue.
- Nothing tells a packaged-clean user whose first project opened in the bundled
  OpenCode that Claude Code and Codex exist, other than File › Setup…. A
  first-run notice would need an owner decision.
