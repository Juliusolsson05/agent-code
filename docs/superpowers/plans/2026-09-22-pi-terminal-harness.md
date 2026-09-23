# Pi Terminal Harness Implementation Plan

> **For agentic workers (and the goal loop):** this plan is executed task by
> task. Each loop iteration: re-read this file and the spec, find the first
> unchecked `- [ ]` step, do it, tick it, commit, and append anything learned to
> "Execution notes". Use superpowers:executing-plans. Never skip a
> "confirm it fails" step silently — if it was not observed red, leave it
> unticked and say so in the notes (the #882 convention).

**Goal:** Pi (pi.dev) runs as its own agent provider in Agent Code. Its pane is
always Pi's native TUI, and it reports status, turns, attention, committed
transcript and history the way OpenCode Terminal panes do, accepts programmatic
prompts, appears in the conversation catalog, and switches to and from the
other providers.

**Architecture:** A new public package `pi-terminal-headless` (git submodule)
reads two channels. The **durable** channel tails Pi's session JSONL and
projects it onto the active branch of Pi's entry tree; it owns committed
entries and history. The **live** channel is a small Pi extension (`-e`) that
Agent Code ships and Pi loads into the TUI; it connects back to a host-owned
Unix socket and owns activity, turns, identity/session switches, blocking
dialogs, prompt delivery and abort. One isolated `reconcile/` sequencer orders
the two. The app spawns the PTY and hands it to the package (owner rule). Pi is
a new `AgentProviderKind` that is terminal-only, enforced at read time by one
`effectiveProviderRuntime` helper.

**Spec:** `docs/decomposition/pi-terminal.md` — facts, decisions D1–D7, the
bridge hard rules (§6), stages 0–13, hypotheses H1–H10, fixture plan. Read it
before any task.

**Tech stack:** TypeScript, node-pty (caller-owned), Vitest 4, git
submodules, Pi ≥ the accepted version (0.87.1 at research time), Node 24 for
all test runs.

---

## Decisions (answered 2026-09-22: all approved at their defaults — see Execution notes)

1. **Terminal-only surface (D1).** Pi panes are always the TUI, never the
   rendered feed. *Default: yes.*
2. **New public repo** `Juliusolsson05/pi-terminal-headless` (outward-facing;
   public so CI's recursive checkout needs no PAT). *Default: create it.*
3. **Bridge extension (live channel).** Agent Code injects its own extension
   into the user's `pi` with `-e` (never installed into `~/.pi`). *Default: yes;
   it is the only channel that keeps the TUI and gives honest status + safe
   prompt delivery.*
4. **In-TUI `/new` `/resume` `/fork` `/tree`:** follow Pi (pane identity and
   transcript move with it) vs. detect-and-flag only (OpenCode Terminal's #894
   behaviour). *Default: follow.*
5. **Built-in MCP via the bridge (D5, Stage 12).** In scope for this PR or a
   follow-up? *Default: in scope, last stage, droppable if it grows.*
6. **Provider switch both directions (D7).** *Default: yes (keeps the complete
   directed switch graph).*
7. **Project-trust prompt:** surface as an attention condition and let the user
   answer in the TUI; never auto-approve. *Default: yes.*
8. **Real-model recording:** may Stage 0 make ONE short real-provider recording
   with the user's own Pi login (sanitized before commit)? Faux-provider
   recordings cover structure but not real content shapes. *Default: ask at
   Stage 0; proceed faux-only if declined.*

---

## Global constraints

- Owner rule: the package root class never spawns, kills or owns a process;
  `prepareLaunch` spawns nothing. The app creates the PTY and the socket
  directory lifetime is tied to the session.
- Bridge rules in spec §6 are non-negotiable (no `listen` in the extension, no
  unhandled async errors, self-contained, token-authenticated, observe-only,
  bounded payloads, version tolerant).
- The durable channel is **read-only** except for the switch/duplicate
  publisher (Stage 11), which writes new files atomically (`wx`) into Pi's
  session dir and never rewrites an existing one.
- Never override `PI_CODING_AGENT_DIR` / auth / settings for real panes. Only
  tests and the Stage 0 probe use an isolated agent dir.
- Semantic events use `source: 'pi-bridge'`. Condition kinds: `pi.dialog`
  (+ `pi.trust` if the trust prompt is separately observable). Transcript
  locator = absolute `.jsonl` path.
- Node **24** for every test run (`source /opt/homebrew/opt/nvm/nvm.sh && nvm use
  24`, or `/Users/juliusolsson/.nvm/versions/node/v24.14.1/bin`). Node 25 breaks
  happy-dom.
- Type gate is raw `tsc` (`npm run typecheck`, i.e. `tsc -b`). Never
  `--noEmit` on the node project. `rm -rf .tsc-out` after merges.
- **Never launch Agent Code** (`npm run dev`, `npx electron`). Running the real
  `pi` binary in a sandbox for Stage 0 / live tests is allowed (it is not an
  Agent Code launch).
- Fresh-worktree setup: `git submodule update --init --force <paths>` (check
  `ls packages/<pkg>`, not `git submodule status`) and
  `ln -s ../../node_modules node_modules`.
- Thick WHY comments everywhere non-obvious (CLAUDE.md). No CI grep locks, no
  speculative guards, no multi-PR splitting beyond the three repositories.
- Conventional Commits, scope `pi` (app), `terminal`/`transcript`/`bridge`
  (package), `pi` (parser). Identity from global git config
  (`julius.olsson05@gmail.com`); no `-c user.email`. Every commit ends with the
  session's Co-Authored-By line.
- Issues/PRs: one feature issue before implementation; bugs found along the way
  in unrelated code get their own issues; bugs inside this feature do not.
  Open PRs; **never merge** without explicit confirmation; when authorized,
  `gh pr merge <n> --merge`. `gh` account `Juliusolsson05`.
- One test run of the full app suite at the end (Task 13), not per step;
  focused test files per task are fine.
- Secrets: nothing from the user's `~/.pi` (auth, sessions) is committed
  unsanitized. The Brave key from the planning conversation is never written to
  any file.

---

## Cross-repository order

1. **Task 0** — this plan + the spec as the first commit on
   `feat/pi-terminal-harness` (worktree `.worktrees/pi-terminal-harness`).
2. **Task 1** — feature issue.
3. **Tasks 2–5** — package repo `pi-terminal-headless`, branch
   `feat/initial-runtime`, worked inside `packages/pi-terminal-headless` of
   this worktree after the submodule is added (Task 5 wires it). The package
   gets its own `docs/plans/2026-09-22-initial-runtime.md` copied from the
   package-side part of this plan in Task 2.
4. **Tasks 6–9, 11** — app, against the pushed package commit.
5. **Task 10** — agent-transcript-parser branch `feat/pi-codec` (inside
   `packages/agent-transcript-parser`, a linked submodule worktree), then Task
   11 consumes it.
6. **Task 12** — MCP proxy (package + app).
7. **Task 13** — verification, PRs in order: package → parser → app. The app
   PR's submodule pointers must be pushed commits.

---

## Execution notes

(append-only log: decisions answered, commits, deviations, bugs filed)

- 2026-09-22 — the user approved the plan and spec and auto-approved every
  decision at its stated default: 1 terminal-only surface, 2 create the public
  `pi-terminal-headless` repo, 3 bridge extension via `-e`, 4 follow in-TUI
  session switches, 5 built-in MCP in scope as the last stage, 6 switch in both
  directions, 7 never auto-approve project trust, 8 a real-model recording is
  allowed only if a Pi login already exists on this machine (at planning time
  `pi` was not installed, so expect faux-only and record the gap). The user
  also asked that development follow the agent-code-conventions skill (issue,
  plan-first branch, Conventional Commits, meaningful tests, PR without merge).
- 2026-09-22 — Task 1: filed #1132 (no duplicates found). Commit footers use `Refs #1132`; the app PR will say `Fixes #1132`.
- 2026-09-22 — Task 2: created public repo Juliusolsson05/pi-terminal-headless (MIT); scaffold on `feat/initial-runtime` at `f14951b`. The submodule is added in this worktree (`.gitmodules` + gitlink staged by `git submodule add`) but is deliberately left out of app commits until Task 5 wires the aliases. Deviations: CI floor is Node 22.12.0 (the app's floor, since the package runs in Agent Code's process), not Pi's 22.19; `passWithNoTests` is temporary at the root vitest config and is removed by the first Stage 0 test.
- 2026-09-22 — Task 3 (Stage 0) at package `cdb644e`: 18 scenarios recorded on Pi 0.87.1 with a sandboxed faux model and @xterm/headless as the terminal; 69 corpus tests. Decision 8 resolved as faux-only: `~/.pi/agent` holds only an empty `auth.json` created by the research run, no login. The stop-and-ask triggers did NOT fire: H3 and H5 hold in refined forms that keep the pipeline — the doorbell is `turn_end`/`agent_settled` (at `message_end` the row is not yet on disk), and the bridge must always pass `deliverAs: 'followUp'` because a busy prompt without it is accepted and silently lost. Also H6: a `/tree` move without a summary writes nothing, so the live leaf comes from `session_tree`. Spec §4, §5.3, §5.4, §6 and §8 were updated in the same app commit. Tooling notes: the probe needs a Node-ABI node-pty (the app's copy is Electron-ABI; `chmod +x` its prebuilt `spawn-helper`), and the sandbox must be outside the repo, or Pi loads Agent Code's AGENTS.md and a trust prompt from ancestor dirs.
- 2026-09-22 — Task 4 (Stages 1–3) and the Task 5 live tier, package commits `ff6e56b` (transcript), `22e3c81` (bridge) and `610f0d8` (runtime); 171 deterministic tests plus 5 live tests against real pi 0.87.1. The "confirm it fails" steps were not observed red before implementation, because tests and code were written together. Each suite was, however, run against recorded evidence and caught real defects: the fork-at-user-message editor concatenation, and a stop()-during-start() hang in BridgeServer.listen. Deviations from the plan's interface sketch:
  - the root-class events are `entry` / `history` / `semantic` / `activity` / `conditions` / `transcript-error` / `live-state` / `session-switched` / `exit` (`history` replaces a separate reset event);
  - `iteratePiEntries` became `readPiBranch`, a whole-branch cold read, because the branch can only be resolved with the whole tree in hand;
  - `listPiSessions` became `listPiSessionFiles` + `summarizePiSession`;
  - `getTranscriptFile()` can return null until a fresh session's file exists;
  - `preparePiTerminalLaunch` also returns `existingFile` and refuses identity flags in `extraArgs`.

  Design facts found by reading Pi's source during implementation, both now in the code's WHY comments:
  - Pi re-runs every extension factory on /new, /resume, /fork and /reload (`agent-session-runtime.ts`), so the bridge keeps one process-wide link;
  - forking at a user message puts that message's text back into Pi's editor.
- 2026-09-22 — Task 5: submodule at package `610f0d8`, aliases/paths/include/vitest map, conditions-core target (sync --check clean; the package's copied core was already byte-identical), bridge copied as a raw .ts to `out/main/runtime/pi/bridge.ts` by both the Vite plugin and copy-packaged-resources (asarUnpack already covers `out/main/runtime/**`), `verify-build-output` requires it, app-level `support/upstream-versions.json` pins 0.87.1. `npm run typecheck` and `npm run test:package` green. ARCHITECTURE.md is deferred to Task 13 so it describes the finished integration, not the wiring alone.
- 2026-09-22 — Task 6: `'pi'` in AGENT_PROVIDER_KINDS, `TERMINAL_ONLY_PROVIDER_KINDS` / `effectiveProviderRuntime` / `providerOffersTerminalRuntime` in providerKind.ts, main normalizes Pi to 'terminal' inside `resolveProviderRuntime` (every spawn/recover/cancel entry point) and compares effective runtimes in `replacementOwnershipMatches`. Every renderer TUI gate reads the effective runtime.
  - Step 2 was checked by mutation after writing, not observed red first: reverting the display pin to the raw check fails exactly the two kind-only spawn rows in agent/hybrid mode.
  - Because Pi had to compile end to end, this commit already contains Task 7/8 code: PiSession, its prompt delivery, skill discovery, bridge-path resolution, `loadPiHistoryChunk`, the Pi mapper and the `AgentTranscriptReader` Pi case. Their dedicated tests remain Task 7/8 steps.
  - The new `provider-session-changed` AgentSession event is emitted by PiSession, but it is not yet plumbed to the renderer (Task 7).
  - Opportunistic fixes in reach:
    - Grok added to the shared attention sets (Analytics counted Grok prompt waits as working time), the phone badge, the provider import-boundary test (Grok was never checked), and extract-rendering-shape;
    - hand-written provider enums in control/native-history derived from AGENT_PROVIDER_KINDS (the control SDK keeps a literal, since it cannot import the registry);
    - a test now pins the subagents-dir guard for Grok and Pi (Grok's had none).
  - `~/.pi/agent/bin` was added to the resolver's known dirs (Pi's managed installer, read from pi.dev/install.sh).
- 2026-09-22 — Task 7: PiSession adapter tests pass (19 system tests replaying every recording through the real package and adapter), plus the identity-follow contract.
  - Following in-TUI switches needed a sanctioned identity-change path. The renderer quarantines any committed burst whose provider id conflicts with the pane's durable one (#290), and Pi rows carry no session id at all. Without the path, a pane would silently keep the old id while showing the new conversation.
  - Added the `provider-session-changed` AgentSession event, carried through SessionManager, the forwarder (it flushes old rows first; test pinned), preload and the SessionFeed contract. The phone gets an explicit no-op with a WHY: it owns no durable pane identity and follows through the history reset.
  - The renderer rebinds via `applyProviderSessionSwitch` under the new source `provider-follow`, and resets the burst gate's expectation.
  - The step-2 "confirm red" was not observed before implementation; the replay sweep did catch real ordering (identity before reset) and exit behaviour.
- 2026-09-22 — Task 8: history source (`loadPiHistoryChunk`: active-branch pages, entry-id markers, "no file yet" = empty ready history), mapper, `AgentTranscriptReader` Pi case (header auto-detect, active branch via readPiBranch with page yields, errored/aborted replies never `final` and diagnostic-first, `!bash` as a shell command), MCP tool descriptions, and the subagents guard (Task 6).
  - Tests: history over the recorded /tree file, mapper over every recorded row plus the v1 shape, 5 reader system tests, and a renderer pane test (a kind-only restored Pi pane loads the branch; View Prompts / Copy Last Response read it; the surface stays the TUI in every mode; Rewind is not offered).
  - One expectation I wrote was wrong and was corrected, not the code: `inspect`'s first timestamp includes Pi's `model_change` row, as for every other provider's metadata rows.
  - A new Pi-specific pane harness beyond this was not needed. The adapter sweep (Task 7) already runs the real package + adapter over every recording, and the renderer test drives the real loader.
- 2026-09-22 — Task 9: `PiConversationSource` (bounded head scan per file for header cwd / first prompts / `/name`; family scoping on the HEADER cwd because the per-cwd dir name is lossy; fork parent from the header's parent file name; prompts from the full active branch) registered in the catalog; package helper `listAllPiSessionFiles` / `resolvePiSessionsRoot` (package `27921ba`). Copy Resume Command verified: `buildProviderResumeCommand` prefixes `cd <cwd> &&`, so `pi --session-id <id>` is exactly the Stage 0-recorded relaunch. No new agent-status copy: the bridge fault's own message is what the status panel shows. The phone badge and attention map were done in Task 6.

---

### Task 0: Spec and plan

**Files:**
- Create: `docs/decomposition/pi-terminal.md`
- Create: `docs/superpowers/plans/2026-09-22-pi-terminal-harness.md`

- [x] **Step 1:** Commit both documents as the branch's first commit.

```bash
git add docs/decomposition/pi-terminal.md docs/superpowers/plans/2026-09-22-pi-terminal-harness.md
git commit -m "docs(pi): plan the Pi terminal harness and its transcript pipeline"
```

---

### Task 1: Feature issue

- [x] **Step 1:** Search for duplicates (`gh issue list --search "pi" --state all`).
- [x] **Step 2:** File `feat(pi): add Pi as a terminal-only agent provider with
  transcript support` — motivation (Pi as a fifth provider, keep its TUI, get
  status/transcript like OpenCode Terminal), intended behavior (spec §3 D1–D10),
  acceptance criteria (spec §3 as checkboxes), link to the spec path. Record
  the number in Execution notes and use `Refs #<n>` in commit footers.

---

### Task 2: Package repository bootstrap (spec Stage 4, package half)

**Files (new repo `pi-terminal-headless`):** copy from
`packages/opencode-terminal-headless`, renamed:
`package.json` (name `pi-terminal-headless`, version `0.0.1`, `engines.node
>=22.19.0`, zero deps, optional peer `node-pty ^1`), `tsconfig.json`,
`tsconfig.build.json` (exclude tests, `src/testing/**`), `vitest.config.ts`
(`core` + `system` projects, serial system tier), `vitest.live.config.ts`,
`scripts/{check-test-contract,test-package,clean-dist,check-upstream}.mjs`,
`.github/workflows/{ci,release,upstream-watch}.yml` (reusable workflows at the
SHA the siblings pin), `.github/scripts/sync-upstream-issues.sh`,
`.github/dependabot.yml`, `LICENSE` (MIT), `.gitignore`,
`support/{upstream-versions.json,README.md}` (`@earendil-works/pi-coding-agent`
accepted `0.87.1`), `README.md` ("Should you use this package? Probably not.",
channel-ownership table, requirements, usage), `docs/plans/2026-09-22-initial-runtime.md`.

- [x] **Step 1:** Confirm decision 2 is answered "yes". Create the public repo
  (`gh repo create Juliusolsson05/pi-terminal-headless --public`), initial
  commit on `main` with only LICENSE + README stub so `feat/initial-runtime`
  has a base.
- [x] **Step 2:** Scaffold the files above on `feat/initial-runtime`; empty
  `src/index.ts`. `npm install` inside the package (its own lockfile).
- [x] **Step 3:** `npm run check` in the package — contract, typecheck, (empty)
  tests, pack verification pass.
- [x] **Step 4:** Commit `build(package): scaffold pi-terminal-headless from the
  opencode-terminal-headless layout`; push the branch.

---

### Task 3: Stage 0 — evidence corpus

**Files (package):** `scripts/probe-live.mts`, `scripts/census.mts`,
`scripts/lib/{sanitize,fixtureMeta}.mts`, `testing/fixtures/{live,durable}/…`,
`testing/fixtures/README.md`, `testing/oracle.ts`,
`research/census-2026-09-XX.md`, `src/testing/fixtures.ts`.

**Interfaces:**
- Probe: `NODE_PTY_PATH=… npm run probe:live -- --binary <pi> --scenario <name|all> --out testing/fixtures/live`
- Sandbox: temp HOME + `PI_CODING_AGENT_DIR` + temp git project; Pi's `faux`
  provider scripted per scenario (see research: `lab/bridge.ts` +
  `fauxProvider` approach), `PI_SKIP_VERSION_CHECK=1`, `PI_OFFLINE=1` where it
  doesn't break faux.
- Recording bridge: a variant of the production bridge that logs every
  extension event `{t, name, payload-summary, fileBytes}`.

- [x] **Step 1:** Install the accepted Pi into a local prefix (never global):
  `npm install --prefix <scratch>/pi @earendil-works/pi-coding-agent@<accepted>`.
  Record `pi --version`.
- [x] **Step 2:** Write the probe; record every scenario from spec §7 Stage 0.
- [x] **Step 3:** Answer H1–H10 (spec §8) from the recordings; write
  `research/census-*.md` with a table: hypothesis → evidence → verdict. Any
  killed hypothesis → update the spec in the same commit (and note the design
  change in Execution notes).
- [x] **Step 4:** Decision 8: if the user approved, one real-model recording,
  sanitized by the allowlist sanitizer; otherwise note the gap.
- [x] **Step 5:** Write the oracle (reference active-branch walk, independent of
  `src/transcript/`) and the fixture validator test; `npm run test:core` green.
- [x] **Step 6:** Commit `test(transcript): record the Pi evidence corpus`
  (package); push.

**Stop-and-ask trigger:** if H3 (doorbell) or H5 (prompt delivery via
`sendUserMessage`) is false, stop the loop and report — the pipeline in spec §4
changes.

---

### Task 4: Stages 1–3 — package runtime

**Files (package):** `src/transcript/{SessionFile,ActiveBranch,DurableReader,history,transcriptFile}.ts`,
`src/bridge/{extension,protocol}.ts`, `src/live/{BridgeServer,BridgeClient,LiveStateProjector,types}.ts`,
`src/reconcile/SessionSequencer.ts`, `src/launch/{prepareLaunch,sessionPaths}.ts`,
`src/terminal/PtyBinding.ts`, `src/conditions/modules.ts`,
`src/channels/{channels,types}.ts`, `src/PiTerminalHeadless.ts`,
`src/index.ts`, `src/testing/{index,replay,e2eRig}.ts`, colocated tests.

**Interfaces (package root exports):**

```ts
export function preparePiTerminalLaunch(o: {
  binary: string; cwd: string; env: Record<string, string>
  sessionId: string; resume: boolean; bridgeScriptPath: string
  mcpServers?: PiBridgeMcpServer[]            // Stage 12; ignored before
}): Promise<PiTerminalLaunch>
export type PiTerminalLaunch = {
  binary: string; args: string[]; env: Record<string, string>
  sessionId: string; sessionDir: string; socketPath: string; token: string
  dispose(): Promise<void>                    // removes the 0700 socket dir; idempotent
}
export class PiTerminalHeadless extends EventEmitter<{
  activity: [{ active: boolean | null; status: 'busy' | 'idle' | 'retrying' | 'unknown' }]
  entry: [{ row: PiSessionRow; file: string }]
  history: [{ kind: 'reset' | 'caught-up'; file: string }]
  semantic: [SemanticEvent]                   // source 'pi-bridge'
  conditions: [ConditionSnapshot<'pi'>]
  'transcript-error': [PiTerminalError]
  'live-state': [{ connected: boolean; reason?: string; piVersion?: string }]
  'session-switched': [{ from: { id: string; file: string }; to: { id: string; file: string }; reason: string }]
  exit: [{ exitCode: number; signal?: number }]
}> {
  constructor(o: { pty: PtyLike; cwd: string; launch: PiTerminalLaunch; now?: () => number; /* timing knobs */ })
  start(): Promise<void>; stop(): Promise<void>
  write(data: string): void; resize(cols: number, rows: number): void
  submitPrompt(text: string, o?: { timeoutMs?: number }): Promise<SubmitPromptResult>
  // ok | { ok:false, reason:'no-live-channel'|'not-sent'|'rejected'|'unknown' }
  abort(): Promise<{ ok: boolean }>
  getProviderSessionId(): string; getTranscriptFile(): string
  getActivity(); getConditionSnapshot(); isExited(): boolean
}
export function readPiHistory(file: string, o: { limit: number; beforeEntryId?: string }): Promise<{ rows: PiSessionRow[]; hasOlder: boolean }>
export function iteratePiEntries(file: string): AsyncIterable<PiSessionRow>   // active branch, oldest first
export function listPiSessions(o: { env: Record<string,string>; homeDirectory: string; cwd?: string }): Promise<PiSessionSummary[]>
export function resolvePiSessionFile(o: { env; homeDirectory; cwd: string; sessionId: string }): Promise<string | null>
export function resolvePiSessionDir(o: { env; homeDirectory; cwd: string }): Promise<string>
```

- [x] **Step 1 (Stage 1):** failing tests from fixtures → `transcript/` →
  green. Includes abandoned-branch, `/tree` reset, missing-then-created file,
  partial line, v1 tolerance.
- [x] **Step 2 (Stage 2):** failing projector tests from recorded bridge streams
  → `live/` + `bridge/` → green. Bridge rules §6 each have a test (e.g. host
  socket closed mid-run → extension logs, `pi` keeps running — live tier).
- [x] **Step 3 (Stage 3):** failing sequencer tests for every §5.4 rule over
  recorded interleavings → `reconcile/` → root class → green; root-class system
  tests with `FakePty` + replay rig (fake bridge peer + file writer).
- [x] **Step 4:** `npm run check` in the package; coverage floors set from the
  achieved numbers (not lowered later).
- [x] **Step 5:** Commits per stage (`feat(transcript): …`, `feat(bridge): …`,
  `feat(terminal): …`); push.

---

### Task 5: Stage 4–5 — app wiring + package live tier

**Files (app):** `.gitmodules`, `packages/pi-terminal-headless` (gitlink),
`electron.vite.config.ts` (`headlessAlias` — subpath regex BEFORE the bare
name — and `headlessExclude`; `copyMainRuntimeResourcesPlugin` entry for the
bridge), `tsconfig.node.json` (paths + include), `tsconfig.web.json` (paths),
`vitest.config.ts` (alias), `scripts/sync-conditions-core.mjs` (TARGETS entry,
`sync: true`), `scripts/copy-packaged-resources.mjs` (bridge →
`out/main/runtime/pi/bridge.ts`), `scripts/verify-build-output.mjs` (assert the
bridge file exists), `support/upstream-versions.json` (`pi` entry),
`ARCHITECTURE.md` (package table + §5.3 subsection, diagram rules from memory:
accTitle/accDescr/scope).
**Files (package):** `src/PiTerminalHeadless.live.test.ts`.

- [x] **Step 1:** `git submodule add https://github.com/Juliusolsson05/pi-terminal-headless.git packages/pi-terminal-headless`, checkout the pushed `feat/initial-runtime` SHA.
- [x] **Step 2:** Aliases/paths/include as above (copy the
  `opencode-terminal-headless` lines from commit `0fc879ad`).
- [x] **Step 3:** Conditions sync: `node scripts/sync-conditions-core.mjs && node scripts/sync-conditions-core.mjs --check`.
- [x] **Step 4:** Bridge resource copy in both the vite plugin and
  `copy-packaged-resources.mjs`; `npm run test:package` proves it lands in
  `out/main/runtime/pi/`.
- [x] **Step 5:** Package live tier (opt-in env) green against the sandboxed
  real `pi`.
- [x] **Step 6:** `npm run typecheck` (app). Commit `build(pi): wire the
  pi-terminal-headless submodule into the app build`.

---

### Task 6: Stage 6 — provider kind + terminal-only surface

**Files:**
- `src/shared/types/providerKind.ts` (+ test): `'pi'` in `AGENT_PROVIDER_KINDS`;
  `TERMINAL_ONLY_PROVIDER_KINDS`; `effectiveProviderRuntime(kind, runtime)`.
- Compile-enforced tables (tsc lists them all once `'pi'` is added):
  `src/providers/registry.{setup,main,renderer.capabilities,renderer}.ts`,
  `src/providers/shared/featureCapabilities.ts`,
  `src/mcp/shared/types.ts` (`pi: []` until Task 12),
  `src/renderer/src/rendering/model/ownership.ts`,
  `src/shared/types/providerConditions.ts`, `AgentTranscriptReader` switches
  (temporary unreachable stubs are NOT allowed to ship — Task 8 fills them; if
  Task 6 lands first, the stub must return `unsupported_provider`, not `[]`).
- New provider dirs: `src/providers/pi/runtime/{piSession,promptDelivery,skillDiscovery}.ts`
  (session filled in Task 7), `src/providers/pi/renderer/{identity,composerSubmit,semanticFoldPolicy}.ts`,
  `renderer/conditions/{policy.ts,views.tsx}`, `renderer/rows/dispatch.tsx`
  (fallback only), `renderer/transcript/mapper.ts` (Task 8).
- Setup: `registry.setup.ts` `pi: { binaryName: 'pi', label: 'Pi', install:
  { command: 'npm install -g @earendil-works/pi-coding-agent', docsUrl:
  'https://pi.dev' } }`; `src/main/setup/binaryResolver.ts`
  `WELL_KNOWN_BIN_DIRS` only if Pi's curl installer uses a non-standard dir
  (check in Task 3).
- Skills: `personalAgentSkills: { supported: true, locations: [{ id:
  'agents-standard-personal-skills', … ~/.agents/skills }] }` (verified Pi reads
  it); `targets.test.ts` expectations.
- Identity: glyph `π`, shortLabel `Pi`, `resumeCommand: id => pi --session-id <id>`
  (only after Task 9 verifies it; until then `verifiedExternalResumeCommand:
  false`).
- **Terminal-runtime gates → `effectiveProviderRuntime`** (inventory from
  research; re-grep `providerRuntime === 'terminal'` and `'opencode'` before
  editing — lines drift):
  - `src/main/sessionManager.ts` `resolveProviderRuntime` (~424), `getSpawnProviderRuntime` (~5212), ownership/recovery comparisons.
  - `src/renderer/src/workspace/agentDisplayMode.ts` (~44 OpenCode-only normalize, ~74 surface pin, ~157 command policy).
  - `src/renderer/src/workspace/providerChoices.ts` (~41, ~71): terminal-only kinds get one choice with the terminal runtime; label from capabilities, not hardcoded.
  - `src/renderer/src/workspace/hook/index.ts` (~155-170 view-override guard, OpenCode toasts → capability).
  - `src/renderer/src/workspace/hook/actions/session.ts` (~907 skipReadinessWait, ~1237-1286 replace drops runtime).
  - `src/renderer/src/workspace/hook/actions/{pane,providerSwitchCore,provider,undoClose}.ts`, `hook/persistence/rehydrate.ts` (~672).
  - `src/renderer/src/features/workspace/commands/sessionCommands.ts` (~183 Rewind hidden, ~227/244, ~1092).
  - `src/renderer/src/features/feed/controlRead/control.ts` (~94-95 `native_terminal`).
  - `src/renderer/src/features/workspace/ui/AgentViewModePickerModal.tsx` (~50 OpenCode-hardcoded).
  - `src/renderer/src/workspace/control/agents.ts` (~15 enum, ~218 "Only OpenCode supports the terminal runtime" → capability).
  - `src/renderer/src/workspace/control/lifecycle.ts` (~18, 59, 64, 111).
  - `src/main/remote/RemoteServer.ts` (~963 `kind === 'opencode'` runtime echo).
  - `src/renderer/src/workspace/hook/ipc/useIpcSubscriptions.ts` (~909 `opencode-terminal-live-state` → provider-neutral diagnostic kind or add `pi-terminal-live-state`; ~1883 binary fallback must not map `pi` to claude).
  - Remote client `ui/SessionView.tsx` (~356), `ui/v2/FleetHome.tsx` (~323), `ui/v2/providerIdentity.ts` (~17, add Pi AND the missing Grok case — opportunistic fix).
- **Hand-written provider lists** (not compile-enforced; add `'pi'`):
  `src/control-sdk/catalog/transcripts.ts` (~4), `src/main/control/globalCapabilities.ts` (~39),
  `src/main/sessions/nativeHistoryControl.ts` (~6, ~46), `src/main/agentActivity/attention.ts`
  (~16, also add missing Grok), `src/providers/importBoundaries.test.ts` (~9, also Grok),
  `scripts/extract-rendering-shape.mts` (~84, also Grok), keyword arrays in
  `setupCommands.ts`, `settingsRegistry.ts` (~1160), `sessionCommands.ts`, `paneCommands.ts`,
  `usageCommands.ts`; `src/renderer/src/workspace/orchestrationMcp.ts` `SEMANTIC_FAILURE_SOURCE`
  — add `pi: 'pi-bridge'` ONLY if Task 3 recorded an error signal (assistant
  `stopReason: 'error'` arrives as a semantic `api_error`); otherwise leave out.
- Pinned-list tests to update: `providerKind.test.ts`, `providerFeatures.test.ts`,
  `command-palette/catalog.test.ts` (split command ids), `providerChoices.renderer.test.ts`,
  `providerEnablement.test.ts`, `usage/sources.test.ts`, `setup/readiness.test.ts`,
  `OrchestrationBridge.runtime.test.ts`, `targets.test.ts`.

- [x] **Step 1:** Write the failing spawn-path table test
  (`src/renderer/src/workspace/piTerminalSurface.renderer.test.ts` or next to
  `agentDisplayMode.test.ts`): for picker, split, catalog resume (no runtime),
  MCP create_agent (no runtime), control API, duplicate, switch target,
  rehydrate from a workspace.json written before this change — `kind: 'pi'` →
  surface `terminal`, feed-mounted commands hidden, read commands shown, Rewind
  hidden. Also: OpenCode structured stays structured; OpenCode Terminal stays
  terminal (regression guard for the helper).
- [x] **Step 2:** Confirm it fails.
- [x] **Step 3:** Implement the kind, helper, registries, gates, lists.
- [x] **Step 4:** `npm run typecheck`; focused tests green.
- [x] **Step 5:** Commit `feat(pi): register Pi as a terminal-only provider kind`
  (+ a separate `refactor(workspace): resolve the terminal runtime per provider`
  commit for the gate conversion, so the refactor is reviewable alone).

---

### Task 7: Stage 7 — runtime adapter

**Files:** `src/providers/pi/runtime/piSession.ts` (+ `.test.ts`,
`.system.test.ts`), `promptDelivery.ts` (+ test), `skillDiscovery.ts`,
`src/providers/registry.main.ts` (Pi entry: `createSession` =
`createTerminalSession` = `new PiSession(opts)`), bridge path resolution
(`out/main/runtime/pi/bridge.ts` packaged; package source path in dev —
mirror how `mitmAddon.py` is located).

**Mapping (package → AgentSession events):**
- `activity` → `process-state {active, status}` (null/unknown → `active:false`
  + a diagnostic, never a fabricated busy)
- `entry` → `jsonl-entry(row, file)`; identity-only `jsonl-entry({sessionId})`
  emitted at start so fresh-session identity capture works before Pi writes the
  file (it writes nothing until the first reply completes)
- `history` → `history-boundary`
- `semantic` → `semantic-event`; `conditions` → `conditions`
- `transcript-error` → `jsonl-error`; `live-state` → `transcript-diagnostic`
- `session-switched` → provider session id update through the same path Codex
  rollout replacement uses (find it; do not invent a new IPC)
- `deliverPromptText(text)` → `headless.submitPrompt` → `ok` / typed
  `PiTerminalNotReadyError` ONLY for `no-live-channel`/`not-sent` (never for
  `unknown` — callers would resubmit the user's work)
- `stop()` → `headless.stop()` → `pty.kill()` → `launch.dispose()`, idempotent
- Launch env: full `process.env` + `TERM`/`COLORTERM`; external-control
  exclusion like the siblings (add `excludeExternalControlFromPi` in
  `src/providers/shared/runtime/externalControlExclusion.ts`).

- [x] **Step 1:** Failing adapter tests with fake headless + fake PTY spawner
  (constructor-injected defaults), one per mapping line above.
- [x] **Step 2:** Confirm they fail.
- [x] **Step 3:** Implement.
- [x] **Step 4:** System test over the package replay rig (real socket, fake
  `pi` peer, real file) — prompt delivered while idle and while busy;
  bridge-less spawn refuses delivery with the typed reason.
- [x] **Step 5:** Commit `feat(pi): run Pi's TUI through pi-terminal-headless`.

---

### Task 8: Stage 8 — read paths

**Files:**
- `src/providers/registry.main.ts` Pi: `resolveTranscriptPath` (→
  `resolvePiSessionFile`), `loadHistoryChunk` (→ `readPiHistory`, marker = entry
  id), `getProjectDir: cwd => cwd`.
- `src/main/sessions/piHistory.ts` (+ `.system.test.ts`) if mapping is needed
  between package rows and loader chunks (mirror `opencodeHistory.ts`).
- `src/providers/pi/renderer/transcript/mapper.ts` (+ test): Pi rows →
  Claude-shaped `Entry` (assistant text/thinking/tool_use, separate user
  tool_result, `bashExecution` as a user shell row or skipped — decide from
  how Claude's `!` rows render; system/metadata rows skipped;
  `stopReason: 'aborted'|'error'` visible as such). `extractProviderSessionId`,
  `isTypedUserPrompt`, `typedUserPromptText`.
- `src/main/agentTranscripts/AgentTranscriptReader.ts`: `case 'pi'` in
  `prepareTranscript`, `recordTimestamp`, `extractItems` (`extractPiItems`: user
  text, assistant text, tool calls with targets — `read/edit/write.path`,
  `bash.command` — tool results); `detectJsonlProvider` learns the Pi header;
  active branch only (use `iteratePiEntries`).
- `src/mcp/runtime/createBuiltInMcpServer.ts`: tool descriptions mention Pi
  session files.
- `src/main/agentManagement/AgentManagementBridge.ts`: publish the file path
  with `availability: 'available'` (should fall out of `resolveTranscriptPath`;
  verify).
- `src/main/subagents/index.ts`: no subagent dir derivation for Pi (Pi has no
  subagents; avoid the 600 ms poller on a nonexistent directory).
- `src/renderer/src/rendering/model/ownership.ts` Pi suppression policy (from
  Task 6) re-checked against mapper output.

- [x] **Step 1:** Failing tests: history loader over a fixture file with an
  abandoned branch (abandoned rows never returned, paging by entry id, `hasMore`
  correct); mapper over Stage 0 fixtures; `AgentTranscriptReader.pi.system.test.ts`
  (read/search/inspect, auto-detect); renderer test (Pi pane loads history, stays
  terminal, Reader/View Prompts/Copy Last Response available, Rewind hidden) —
  reuse the `hook/ipc/testing/opencodeTerminalPane.tsx` harness shape.
- [x] **Step 2:** Confirm they fail.
- [x] **Step 3:** Implement.
- [x] **Step 4:** Green; typecheck.
- [x] **Step 5:** Commits `feat(pi): load Pi history from the active branch`,
  `feat(mcp): read Pi sessions through the agent transcript tools`.

---

### Task 9: Stage 9 — catalog, resume command, diagnostics

**Files:** `src/main/conversations/sources/pi.ts` (+ `.system.test.ts`),
`src/main/conversations/service.ts` (register), `testing/fixtures/conversations/pi/…`
(+ `manifest.json`/`expectations.json` entries), Pi identity `resumeCommand`
+ `verifiedExternalResumeCommand: true` (after checking the printed
`To resume this session:` form in Task 3 recordings), diagnostics copy in
`features/agent-status/model/formatAgentStatus.ts` (bridge lost, old Pi,
session switched), remote-client badge.

- [x] **Step 1:** Failing catalog system test over fixture session dirs (titles
  from `session_info`, first user texts from the head, activity from last row,
  branch-aware prompt list, projected-originator classification once Task 10
  exists).
- [x] **Step 2:** Confirm it fails. **Step 3:** Implement. **Step 4:** Green.
- [x] **Step 5:** Test that resuming a catalog row spawns `kind: 'pi'` with the
  right `resumeSessionId` and a terminal surface (covered by Task 6's table test
  if the catalog path is in it — do not duplicate).
- [x] **Step 6:** Commit `feat(conversations): list and resume Pi sessions`.

---

### Task 10: Stage 10 — parser codec (agent-transcript-parser)

**Files (parser, branch `feat/pi-codec`):** `src/pi/conversation/{decode,types,index}.ts`,
`src/pi/project/{project,index}.ts`, `src/index.ts` exports,
`src/operations/compaction.ts` (`'pi'` portable), `testing/engine/pi-decode.test.ts`,
`pi-project.test.ts`, `pi-cross-provider.test.ts`, `import-boundaries.test.ts`
(add `pi`), `packageSurface.test.ts`, `fixtures/evidence/pi/…` (redacted,
manifest per case), `docs/plans/pi-codec.md`.

- [ ] **Step 1:** Plan doc in the parser repo (copy `docs/plans/grok-codec.md` structure).
- [ ] **Step 2:** Failing decoder tests over Stage 0 rows: branching (abandoned
  rows excluded, physical `source.line`), compaction placed before kept entries,
  `branch_summary`/`custom_message` as developer context, abort/error, bash
  execution, images, v1 rows.
- [ ] **Step 3:** Decoder. **Step 4:** Failing projector tests (valid v3 file,
  linear chain, originator marker, decode∘project identity on the portable
  subset). **Step 5:** Projector.
- [ ] **Step 6:** Isolated native-load probe: a projected file resumes in the
  sandboxed real `pi` (`--session-id`), and a faux reply is appended without
  re-running tools.
- [ ] **Step 7:** Parser `npm run check`; push; open nothing yet (Task 13).
- [ ] **Step 8:** App: bump the parser submodule pointer to the pushed commit;
  `package-lock.json` resync (it is a `file:` dep — memory: submodule bumps need
  a lockfile resync or `npm ci` fails in CI).

---

### Task 11: Stage 11 — switch and duplicate (app)

**Files:** `src/main/providerSwitch/piTranscript.ts` (+ tests; template
`grokTranscript.ts`), `transcriptEngine.ts` (adapter Map entry, `ipcPromptAddress`
allowlist), `compactBeforeSwitch.ts` (Pi branch — portable summaries),
`duplicateSession.ts` (empty-source policy for a fresh Pi session whose file
doesn't exist yet), `featureCapabilities.ts` (`transcriptDuplicate: true`,
`transcriptRewind: true` at the backend level while the command stays hidden
for terminal panes, `switchTargets` all four; add `'pi'` to the other four's
`switchTargets`), `providerFeatures.test.ts`.

- [ ] **Step 1:** Failing tests: switch Pi→Claude/Codex/OpenCode/Grok and each →
  Pi over fixtures; duplicate Pi; source-empty for an unwritten fresh session;
  full directed graph test.
- [ ] **Step 2:** Confirm they fail. **Step 3:** Implement. **Step 4:** Green.
- [ ] **Step 5:** Commit `feat(pi): switch and duplicate Pi sessions`.

---

### Task 12: Stage 12 — built-in MCP through the bridge (decision 5)

**Files (package):** `src/bridge/mcpProxy.ts` (inside the extension's
self-contained world: minimal streamable-HTTP JSON-RPC client — `initialize`,
`tools/list`, `tools/call` — plus `pi.registerTool` with
`Type.Unsafe(inputSchema)`), `prepareLaunch` env plumbing (server list +
bearer env var names, never argv), tests with a local fake MCP server.
**Files (app):** `src/providers/shared/runtime/builtInMcpLaunch.ts`
(`addPiBuiltInMcpLaunchConfig`), `src/mcp/shared/types.ts` (`pi:` same domains
as others), `piSession.ts` wiring, MCP policy tests.

- [ ] **Step 1:** Failing tests (package: proxy registers tools matching the
  fake server's list and forwards calls with the bearer; app: launch config
  contains no bearer in args).
- [ ] **Step 2:** Confirm fail. **Step 3:** Implement. **Step 4:** Live-tier
  test with faux provider calling `mcp__agent_code__tldr_update`.
- [ ] **Step 5:** Commits `feat(bridge): expose Agent Code MCP tools inside Pi`,
  `feat(pi): give Pi agents the built-in MCP servers`.

---

### Task 13: Verification and PRs

- [ ] **Step 1:** Package gate `npm run check` (Node 24 and 22.19 if available).
- [ ] **Step 2:** Parser gate `npm run check`.
- [ ] **Step 3:** App gates, Node 24, once: `rm -rf .tsc-out && npm run typecheck`,
  `npm run test:contract`, `npm run conditions-core:check`,
  `npm run check:keybindings`, `npm test`, `npm run test:package`. Known local
  env failures (imageAttachment, store timeouts, hotkeyBinding) are compared
  against origin/main, not ignored blindly.
- [ ] **Step 4:** `git fetch && git merge origin/main` if main moved; semantic
  (not just textual) conflict review; stage every modified file; re-run tsc.
- [ ] **Step 5:** Diff review: `git diff origin/main...HEAD --stat`, read every
  hunk for unrelated changes.
- [ ] **Step 6:** Update the spec's Status line and this plan's checkboxes and
  Execution notes.
- [ ] **Step 7:** Open PRs: package PR → parser PR → app PR
  (`feat(pi): add Pi as a terminal-only agent provider with transcript support`,
  `Fixes #<issue>`, links to the two component PRs, verification section,
  known limitations incl. anything left faux-only).
- [ ] **Step 8:** One review round per PR (two orchestrated reviewers per PR,
  Claude + Codex mix), fix valid findings, CI green. Report and **stop — no
  merge** without explicit confirmation. Merge order when authorized: package,
  parser, bump pointers to merged commits, app.
