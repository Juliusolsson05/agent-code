# Release Readiness: Tie Up Every Loose End, Then Ship — Stage Decomposition

> **Status:** LIVING LEDGER, driven by a goal loop that started 2026-09-19.
> Branch `docs/release-readiness`, worktree `.worktrees/release-readiness`.
> Update the checkboxes and the ledger in the SAME loop iteration that changes
> reality, then commit and push. This file is the memory that survives
> compaction. If it disagrees with GitHub, GitHub wins: re-verify and fix this
> file.
>
> **Trigger (owner, 2026-09-19, paraphrased faithfully):** "Finish all the loose
> application threads: main going red, every agent that is open and not
> complete, PRs opened from all directions by different agents. Do the work
> yourself through your own thread (do not prompt the other agents). Then do
> the full production release. Only Agent Code; nothing outside it. The goal is
> tying up all ends and making the application fully operational, so we can
> package it as an app and release it."
>
> **Operating rules (owner-granted):**
> - May open AND merge PRs after reviewing them (merge commits, `gh pr merge --merge`).
> - May use a FEW subagents (read-only research and independent review); do not burn credits.
> - Never prompt other workspace agents. Reading their transcripts is fine.
> - Scope: `agent-code` plus its landing page repo. Nothing else (not bringdown,
>   BuilderBase, or julius-workspace-features).
> - Never launch the app (`npm run dev` or electron). Reason from source; CI is the gate.
>
> **Testing standard (owner, 2026-09-19): write GOOD integration tests, using staged-decomposition principles.**
> - **Fixtures come from reality.** Base them on recorded or captured real behavior: an existing
>   corpus under `testing/`, a PTY/stream recording, a real persisted state file, real CLI output,
>   or a captured GitHub API payload. Never use plausible-looking literals someone typed. If no
>   recording exists, the first step of the fix is capturing one.
> - **Test before the fix, and watch it fail.** The failure must be on the REAL code path, for the
>   same reason the user hit it. Record the failing output in the PR body.
> - **Prefer integration over unit mocks.** Drive the real entry point: the command, the router
>   capture listener, the IPC handler, the main-process service, the workflow script run under
>   bash. Mock only the true edges (OS, network, provider binaries), and only with recorded data.
> - **Assert observable contracts and invariants,** not implementation details. A test written
>   from the same imagination as the code, asserting what the code does, proves nothing. That is
>   the vanity metric to avoid.
> - **Never delete or weaken a failing test to get green.** Against a real fixture, the test is
>   right and the code is wrong.
> - When semantics are genuinely unclear, meaning which source owns the state or what should
>   happen on disagreement, record the question in the ledger's owner items. Do not invent an
>   answer and then bless it with a test.

---

## A (what exists and is trusted, 2026-09-19 05:30 UTC)

- `origin/main` @ `cbaf48a5`: **green**. #1019 fixed the catalog snapshot that
  #844 (Grok) left stale; #1016 closed. It was the only red cause, and the full
  quality-gate passed, including the steps red main had skipped.
- Signed and notarized pipeline proven: `release.yml` → v0.0.2-beta.1 (a
  prerelease, published 2026-09-18). Developer ID and all 5 secrets are set.
- OpenCode CLI is bundled as a managed runtime (#1002, merged).
- Open release PRs (all reviewed 2026-09-19 by 2 independent reviewers each):
  #1010 icon, #1012 nightly, landing #3 Pages. Findings are listed in Stage 2.

## D (observable end state)

1. `main` green; every open PR merged or closed with a written reason.
2. Every unfinished agent thread (see Stage 1 ledger) finished (merged) or closed
   with a recorded reason. No orphan work in worktrees.
3. A fresh user can download the signed DMG, launch it, pass first-run setup
   with whatever providers they actually have, and run agents. No release-blocker
   issue is open.
4. A **stable (non-prerelease)** signed and notarized GitHub Release exists with
   release notes; rolling nightlies publish as prereleases; the landing page's
   download buttons resolve to the stable DMGs.
5. The goal-loop command no longer freezes the app.

---

## Stages

Each stage: **Produces / Verified by / Why separate / Reality check.**

### Stage 0: main green (DONE)
- [x] #1019 merged (`cbaf48a5`); #1016 closed; the imageAttachment census failure
  is local-environment only (it passes on CI; the cited session was deleted from
  disk), documented on #1016.

### Stage 1: Inventory ledger (enumerate from reality)
- **Produces:** the §Ledger tables below: every open issue bucketed, every
  worktree and branch classified, every unfinished agent thread with its designed
  fix, and the root cause of the goal-loop freeze.
- **Verified by:** each row cites a GitHub number, a commit or a transcript.
  Nothing is listed from memory.
- **Why separate:** implementing before enumerating handles only the threads in
  context, which is the 40% failure mode.
- **Reality check:** research sweeps from 2026-09-19: issue/branch triage,
  agent-thread briefs, freeze root cause, and the workspace status sweep.
- [x] Fold in the issue/branch triage results
- [x] Fold in the agent-thread briefs
- [x] Fold in the goal-loop freeze root cause
- [x] Push the orphaned #995 plan branch `feat/onboarding-first-run` (the only copy). Pushed, `68803efa`.

### Stage 2: Land the in-flight release PRs
- **Produces:** #1010, #1012 and landing #3 merged, with review findings resolved.
- **Verified by:** CI green on the merge result; the findings table is resolved
  or explicitly deferred with an issue.
- **Why separate:** these are already reviewed; they unblock nightlies and the site.
- **Reality check:** the six 2026-09-19 review reports.
- [x] **#1010 icon.** MERGED `20f48130` (2026-09-19); both reviewers' findings resolved. Doc fix pushed (`b0754260`). Still to do: correct the PR body
  ("A×" → Nord dragon + `</>` mark), merge `origin/main`, CI green, merge.
  Follow-up #1020 (no margin on macOS 12–15; an owner visual call).
- [x] **#1012 nightly.** MERGED `1195487d`; first nightly run 35428680412 (verify the result, and run the forced update test). Apply the review fixes:
  - (1) write the `built-from` marker LAST (a `gh release edit` after the uploads)
    and treat missing assets as changed;
  - (2) parse the marker robustly (`tr -d '\r'`, 40-hex, `head -n1`) and guard
    `git log` with `git cat-file -e`;
  - (3) pass `target_commitish: head-sha`;
  - (4) use its own concurrency group `release-nightly`, so a pending `release.yml`
    run is never cancelled, and fix the "queues" claim;
  - (5) make the nightly a **prerelease** with `make_latest: false`, so the stable
    release owns "latest" (fix the false "outranks by date" claim);
  - (6) `shopt -s nullglob`; tell a 404 apart from other API errors; drop the unused env;
  - (7) add a `force` dispatch input;
  - (8) a comment-only drift pointer in `release.yml`;
  - (9) plan/PR corrections: dispatch works only after merge, compare against the
    dispatched SHA, the delete→upload 404 window is an accepted trade-off.
  - Then merge `origin/main`, CI green, merge, `gh workflow run nightly.yml`, and
    verify the first nightly (signed, 4 fixed-name assets). Follow-ups: nightly
    version stamping; the landing status line (`published_at` is frozen).
- [x] **Landing #3 Pages.** MERGED `2ef8bfb0` (2026-09-19); both reviewers' findings resolved.
  - Add a "do NOT connect yet" guard: the hero screenshot fails privacy, the repo
    is private, every deployment URL is public and persists.
  - Drop the NODE_VERSION step (the builder reads `.nvmrc`; toml vars live under `[vars]`).
  - Fix the toml comments: the file does not pre-fill anything, it locks the
    output dir; `name` must be typed as the project name; pages.dev is permanent.
  - Fix the PR body's cross-repo #1011 link. Then merge.

### Stage 3: Goal-loop command freeze (owner-reported)
- **Produces:** an issue, a root-cause fix and a regression test; #1015 (the
  ipcRenderer listener leak) is fixed or explained.
- **Verified by:** the regression test fails before the fix and passes after, driven
  by the real command path; the owner confirms in the running app afterwards.
- **Why separate:** it makes the app unusable, and it is a release blocker.
- **Reality check:** the owner's report ("the whole app becomes unresponsive when I run
  the goal loop command; loops started via MCP work"), the MaxListeners warnings in
  the dev log, and the root-cause research.
- [x] Root cause recorded in the ledger
- [x] Fix PR merged: **#1022** MERGED `52af3dfd`. Round 1 got CHANGES REQUESTED (the hidden-workspace trap, stale-latch re-arm); fixed in `5d959c77` with 3 more fail-first regressions. Next: CI, then merge.

### Stage 4: Release-blocker issues (from the Stage 1 ledger)
- [x] #898 tmux restart data loss: MERGED #933 `40218b03`. PR #933, refreshed onto main (`93f60755`). A REAL sanitized v2 workspace.json fixture test was added (`b3961fba`). Independent review running; then CI and merge.
- [ ] #878 OpenCode modal subject: package PR **opencode-headless#14**, a shared parser with 4 replays of RECORDED 1.18.30 streams (3 fail first). Review running. Then: bump the agent-code submodule, resync the lockfile, and open a PR.
- [ ] #995 first-run (T1)
- Known now: **#995**, first-run lockout. SetupGate demands claude+codex with no
  install path; an under-gate spawn silently disables autosave; the first project
  defaults to `/`. The B5 thread holds a decomposition doc.
- [ ] Each RELEASE-BLOCKER row → fixed and merged

### Stage 5: Finish the unfinished agent threads (ledger)
Known now:
- B17 mobile remote-client gutter fix. Uncommitted in the MAIN checkout:
  `src/remote-client/src/styles.css` and `src/remote-client/src/ui/gutterContract.test.ts`.
- B18: OpenCode provider switch pins the model to `big-pickle`.
- B22: OpenCode wheel-scroll dead after remount (#843).
- B13: Grok leftovers (`globalCapabilities.ts` filter missing 'grok'; a stale WHY in `transcriptEngine.ts`).
- B9: promote about 19 hidden commands (needs the owner's pick, or a default).
- B20 follow-up #1006.
- #1018: orchestration children hide API errors.
- #1009: OpenCode live suite broken on every version.
- [ ] Each thread → merged, or closed with a reason

### Stage 6: Open PR backlog
- **#1013 unified stage layout** (#992): +11k/−15k lines, a complete, tested
  workspace rewrite that also moves autosave to v3; 117 commits behind and
  CONFLICTING. Resolve the conflicts, run a deep review (2 reviewers), and merge
  BEFORE the stable release, so at least one nightly soaks it. The release notes
  must list its retired commands and bindings (its PR body has the list).
- #933 / #931 / #945 / #935 / #876 / #575: 327–1329 commits behind. For each,
  rebase and finish, or close with a reason. #876 has 2 confirmed regressions in
  its own review.
- Dependabot: #991 needs a lockfile resync; #987's typecheck breaks (monaco, LSP, MCP SDK).
- [ ] Every open PR merged or closed with a reason

### Stage 7: Worktree/branch cleanup
- [ ] Orphan work rescued into PRs or explicitly discarded; merged worktrees removed.
  Watch out: worktrees with submodules need `rm -rf` + `git worktree prune`.

### Stage 8: Production release
- **Produces:** a stable signed and notarized GitHub Release, plus a landing page that serves it.
- **Verified by:** codesign, spctl and stapler in CI; `releases/latest` returns it;
  a DMG download resolves.
- [ ] `release.yml`: a prerelease/stable input (today it hardcodes `prerelease: true`)
  and `make_latest` for stable
- [ ] Version bump. Default **0.1.0** unless the owner says otherwise.
  Release notes cover everything since beta.1, including #1013's retired commands.
- [ ] README screenshots refreshed (pre-Nord, Jul 4); check them for privacy too
- [ ] Landing: a replacement hero screenshot (OWNER, or an approved redaction), the
  Cloudflare connect and domain (OWNER), and a status line that handles the stable
  release and the nightly
- [ ] Dispatch the stable release; verify the artifacts; publish

### Stage 10: Issue sweep, newest → oldest (owner, 2026-09-19)
**Start only after** Stages 2–7 are done: every PR merged or closed, and every agent thread
finished. It may overlap the release in Stage 8. The loop must NOT call goal_loop_complete while
this stage still has workable issues.
- **Produces:** every open issue ends in one of three states:
  - **closed as fixed**, by a merged PR with a fail-first integration test;
  - **closed as stale or obsolete**, with a comment citing evidence (a commit, file:line, or
    superseding PR/issue);
  - **left open**, with a comment saying why it cannot be done now. Examples: it needs real-use
    evidence, it is a feature or roadmap item, or it needs an owner decision (then also add it
    to the owner items).
- **Order:** `gh issue list --state open --limit 500`, sorted newest first. Batch the obvious
  stale closes; the Stage 1 STALE list is the first batch.
- **Method, for the hard ones:**
  - Read a LOT before touching code: the issue history, linked PRs, the code path, and any
    recordings.
  - Use internal subagents for research and for independent review (still ≤3 at a time).
  - Integration testing matters even more here. Many of these are cross-boundary bugs (boot,
    recovery, queue, orchestration) where a unit mock would bless the bug.
  - If the evidence needed does not exist (the #545/#290 class), record that and move on. Do not
    guess-fix.
- **Verified by:** the issue count drops; every closure links its evidence or its PR.
- [ ] Stage 1 STALE batch closed with evidence
- [ ] Newest-first pass complete

### Stage 9: Final verification → goal_loop_complete
- [ ] main green, 0 open PRs without a decision, 0 release-blocker issues,
  stable release live, landing links resolve (or blocked only on owner items)

---

## Owner-only items (the loop cannot do these; collect them and ask once)
- Clean hero screenshot, or approval of a redaction (the privacy check FAILED:
  real names, email drafts, raw prompts, local paths).
- Cloudflare Pages connect and custom domain.
- Version number for the stable release (default 0.1.0).
- #1020 icon margin (a visual call).
- B9 command-promotion pick (if no sensible default).
- Real-use qualification from #958 (8 h of use, 24 h of disk, signed Intel).

## Isolation
Each thread is its own worktree, branch, plan and PR. No bundling of unrelated
fixes. The release pipeline (`release.yml`, `nightly.yml`,
`reusable-app-build-macos.yml`) changes only in Stage 2 and Stage 8.

## Unknowns
- Exact list of RELEASE-BLOCKER issues (Stage 1).
- Whether #1013's conflicts are mechanical or semantic against 117 newer commits.
- Whether the goal-loop freeze and #1015 are the same bug.
- Whether stale PRs' problems still exist on main.

## Fixture / evidence plan
- Freeze: a regression test driven by the real command path (renderer test project).
- Nightly: the first real dispatched run is the evidence; there is no dry-run substitute.
- First-run (#995): evidence from the B5 audit plus a packaged smoke run in CI.

---

## Ledger (Stage 1 output; fill from the research sweeps)

### Issues (triage 2026-09-19: 128 open)
**RELEASE-BLOCKER (4):**
- **#995** first-run lockout. L; see T1.
- **#1021** Goal Loop freeze. Fix PR #1022 is open.
- **#898 tmux sessions killed on every restart (data loss).**
  - Cause: `src/main/index.ts:846-852` reads `parsed.workspace?.sessions`, but the saved file is
    `{version:2, windows}`, so the list comes back empty and `tmuxRecovery.ts:54-57` kills every
    managed session as an orphan.
  - Fix: PR #933, MERGEABLE/CLEAN but 340 behind. Rebase, add a real-fixture integration test
    (a real v2 workspace file), review, then merge.
- **#878 OpenCode permission/question modals show no subject** (users approve bash blind).
  - The title is read from `['title','tool',…]` (`EventDispatcher.ts:957`, `OpencodeHeadless.ts:387`).
  - OpenCode is bundled now, so this is on the default path. S–M.

**OPERATIONAL (38):** fix the S-sized, user-visible ones before stable if cheap. Candidates:
- #827 `wait_agents` timeout cap
- #875 `observations.wait` exited schema
- #879 reload drops orchestration metadata
- #867 Enter on a focused Cancel applies the change
- #863 closing a tab orphans its rows (moot if #1013 lands)
- #699 Option+Shift+Arrow swallowed in the composer
- #730/#731/#732 ghost logs
- #677/#678 queue chips
- #868 (PR #876)
- #919/#941/#942 (PR #945)
- #920 (PR #935)
- #1018, #843 (T5)
- #993 dev and installed app share state with no lock (important for a real release: users who
  also run dev)
- The rest are M/L, or evidence-blocked (#545, #290, #327, #774…). Leave them open after
  release unless cheap.

**POLISH/FOLLOW-UP (52):** includes #233/#234 (formal compat review: the accepted versions
claude 2.1.143 / codex 0.130.0 are stale versus the 2.1.278 / 0.155.1 in daily use), #1006,
#1007, #1015, #1020, #1009, #877.

**STALE/OBSOLETE (12):** close with evidence: 118, 242, 495, 530, 669, 684, 839, 901, 768, 786,
832, 944.

**FEATURE/ROADMAP (22):** leave open. #992 = PR #1013; #1011 = PR #1012.

### Worktrees / branches (75 worktrees, 365 local branches, 25 stashes)
- **ORPHAN WORK to rescue or decide:**
  - `onboarding-first-run`: #995's plan. The ONLY copy; push it.
  - `grok-code-provider`: docs superseded by #844.
  - `heap-watchdog-defer`: superseded.
  - `feed-debug-batch`: PR #750 closed.
  - `session-picker-identity`: superseded by #899.
  - `feed-render-rewrite`: superseded by #555.
  - `overlay-reland`: #518, reverted on purpose.
  - `portability-hardening`: 2 plan docs, not on origin.
  - `dependency-alerts-root`: uncommitted vitest/tsx bumps.
  - `test-overhaul/agent-code`: uncommitted .gitmodules and submodule pointers.
  - 35 local-only branches: 15 perf research docs from 05-18, among others.
- **Merged cleanup:** 42 clean merged worktrees, which can be removed. Inspect these first:
  `mac-distribution-readiness` (2 untracked tests not on main), `rendering-slice16` (fixture
  edits), `composer-placeholder-detection`, the 6 `agent-code-cluster-worktrees/*` (content
  landed via #356), and `agent-code-pr-merge-audit`.
- **Main checkout:** the B17 gutter fix is uncommitted (T3). The untracked
  `2026-09-07-loose-ends-takeover.md` is the previous loose-ends plan. It is mostly done: Task 6
  (perf numbers) and part of Task 7 remain. Supersede it with this ledger and do not commit it.

### Agent threads (research 2026-09-19; implement from these, do not re-derive)
- **T1 #995 first-run lockout (B5), L.**
  - Plan: `docs/decomposition/onboarding-first-run.md` on branch
    `feat/onboarding-first-run` (worktree `.worktrees/onboarding-first-run`,
    based on old `76ede416`; the doc says rebase after #994, which is merged as #1002).
  - Root cause:
    - claude and codex are `required:true` (`src/providers/registry.setup.ts:43,50`),
      and there is no Continue button (`SetupGate.tsx:154-163`).
    - The gate cannot be reopened, so the toast at `sessionManager.ts:2586` points at nothing.
    - `useBootstrap.ts:87-121` spawns under the gate; a failure leaves
      `bootstrapComplete` false, which disables autosave (`useBootstrap.ts:221-225`,
      `useAutoSave.ts:242`).
    - The first project's cwd is `/` (`ipc/workspace.ts:64-66`, `process.cwd()`).
  - Plan stages:
    1. Recorder fixtures under `testing/first-run/fixtures/` (vitest system project).
    2. `src/main/setup/readiness.ts` as the single policy; providers are no longer required.
    3. A reopenable gate (menu, palette, toast action, Settings path rows).
    4. Bootstrap de-race.
    5. Default cwd = home, and pickers disable missing providers.
    6. An integration system test.
  - Open owner question, with a default: with ZERO providers, the default workspace
    is a single terminal-pane project (the agent's recommendation; use it).
- **T2 B9 promote commands to default, S.**
  - The owner picked "14": every ON command except the debug and remote ones.
    Remove `pickerVisibility:'advanced'` from:
    - `layoutCommands.ts`: rotate-layout, normalize-layout, hard-normalize-layout
    - `paneCommands.ts`: toggle-tail-all, attach-detached-to-grid, attach-all-detached-for-tab
    - `sessionCommands.ts`: set-agent-view-mode, soft-reload-agent, switch-agents-provider,
      remove-cybersecurity-block, enable-agent-transcripts-mcp,
      enable-agent-management-mcp, enable-ai-workspace-mcp, enable-root-agent-code-management
  - Test to update: `taxonomy.test.ts` ~:98-117.
  - **Depends on #1013**, which retires rotate/normalize/hard-normalize and the two
    attach commands. Do this AFTER deciding #1013 and promote only the survivors.
- **T3 B17 phone gutter 14→12px, S.** DONE: PR #1023 MERGED `2af693d8`, with a fail-first contract test (4 bands failed on main).
  - The change is UNCOMMITTED in the MAIN checkout: `src/remote-client/src/styles.css`
    plus the new `src/remote-client/src/ui/gutterContract.test.ts` (8/8, and the
    remote suite 65/65).
  - Move it to a branch from origin/main and open a PR. Do NOT include the untracked
    `docs/superpowers/plans/2026-09-07-loose-ends-takeover.md`.
- **T4 B18 OpenCode switch pins big-pickle, S–M.**
  - Cause: `transcriptEngine.ts` `resolveOpencodeTargetProfile` (~:279) falls back
    to `listOpencodeModels()[0]`, which is `opencode/big-pickle`. The projector then
    stamps it on every imported message (`agent-transcript-parser`
    `src/opencode/project/nativeResume.ts:76,106,162,269`), and OpenCode's
    `lastModel()` keeps it for good.
  - Fix: use OpenCode's own order. First the config `model`; then the first `recent`
    entry of model.json (`XDG_STATE_HOME` or `~/.local/state/opencode/model.json`)
    that still exists in `opencode models`; otherwise throw the existing "select a
    model" error. Never fall back to `[0]`.
  - Add the helper `readOpencodeRecentModels` in
    `src/providers/opencode/runtime/opencodeCliSessions.ts` and mock it in
    `transcriptEngine.test.ts`.
  - Check whether a `variant` must be stamped too (model.json has a variant map).
- **T5 #843 OpenCode wheel dead after remount (B22), M–L.**
  - Cause: `CappedTextBuffer` (512 KiB, `sessionManager.ts:425`) evicts the TUI's
    one-time mode setup (1049h/1000h/1002h/1003h/1006h), so `attachAgentPty`
    (`:3346`) replays without mouse tracking.
  - Fix, part 1: an `onEvict` hook feeds a DEC private-mode tracker that models
    mutual exclusion, `ESC c` and the 1047/1048/1049 aliases. Prepend the state AS
    OF THE REPLAY START, never the current state; prepending current state was
    already tried and withdrawn.
  - Fix, part 2: route Jump to Latest for OpenCode terminal panes through
    `LiveServerClient` `POST /tui/execute-command {"command":"session.last"}` via
    `opencodeTerminalSession.ts`; replace the stale note in
    `tile-tree/terminalFollow.ts:56-65`. Never send the TUI chord.
  - History: `docs/superpowers/research/2026-09-08-post-merge-regression-audit.md`.
- **T6 Grok leftovers (B13/B11): DONE on main** (`a4d20723`, `2caa5428`). Only nits
  remain: `transcriptEngine.ts:5` `join , dirname`, and "leader leader" at
  `grokSession.ts:5`. Fold these into any nearby PR.
- **T7 #1006, S:** add `enable-goal-loop-mcp` mirroring `enable-goal-mcp`
  (`sessionCommands.ts` ~:747), add it to `goal-loop/controlReference.ts:22`, and
  move the catalog from 134 to 135 by growing the subtrahend.
- **T8 #1007, S:** move `goal-loop-preview` off Cmd+Shift+Y (it clashes with the
  macOS Sticky Note service) in `command-keybindings/defaults.ts:302`, then update
  the docs and pass `check:keybindings`. Fits with the freeze fix, same feature.
- **T9 #1015, S–M:** not a leak. It is one listener per pane. Use one shared
  `ipcRenderer` listener feeding a set of subscribers (the LSP diagnostics bridge
  pattern in `preload/api/ipc.ts`) for `goal-loop:changed` and
  `dictation:stream-transcript`.
- **T10 #1017 internal-review minors, S:**
  - `unsupported:*` rows are skipped on conflict and early-exit paths in
    `AgentCodeConventionsService.ts` (~:1166, :1856, :2060, :2155, :2294).
  - `installedHealth` reports 'unsupported' instead of 'degraded' when target
    resolution fails (`resolveTargetsSafely` ~:2950).
- **T11 #1013 unified stage layout, M:**
  - Built in OpenCode session `ses_1953a797…`; 3741 tests green locally; 117
    commits behind and CONFLICTING.
  - The owner asked for a thorough review that never happened (B14 stopped).
  - Unconfirmed product calls inside it: never displace an occupied lane, a `new`
    badge on pooled spawns, Clear Lane on ⌥⌫, and deleting the related-agent strip.
  - Resolve the conflicts, run 2 reviewers, and merge before stable.
- **T11 #1013 review A (persistence), 2026-09-19: CHANGES REQUESTED.**
  - **BLOCKER:** #1013 leaves the outer `WORKSPACE_FILE_VERSION` at 2, so older builds, including
    the released beta, treat a v3 file as writable. Downgrade, then a two-window close, runs the
    beta's `adoptWorkspace`, and its autosave drops the whole pool; the reviewer reproduced this.
    Fix: write version 3, read 2 and 3. Older builds then see the file as `unreadable` and go
    read-only, by design (`workspaceFile.ts:60-72`). #933 shares the decoder, so it follows.
  - MINOR: add a one-time `workspace.json.pre-v3-<ts>.bak` before the first v3 write; carry v2
    bury notes (`legacyWorkspaceV2.ts:75`), which are dropped today.
  - MINOR: the tests are generated or hand literals. Add migration tests on REAL recordings: #933's
    sanitized live file, `dispatch-global-d23.json`, and a fresh sanitized copy of the owner's
    workspace.json. Pin field survival (tmuxName, providerSessionId, title, orchestration,
    agentNameId, MCP) and v2→v3→re-read idempotence.
  - NIT: a v2 file with zero tabs drops its buried rows; hand-edited `tabs: null` unlocks autosave
    over an empty pool; closing a hibernated terminal leaks its tmux session until the next sweep.
  - Verified OK on real data: 27/27 sessions, 10/10 lanes, tmuxName, and orchestration links kept,
    with zero field changes. Idempotent. Autosave gating correct. #933 reads v3 correctly.
  - Still to do: reviewer B (UI/keyboard/UX lens).
- **T12 landing `feat/direct-beta-download`:** an uncommitted/unmerged fix in the
  landing worktree `.worktrees/landing-page-v1` ("commit/push/PR it?", unanswered).
  Evaluate it against the nightly/stable plan.
- **T15 #1024: goal-loop continuations delivered mid-turn (owner, 2026-09-19).**
  33 continuations in 66 minutes of one unbroken working turn. Stream `working→idle` phases
  are not turn-scoped for Claude: background subagents and long tool calls produce them.
  Fix: use Claude Code's `Stop` hook as the authoritative turn boundary, and never deliver
  into a busy input.
  Test: replay a recorded session that has a background subagent. HIGH priority, since it
  is a shipped feature misbehaving. Schedule right after the Stage 4 blockers.
  **Decomposition (researched 2026-09-19):**
  - A: what already exists.
    - Agent Code already receives each session's `Stop` hook at `/hooks/tldr/stop`
      (`BuiltInMcpHttpHost.handleTldrHook` → `tldr/enforcement.ts`), but ONLY when the
      registration has a reporting domain (`hasReportingDomain`: tldr or goal). A
      goal_loop-only session gets no hook.
    - `GoalLoopService` (`src/main/goalLoop/GoalLoopService.ts:107,195`) infers the
      turn end from `semantic-event` → `reduceWorkingState` working→idle, which is
      not turn-scoped for Claude.
  - Stage 1 (recorder, evidence).
    - Ground truth is `~/.config/agent-code/proxy/<project>/`, the raw provider
      HTTP/SSE flows. Subagent requests are included, because Claude Code's Agent tool
      runs in-process.
    - Cut a window from THIS session (5906040e…) spanning a main-turn tool call, a
      background-subagent flow, and a goal-loop delivery. It must also show
      `feed-debug/5906040e….jsonl` `flow_selected` / `flow_ignored` / `stream_phase`
      around the same time. Sanitize it, and commit it under
      `testing/fixtures/goal-loop-turn-boundary/`.
    - Replay it through the REAL Claude proxy adapter into semantic events, and show a
      working→idle while the main turn is still open. That is the fail-first.
  - Stage 2: the turn-boundary source.
    - A small module `goalLoop/turnBoundary.ts`: for a provider with hooks (Claude,
      Codex) the boundary is a NON-blocked `Stop` hook for that session's
      registration. The `stop` hook fires and TLDR enforcement decides; only an
      "allow" outcome is a boundary.
    - Phases remain the fallback only for providers without hooks (OpenCode, Grok).
    - Install the hook whenever the goal_loop domain is enabled, not just tldr or goal.
  - Stage 3: a delivery guard. Never deliver while the agent's input is busy (queued
    input, or composer in a working state), whatever the trigger.
  - Test: the recorded replay plus the hook sequence give exactly one continuation per
    real stop. Also: a blocked Stop (TLDR asks for an update) followed by an allowed
    Stop gives one continuation, not two.
- **T14 Redesign the Agent Activity command (owner, 2026-09-19): "that modal is ages and just shit across the board".**
  This is a full redesign or reimagining, not a patch. Approach:
  - Read the current command, its modal, and its data sources first.
  - Enumerate what the owner actually uses it for; the Agent Analytics (#964) and
    TLDR/Goal peeks are neighbours.
  - Write a decomposition with a design proposal.
  - Build it with the frontend-design standard and real recorded session data as fixtures.
  - Ask the owner at the proposal stage if a product call is genuinely open.
  Scheduled after Stage 4's blockers.
- **T13 #1018** (orchestration hides API errors) and **#1009** (OpenCode live suite
  red on every version).
- Out of scope: julius-workspace-features, bringdown, BuilderBase, the 6.1 GB old-install archive.
- NOTE: B5's and B20's transcripts contain secrets (an Apple app-specific password
  and a Brave key). They are local only; never paste them anywhere.

### Goal-loop freeze (root cause, research 2026-09-19, reproduced in a renderer test)
- **Chain of events:**
  1. The palette `goal-loop-preview` command ("Goal Loop"), or its keybinding
     Cmd+Shift+Y (`command-keybindings/defaults.ts:302`), calls `toggleGoalLoop()`,
     which sets the app-wide `useGoalLoopView.latched` flag
     (`features/goal-loop/viewState.ts:9-11`, `commands.ts:6-12`).
  2. `useKeybinds.ts:472-479` is a capture-phase keydown gate. It checks ONLY that
     flag, and calls preventDefault + stopPropagation on every key.
  3. The overlay renders only when the pane HAS a loop (`GoalLoopPane.tsx:44`
     returns null otherwise), and the normal case is no loop. So all input
     (composer, terminal, the palette chord) is swallowed with nothing on screen.
  4. The only exits are Escape or a hardcoded Cmd+Shift+Y. Window blur does not
     clear it, although it clears TLDR.
- **Origin:** regression from #1008 (`c1286081`, which added the gate). The router
  tests always stubbed a loop, so they never covered the no-loop case. Starting a
  loop via MCP never touches the flag, which is why MCP loops work.
- **Principle violated:** `lib/interaction-ownership.ts:1-11`. Input ownership must
  follow the mounted DOM, not UI store state.
- **Fix:**
  1. Gate only while `[data-goal-loop-overlay]` is mounted; a stale flag is
     dismissed and the key routes normally.
  2. Render the overlay with a "No goal loop on this agent" empty state, and add
     "press Escape to dismiss" to the description.
  3. `onBlur` also dismisses.
  4. The dismiss chord goes through `routedCommandForEvent`, so a rebound chord
     still closes it.
- **Regression test:** `goalLoop.router.renderer.test.tsx`, run with no loop. The
  repro is in the session scratchpad at `goal-loop-freeze/`.
- **#1015:** the goal-loop part is NOT a leak. There is one listener per mounted
  pane, so 11 panes cross Node's default max of 10; the same goes for dictation
  (one per composer). Optional follow-up: a single app-level subscription.

### Progress log
- 2026-09-19 18:45Z (session resumed after an interrupt; the goal loop is re-armed):
  - **MERGED:** #1044 (`ef8219d0`, #1018 orchestration failures, APPROVE on the delta re-review) and #931 (session-ownership plan doc, with a comment that it predates #1013).
  - **Reviews landed:**
    - #1046 APPROVE. Its three description nits are fixed (`060bc1ff`).
    - #1045 CHANGES REQUESTED, now fixed (`aa57a8cb`): ⌘⇧G is Monaco's Find Previous. The router yields the chord while editor chrome owns the target, the stale-latch branch yields too, reservations.ts records Monaco's claim (14 reserved, 9 approved overlaps), and turning Goal Loop MCP off now ends a running loop. Two of the new tests fail without the yield.
    - #1047 UI lens CHANGES REQUESTED, now fixed (`159176d3`): the panel is a real Dialog (focus trap, inert background), the acknowledgment closes in `finally` so a failed optional-skip cannot strand the first run, the button says Close unless a bootstrap is actually waiting, and a failed install's output is capped. Three new tests fail against the previous gate.
  - **Stage 6 rebases done:** #945 (`0c0ce8cc` + `ff0b9a0b`) and #935 (`3af56e83`) merged onto main.
    - #945 placed main's three new quit-time owners into the committed composition: the extension runtime (pause stays reversible on before-quit, disposal is a new `stopExtensions` stage after startup settles), the performance drain, and tmux recovery's canonical decoder. The shutdown diagram was rewritten in main's accTitle/accDescr/scope convention and re-rendered.
    - #935 resolved #1013's deletion of the related-agent strip and the ARCHITECTURE 8.2.1 rewrite.
  - **Trap recorded in memory:** a conflicted merge commits only the index, and `tsc -b` is incremental — an unstaged fix passed locally and failed CI on #945.
  - **Reviews now run on CODEX orchestration children** (owner's call): #1045, #876, #945, #935 under runId `codex-review-round-1`. A Claude reviewer covers #1047's policy/bootstrap lens.
  - Owner housekeeping: the old `/Applications/Agent Code.app` (0.0.2-beta.1) is in the Trash and its stale Dock tile is removed; `~/.config/agent-code` (5.6 GB) and `~/Library/Application Support/agent-code` (4.2 GB) are untouched.
- 2026-09-19 13:40Z:
  - **MERGED:** #1039 (`fe2b3bfc`, T9 shared IPC) and #1043 (`479df7a7`, T5 part 2: Jump to Latest; merged main in, resolving a screenGate test conflict). #843 CLOSED with evidence (#1041 + #1043).
  - **#1044 (#1018):** CHANGES REQUESTED, then fixed, then APPROVE on the delta review.
    - Fixes: the Grok regression; source-scoped signals per catalog §3.1; errorType, with MessageAbortedError / instance / part_overflow treated as non-terminal; the kind-less meta defaults to Claude; the fail-open clause is pinned.
    - Package PRs MERGED: opencode-headless#16 (`973ad4e`) and opencode-terminal-headless#4 (`c8486dc`), both bumped in #1044.
    - Merge on green CI.
  - **#1047 (T1 #995 first-run lockout) OPENED.**
    - Recorder: the real checkPrerequisites on a simulated clean Mac. The baseline shows the wall: ready:false even with bundled OpenCode.
    - readiness.ts policy; reopenable Setup (command + File › Setup…); bootstrap waits for the first-run decision and falls back to a terminal; cwd is home instead of `/`; picker hints.
    - 5 of 6 integration tests fail against main's bootstrap.
    - Two reviewers running (policy/bootstrap lens, UI/keyboard lens).
    - The branch was renamed to fix/onboarding-first-run; the old plan branch feat/onboarding-first-run on origin is untouched.
  - **Reviewer running** on #1045 + #1046.
  - Unconfirmed product call inside #1047: a packaged-clean Mac opens its first project in the bundled OpenCode, with no notice that Claude Code or Codex exist beyond File › Setup….
- 2026-09-19 11:05Z:
  - **MERGED:** #1037 (`aee2c0e2`, T10 managed-skills minors) and #1041 (`82babd21`, T5 part 1, DEC-mode replay).
  - **New PRs:**
    - #1045: T7 #1006 (`enable-goal-loop-mcp`, which gets a real-hook override/reset test) and T8 #1007 (goal-loop-preview moves ⌘⇧Y → ⌘⇧G; the router tests pin that the old chord is dead).
    - #1046: T2 B9, the nine survivors of the owner's pick of 14 promoted (#1013 retired the other five). Fail-first taxonomy test.
  - The T6 nits are already gone from main.
  - **Pending:** the #1043/#1044 reviewer; CI for #1039, #1043, #1044, #1045 and #1046.
- 2026-09-19 10:15Z:
  - **MERGED:**
    - **#1013** (`4d0374af`): the unified stage layout. Its verification of every fix commit was APPROVE, and the minor backup fix was applied.
    - **#1028** (`d19d5a8e`): the goal-loop Stop boundary. It fixes the owner's ~40 mid-turn continuations (#1024), after three review rounds. Follow-up: #1040 (the Claude-Esc proxy error hook, and the subagent classification in the adapter).
    - **#1034** (`89b24d39`): T4, the OpenCode model and variant. Parser #33 is merged.
    - **#1036** (`b3d57001`): #1027, the TLDR latch trap.
    - **#1042** (`0c2a189b`): the security deps. #991 is closed as superseded.
  - **Nightly VERIFIED:** the forced run 35432092386 replaced all 4 asset ids, kept its marker, and left `latest` as 404.
  - **Open, with state:**
    - #1037 (T10 managed-skills): the review's MEDIUM is fixed (the discovery-error row no longer blocks delete).
    - #1039 (T9 shared IPC): all six per-pane channels are shared, and the warning check is fixed.
    - #1041 (T5 part 1, DEC-mode replay): APPROVE, with the follow-ups folded in.
    - #1043 (T5 part 2, Jump to Latest): opencode-terminal-headless #3 is merged and proven live against the real TUI. `messages_last` works; `session.last` is accepted and ignored. CI fixed after its tile-tree failure.
    - #1044 (#1018, orchestration failures): catalog-first, 27 recorded errors. opencode-headless #15 is merged. Needs review.
  - **Now unblocked by #1013:** T7 (#1006), T8 (#1007), T2 (command promotion), T1 (#995), and rebasing #945 and #935.
- 2026-09-19 09:30Z:
  - **MERGED:** #1035 (`39323fda`, Stage 8's stable channel). The first nightly (run 35430444567) PUBLISHED: 4 fixed-name assets, prerelease, marker `built-from: 7446aef3`, both arches `accepted / Notarized Developer ID`, and `releases/latest` still 404. A forced re-run (35432092386) is in flight to prove asset replacement.
  - **#1013:** the verification of every fix commit is APPROVE (2528/2528). Its one minor, the truncated backup on a failed write, is fixed (`3f61d426`). Merge on green CI.
  - **#1028:** the third review is small; addressed in `4181873a` (a typed prompt seeds busy; the Claude-Esc limit is pinned and tracked in #1040). Merge on green CI.
  - **New PRs:**
    - #1041: T5 #843 part 1, replay DEC-mode restore, real OpenCode recording plus real headless xterm. Under review.
    - #1042: the security deps, superseding #991 with a surgical lockfile that both npm 10 and npm 11 gates accept.
    - #1036, #1037 and #1039 are under review.
  - **Stage 6 decisions:**
    - #987 is DEFERRED post-release: Monaco's TS API was removed, the MCP SDK is duplicated with workflow-mcp, and the LSP types changed.
    - #991 is superseded by #1042.
    - #945 and #935 CONFLICT; rebase them after #1013.
    - #931 (plan only) and #876 (feed order, #868) are clean; review, then merge.
    - #575 (OpenCode apply_patch rendering, a July draft) goes post-release.
  - **#995's plan branch** is confirmed on origin.
- 2026-09-19 08:45Z:
  - **Open PRs, with state:**
    - **#1013 (unified stage):** parity sweep A's findings are all covered; its one new fix is Close Tab closing the commanded agent's project (`461ab40f`). A verification reviewer is running on all the fix commits.
    - **#1028 (goal loop):** redesigned after the delta re-review (`e91624fe`: the quiet auto-pause is removed; Resume needs no pending tool, an idle phase and 60 s of silence; unattributable hooks are dropped). CI is green, and the same reviewer is re-verifying.
    - **#1034 (T4 OpenCode model):** OpenCode's own order (agent → config → recent → catalog default), each checked against the catalog, and the saved variant is carried through parser #33 (MERGED `2d08ea3`). Follow-up #1038 (Duplicate/Rewind should keep the source model).
    - **#1035 (Stage 8, stable release channel):** review APPROVE. `target_commitish`, the line-break guard and `+build` handling applied.
    - **#1036 (#1027 TLDR latch trap):** needs review.
    - **#1037 (T10 managed-skills minors + T6 nits):** needs review.
    - **#1039 (T9 #1015 shared IPC listener):** needs review.
  - **#1018 (orchestration hides API errors):** an evidence catalog from real feed-debug recordings is being built (research agent, worktree `.worktrees/fix-orchestration-api-error`). Implementation follows the catalog.
  - **Waiting on #1013's merge:** T7 (#1006), T8 (#1007), T2 (command promotion) and T1 (#995), all of which touch the catalog, keybindings or bootstrap.
  - **Nightly** run 35430444567: build-app is green, package-macos is running.
- 2026-09-19 08:00Z (entries below are newest first):
  - **#1026 MERGED** (`1212d98e`, OpenCode permission subject; closes the app half of #878).
  - **#1032 MERGED** (`7446aef3`): the first nightly (run 35428680412) failed in `nightly.test.ts` › "caps the commit list" (5 s timeout, macOS runner). The cause was 205 `git commit` spawns in setup, now one `git fast-import` (283 ms). The timeout is unchanged. Nightly re-dispatched as run 35430444567.
  - **#1028** review (CHANGES REQUESTED) addressed in `2f151932`/`ac8d4376`:
    - quiet-turn pause (60 s with no events and no pending tool → paused/interrupted);
    - Resume closes a quiet turn;
    - agent_id hooks are dropped at the host;
    - StopFailure deliberately NOT registered: it shares `--settings` with the external-control exclusion and an older CLI rejects unknown hook keys;
    - another Stop hook blocking is tracked in #1033.
    
    Main merged in (`6d7b6e65`); the only CI failure was the nightly test fixed by #1032. A delta re-review is running.
  - **#1013** fixes (all fail-first):
    - A blocker: file version 3 + `.pre-v3` backup (`e3ff9218`); migration pinned on real recordings (`8e398b1c`).
    - Parity sweep B: the Spotlight target (`52d9f30d`) and the cold v1 extension command (`a409c859`).
    - Review B:
      - retired-id overrides pruned (`db7a2f9f`);
      - grandchildren listed (`eb046585`);
      - badge lifecycle (`60a39109`, `c8f0c5ab`);
      - ⌥⌫ gaps (`0e0d69ac`);
      - agent-facing text and docs (`33e62de7`);
      - lane and ⌘-digit grammar tests (`af0c88d7`).
    
    The PR body now lists the owner decisions (never displace, the badge, ⌥⌫, strip deletion, Close Project = Close Tab). Follow-ups: #1030 (persistence edges), #1031 (phone list, pooled goal loop, dictation, v3 phone test). Parity sweep A (nav/close) is still running. CI is pending.
- 2026-09-19 07:13Z: MERGED #1022 (`52af3dfd`, goal-loop freeze, closes #1021), #933 (`40218b03`, tmux data loss, closes #898) and #1012 (`1195487d`, nightly). First nightly dispatched: run 35428680412. #1024 root-caused from recordings and fixed in PR #1028 (Stop-hook boundary). #1026 review findings fixed (`48bce88a`). Filed #1027 (TLDR latch trap), #1029 (bidi spoofing).
- 2026-09-19 07:55Z: #1023 MERGED (phone gutter). #933 reviewed GREEN; docs fixed (`7da7a255`), CI rerunning. #878 package half merged (opencode-headless#14 `62440add`); app PR #1026 in review. #1013 CI fixes pushed (lockfile, projection shape). #1024 decomposed.
- 2026-09-19 07:20Z: **#1013** merged with main (`e52b0352`).
  - 5 conflicts resolved, plus 1 semantic port (performance-monitor agentIdentity to the stage model).
  - Catalog 123 re-derived; tsc clean; all 48 test files main touched pass.
  - Pending: CI, then 2 deep reviewers.
  - #1013 lands before #995, because #995's bootstrap and default-project stages build on #1013's model.
- 2026-09-19 06:15Z: #1010 MERGED (`20f48130`).
  - #1012 rewritten: the logic moved into the tested script `scripts/release/nightly.mjs`,
    with 16 system tests on recorded payloads, all failing first. The `.gitignore` bug
    (`release` ignored at depth) was fixed. A verification review is running.
  - #1022 round-2 fixes pushed.
  - The owner added T14 (the Agent Activity redesign) and Stage 10 (the issue sweep).
- 2026-09-19 05:40Z: Stage 1 inventory folded in. Landing #3 merged (`2ef8bfb0`). #1022 opened (freeze fix, 4 fail-first regressions). Owner added the integration-testing standard.
- 2026-09-19 05:25Z: #1019 merged → main green. Reviews of #1010, #1012 and landing #3 done.
