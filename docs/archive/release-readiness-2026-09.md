# Release Readiness: Tie Up Every Loose End, Then Ship — Stage Decomposition

> **Status: ARCHIVED 2026-09-25.** This was the living ledger of the
> release-readiness goal loop (2026-09-19 → 2026-09-20). The loop is over:
> 0.1.0 shipped on 2026-09-20, and 0.1.1–0.1.3 followed. Nothing below is a
> live plan. The checkboxes and "running" notes are frozen where the loop
> stopped, and GitHub is the source of truth for anything still open.
>
> It is kept for its evidence: which review findings were valid and which
> were withdrawn, which product calls were the owner's, and the lessons in
> the progress log (for example, that a batched mutation harness once
> reported a live mutation as dead).
>
> Items that were still open and tracked nowhere else were filed when this
> was archived:
> - T16 "make `/model` work" → #1197
> - T17 test-suite audit → #1198
> - #1030 item 1 (v2 bury notes) → #1199
>
> Its successor is the quality loop, planned in `docs/plans/`.

> **Original status, while live:** LIVING LEDGER, driven by a goal loop that started 2026-09-19.
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
- [x] `release.yml`: a prerelease/stable input and `make_latest` for stable —
  DONE in #1035 (merged). The workflow takes `release_channel`
  (prerelease|stable), validates it against package.json's version, and sets
  `make_latest` explicitly.
- [x] Version bump to **0.1.0** — staged on branch `release/0.1.0`
  (worktree `.worktrees/release-0-1-0`): package.json + package-lock.json, and
  `docs/decomposition/release-0.1.0-notes.md` finalized with every PENDING
  marker resolved. `CHANNEL=stable node scripts/release/identity.mjs` dry-run
  returns `tag=v0.1.0 / prerelease=false / make_latest=true`, and the prerelease
  channel correctly REFUSES a stable version. Owner asked for the release on
  2026-09-20; it is held only until #1060 (the paste-envelope display fix) merges,
  so the shipped build contains it.
- [ ] README screenshots refreshed (pre-Nord, Jul 4); check them for privacy too
- [x] Landing: **the code needs no change — verified 2026-09-20.** The page
  resolves `releases/latest`, which GitHub defines as the newest release that is
  neither a draft nor a prerelease, so the rolling nightly can never win it.
  That endpoint 404s TODAY (no non-prerelease release exists), which is exactly
  why the status line is silent and the buttons fall back to the Releases page.
  Publishing v0.1.0 with `make_latest=true` flips both automatically:
  `findDiskImage` suffix-matches `-arm64.dmg` / `-x64.dmg`, and the real beta
  assets are named `Agent.Code-0.0.2-beta.1-arm64.dmg`, so `Agent.Code-0.1.0-arm64.dmg`
  matches. The `published_at`-frozen nightly concern does not apply for the same
  reason: a prerelease never reaches this code.
  - [ ] **OWNER**: a replacement hero screenshot (or an approved redaction).
  - [ ] **OWNER**: the Cloudflare Pages connect and the domain.
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
- **T16 Make `/model` work (owner, 2026-09-19).**
  The slash command that switches a provider's model does not work today, and
  the obvious implementation — driving the provider's own TUI by screen
  automation (type `/model`, read the menu, arrow to the row, press Enter) —
  is the thing to avoid if there is any alternative. Investigate, in order:
  1. A native/API route per provider: OpenCode already takes model + variant on
     `prompt_async` (see the prompt-selection memory: agent, model and variant
     must be sent TOGETHER or the session is moved to the default agent), and
     its config carries a model list; Claude Code and Codex both have config
     and CLI flags whose reach needs checking; Grok's ACP control may expose it.
  2. A restart-with-selection route: the provider-switch machinery already
     replaces a session while keeping its transcript, so "change the model" may
     be a narrower case of that.
  3. Screen automation LAST, and only with real integration tests: a recorded
     TUI menu per provider, the condition system below as the readiness signal,
     and no blind key timing.
  Owner's words: "pretty sure we can not rely on screen automation, lets figure
  out how to maybe do this in a different way? Or maybe we do the screen
  automation but that requires quite a bit of integration testing and love."
- **T17 Test suite audit and restructuring (owner, 2026-09-19).**
  The suite has grown by accretion: unit/renderer/system projects, `testing/`
  fixtures, per-feature `*.test.ts` beside sources, live suites, package suites.
  Group and re-hierarchy it so a reader can find the test that owns a behaviour,
  and so the tiers mean something. Use an ORCHESTRATED agent for the review half
  (the owner named Astra). Deliverables:
  - an inventory of every suite with its tier, runtime and what it actually
    pins;
  - a proposed hierarchy (by owner/feature, not by accident of file location),
    with the moves scripted rather than hand-done;
  - the test-quality rules already recorded (real recorded fixtures, fail-first
    on the real path) applied as the acceptance bar for what stays.
  Tied to it: the SCREEN CONDITION system is still unused for some providers.
  Work out how far it can drive provider automation (readiness, menu state,
  prompt acceptance) for every provider, since that is what a real automation
  test needs instead of sleeps.

- **T18 The phone remote-control menu is unusable (owner, 2026-09-20): "completely fucked up … flashing, switching positions for the agent index like a million times".**
  The agent index on the phone remote reorders and repaints continuously, so the
  list cannot be read or tapped. Treat it as a LIST IDENTITY/ORDERING bug before
  a styling one: something is re-deriving the order (or the keys) on every feed
  tick instead of holding a stable identity, which is the same class of defect
  as the stale-session severing fixed in #911. Start from the phone's list
  source and its sort, capture a recording of the flashing (the remote feed is
  already journaled), and pin the fix with that recording. Pre-launch blocker:
  remote control is a headline feature and this makes it unusable.

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
- 2026-09-19 20:15Z — Codex round complete, Stage 6 closed out, issue sweep started:
  - **MERGED:** #1045 (`⌘⇧G` + Goal Loop MCP, closes #1006/#1007), #945 (`quit lifecycle`, closes #941/#942) and #935 (window-scoped delivery, closes #920). All three carried a second Codex delta round that found real defects first.
  - Codex found, and this session fixed: the transcript-code-block gap in #1045's editor yield; concurrent quit-failure dialogs in #945; a refused close releasing a live claim, plus a repair ticket spent before the repair finished, in #935; and in #1047 both the ~/.opencode/bin resolver gap (the install→Retry loop dead-ended) and a new window parking forever on an acknowledged terminal-only machine.
  - **#1047** is Codex-APPROVE, conflict with the merged command PRs resolved (catalog now 125/119/44), waiting on CI.
  - **Issue sweep, newest first:**
    - #1011 CLOSED with evidence (nightly shipped and verified; the prerelease flag is a recorded deviation, since the landing page resolves the newest NON-prerelease release and the stable will be it).
    - **#1048 OPENED** for #1030 items 2–4: a corrupt `tabs`/`projects` container no longer migrates to an empty pool (it unlocked autosave and overwrote the real file), a v2 file with zero tabs keeps its buried rows, and closing a hibernated terminal kills its tmux session. Item 1 (bury notes) stays open: it needs a parked-note surface first.
    - **#1049 OPENED** for #1029: Trojan Source. One shared helper escapes bidi overrides, isolates, zero-width characters and a lone CR as `⟨U+202E RLO⟩` on every approval surface (Claude, Codex, OpenCode, Grok), driven by the real recorded OpenCode ask.
  - **T14** decomposed at docs/decomposition/agent-activity-redesign.md on branch feat/agent-activity-redesign, with the owner's real 33-agent fleet recorded as the evidence. Two owner calls are open: modal vs takeover, and whether it absorbs Close Old Agents + Close Idle Orchestration Agents.
- 2026-09-19 19:30Z — Codex review round 1 (owner asked for Codex reviewers):
  - **MERGED:** #876 (`68f7d6e3`, feed block order, Codex APPROVE) and #1046 (`ecf7c727`, command promotion, APPROVE + its three description nits fixed).
  - **#1045** (`0e8cc5e9`): Codex found the editor yield incomplete — a transcript code block is a real Monaco instance with no global-editor marker, so the overlay still latched over it. Both guards now match Monaco's own root class through one shared selector.
  - **#945** (`ff0b9a0b`, `9309b9d5`): CI caught a merge that staged index.ts but not applicationShutdown.ts. Codex then found that a failed committed quit offered only "Keep Agent Code Open" and ignored the answer — with every window gone and window creation fenced, that stranded the process. A new quitFailureDialog.ts offers Retry Quit and acts on it.
  - **#935** (`b6223f78`): Codex found a P1 — a REFUSED kill-owned still released the display claim, so a live session's output was quarantined with no owner to show the gap. The release now needs the close to have happened or the backend to be gone. Also: the pane stops offering "Refresh view" once the ticket is spent, and the old test that clicked it again only passed because its mock ignored the ticket.
  - **#1047**: the policy/bootstrap review found a BLOCKING one — the panel told users to run OpenCode's installer, which writes ~/.opencode/bin and exports PATH from ~/.zshrc, which `zsh -lc` never sources, so "install, then Retry" dead-ended. Fixed in `14377943` with the durable provider-less acknowledgment, the answer-recording rule, the open-setup guard and the test-seam waiter.
  - **Delta re-reviews dispatched** to the same Codex children for #1045, #945, #935; a fresh Codex reviewer is on #1047.
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
- 2026-09-20 20:05Z — **Eight merged. Five PRs open, all reviewed; #1093/#1095/#1096 each needed a second design pass.**

  **MERGED since the last entry**: **#1093** (#881 opencode port), **#1095** (#1094
  state-lock TOCTOU). Closed: #881, #1094.

  **OPEN**: #1096 (#854, review fixed), #1099 (#1070, in review), #1100 (#1075, in
  review), #1101 (#925, in review).

  **The reviews keep paying for themselves.** Every one of the last four found a
  defect that source-reading did not:

  - **#1096 (#854)**: my pending-prompt design was right for Claude and Codex and a
    STRICT REGRESSION for OpenCode and Grok — they have no readiness gate, so the
    "wait" was one instant retry and the prompt was lost while the reply said "do
    not send it again". The justifying corpus contains zero rows from either. Also
    a measured ~40 MB/day/child heap growth (a `Promise.race` reaction on a
    never-settling promise, retained per iteration), and a cancel that fired from
    all seven delivery callers — so a human typing in the child's pane silently ate
    the brief.
  - **#1095 (#1094)**: a cross-process syscall trace showed my "residual" was a
    6-in-80 real race, plus a macOS `ENOTSUP` bug that would crash startup on any
    non-APFS home. Redesigned: a stale lock is REPLACED atomically, nothing is ever
    deleted by a non-owner, and the remaining window is made detectable by
    `revalidate()`.
  - **#1093 (#881)**: my fix turned a recoverable state into a permanent lie — a
    server that was merely late kept a "reload this agent" banner forever and
    reported `transcript_unavailable` to every parent.

  **New issues from reviews**: #1097 (mid-session OpenCode server death is silent),
  #1098 (the residual lock window, with the case against a breaker lock).

  **#925 (PR #1101)** came out of #918's planning findings and is the other half of
  the contention that made #1089's measurements bad: the bridge's status cache set
  `expiresAt` at REQUEST time, so any read slower than 250 ms was pruned before it
  answered and the next poll queued a duplicate behind it — a cache built to
  prevent a thundering herd producing one.

  **Method note worth keeping**: a batched mutation harness reported two mutations
  DEAD that were alive when re-run individually. Every table in these PRs is now
  measured one mutation at a time against a tree verified clean between runs.

- 2026-09-20 19:00Z — **Five merged (#1087, #1088, #1089, #1090, #1092). Four PRs open, all reviewed at least once. Three new bugs found BY the reviews and filed.**

  **MERGED**: **#1087** (#863), **#1088** (#867), **#1089** (#827), **#1090** (#879),
  **#1092** (a main-branch CI flake). Issues closed: #863, #867, #827, #879.
  **#896 reopened deliberately** — #879 unblocked half of it; the composer half remains.

  **The reviews are finding real defects in my fixes, not nits.** Four of the
  five merges needed a second pass, and two needed a redesign:

  - **#1089** (wait_agents cap) was reworked TWICE. Round 1: the 90 s cap was
    derived from a threshold that does not exist in the vendored Claude source,
    and sat ABOVE the MCP SDK's own 60 s default request timeout — the cap made
    the reported loss *deterministic* for any client on defaults. Round 2: the
    clamp I added bounded the sleep and left the `listAgents` await in the same
    loop unbounded; the reviewer measured one call at **87,250 ms** against a
    30 s promise. Now every bridge read is raced against one deadline, the poll
    loop reserves the measured cost of a round trip for the final read, and a
    cut-short reply says `outputsUnavailable` rather than holding the transport
    open.
  - **#1095** (state-lock TOCTOU) was reworked after a **cross-process syscall
    trace** showed my "residual" was a 6-in-80 real race, plus a macOS
    `ENOTSUP` bug that would have crashed startup on any non-APFS home. The
    steal-and-restore design is gone: a stale lock is now REPLACED atomically,
    nothing is ever deleted by a non-owner, the path is never empty, and the
    remaining double-belief window is made DETECTABLE by `revalidate()`, which
    `index.ts` calls before writing any state.
  - **#1093** (OpenCode port conflict) converted a recoverable state into a
    permanent lie: a server that was merely late left a "reload this agent"
    banner forever and reported `transcript_unavailable` to every parent. The
    feed now carries channel-health diagnostics so the renderer can clear it.

  **New bugs found by reviewers and filed**: **#1091** (built-in MCP replies
  ride a silent, non-resumable SSE stream — the real mechanism behind #827),
  **#1094** → fixed in #1095, **#1097** (an OpenCode terminal whose server dies
  MID-session reports nothing), **#1098** (the residual lock window, with the
  reason a breaker lock may not be worth its own staleness problem).

  **OPEN**: #1093 (review fixed, CI running), #1095 (review fixed, CI running),
  #1096 (**#854**, in review), and #1094 is closed by #1095.

  **#854 is evidence-driven**: the app's own run journal had 134 recorded
  delivery failures across 11 app runs. 47 of 55 `create_agent` bootstrap
  failures were "not ready YET" — 26 Claude trust-dialog, 21
  composer-unpainted — and only 5 ever reached the absorption stage, which
  settles the issue's paste-folding hypothesis as NOT the cause. The fix holds
  the prompt until the gate opens instead of returning an error that invites
  the retry that orphans a half-written draft.

- 2026-09-20 17:30Z — **#1087 merged. #1090 opened (#879). Three reviews landed; a main-branch CI flake root-caused and fixed (#1092).**

  **MERGED**: **#1087** (closes #863, row bindings left pointing at a closed project).
  The review found a **regression I introduced**: the scrub re-allocated EVERY row
  whenever any row changed, and row object identity is load-bearing — the
  lane-selection race check in `dispatch.ts` compares rows across a wake to decide
  whether the grid moved under the user. An unrelated close during a cold wake
  (up to 30 s) therefore read as "the grid changed", and an agent that had just
  been woken was never placed, with no toast. Each row now keeps its original
  object unless that row changed, pinned in `laneSelectionWake.renderer.test.tsx`
  with a control close that scrubs nothing. Also: the legacy `projectTabId` is
  folded rather than deleted, the creation failure path closes the placement
  overlay instead of leaving it up and latched, and two WHY comments that claimed
  properties the code did not have were corrected.

  **#1090 (closes #879)**: reload / switch provider / resume / rewind stripped an
  orchestration child's relationship metadata, so the parent's
  `wait_agents({runId})` returned `done: true, agents: []` **while the child was
  still working**. `replaceSession` builds the successor from spawn's fresh
  metadata on purpose, so every field it keeps has to be named — and the
  orchestration fields never were. Fixed with an explicit
  `SUCCESSOR_RELATIONSHIP_FIELDS` keep-list in `idRemap.ts`, which also covers
  `orchestrationBootstrapPromptDelivered` and the inherited-context trio (dropping
  `inheritedParentContext` makes the parent read its own pre-handoff commentary
  back as the worker's answer). The guard against the next omission is
  **type-level**: every SessionMeta key named like a relationship must be carried
  or listed as deliberately dropped, or `tsc` fails.

  **#1088 (#867) reworked after review**: `tabIndex={-1}` is half of the
  roving-focus pattern and the PR had shipped only that half. Pin Sessions had no
  `onOpenAutoFocus`, so Radix focused **Cancel** and the first Enter discarded the
  pins; a CLICKED row keeps focus in Chromium whatever its tabindex, so the
  dialog's own Enter bowed out permanently after one click; Space had the same bug
  untouched; and the audit had missed `ConversationsPicker` (Enter on a filter chip
  resumed a conversation) and `AgentActivityModal` (an `opacity-0` per-row button
  was a tab stop, so Delete closed the wrong row). All three lists are now proper
  listboxes with `aria-activedescendant` — taking rows out of the tab order without
  it was an accessibility regression of my own making.

  **#1089 (#827) redesigned after review.** The reviewer showed the 90 s cap (a)
  did not bound the call — the sleep was not clamped, measured 90_010 ms — and
  (b) was derived from a number that **does not exist**: "Claude Code backgrounds
  a tool call at 120 s" is contradicted by the vendored source
  (`DEFAULT_MCP_TOOL_TIMEOUT_MS = 100_000_000`). Worse, 90 s sat **above** the MCP
  SDK's own `DEFAULT_REQUEST_TIMEOUT_MSEC = 60000`, so for any client on defaults
  the cap turned an occasional loss into a guaranteed one. The cap is now **30 s**
  — this repo's existing bound for the same class of problem — the sleep is
  clamped, and `waitCappedMs` became `remainingMs` computed from real elapsed
  time. The real mechanism (SSE replies with no event store and no keep-alive, so
  a dropped connection loses the reply permanently) is filed as **#1091**.

  **#1092 (new)**: `processLock.test.ts > refuses while the window is open` failed
  CI on #1088 and #1090, neither of which touches locking. It is the only case in
  that file that starts the acquisition **before** awaiting the incumbent write,
  so two filesystem writes race and the winner decides the assertion. Reproduced
  deterministically on `origin/main` by delaying the owner write one macrotask.
  A main-branch flake, not a rerun candidate.

  **Method note worth keeping**: three of my own tests this session passed on
  broken code — an overshoot case whose poll interval divided the cap evenly, an
  elapsed-time case that read the clock after `advanceTimersByTimeAsync`, and a
  focus case where `fireEvent.click` never moved focus. Each is documented in
  place. A mutation table is a claim about the test suite, not about the code.

- 2026-09-20 16:35Z — **Nine merged this session. #1084/#1085/#1086 in; #901, #839, #826, #880, #875 closed.**

  **MERGED**: **#1084** (#901 + #839), **#1085** (#826 + #880), **#1086** (#875).
  All three after a review that found something the PR had got wrong.

  **Verified the thing #901 actually reported**: the image-attachment suite that
  failed on main in this checkout now passes (34 tests). The local deterministic
  gate is unblocked, which was the whole point.

  **#1086's review was the sharpest on evidence.** The PR body claimed "11 tests
  red"; the real number is **5**, because 6 of the new tests pass against the
  buggy code — a parser that never succeeds satisfies every "does NOT settle"
  case vacuously. And the "fixture was the accomplice" story was backwards:
  `exited: false` was never READ by anything, because the old suite never ran
  settled/attention on an agent target. What was missing was tests. The body is
  rewritten. Also fixed there: the rebuilt fixture STILL carried an impossible
  value (`process: 'running'` is not a `ProcessStatus`), so the three status
  fields are closed `z.enum`s now; a backend that FAILED TO START raised
  neither predicate and timed out silently; and the throw applied to
  `until: 'change'`, the one mode that always worked.

  **OPENED**:
  - **#1088** (#867): three list dialogs let Enter on a focused Cancel apply the
    change being abandoned — a view-mode override, a tab reorder, an unpinning.
    `focusedControlOwnsEnter` on each, rows out of the tab order (Space clicks
    the FOCUSED control, which Enter handling cannot cover). Reorder Tabs'
    per-row Move buttons stay focusable because they NAME their target.
  - **#1089** (#827): `orchestration_wait_agents` could wait 600 s; a harness
    backgrounds a foreground MCP call at 120 s, drops the transport, and the
    reply is LOST while the children are fine. One call waits at most 90 s and
    reports `waitCappedMs` so the caller calls again. A cap, not a lower schema
    bound — the number the caller passes is what it wants in TOTAL.

  **In review**: #1087 (#863), #1088, #1089.

- 2026-09-20 16:20Z — **#1083 merged (closes #895). Four PRs in their review round.**

  **MERGED**: **#1083** — and it shipped a REDESIGN, not the reviewed change.
  See the previous entry; the reviewer's parenthetical named the mechanism
  already in the codebase (`session:resync-routing` re-emits main's cached
  snapshot on the ordinary event channel) and that removed five of seven
  findings instead of fixing them.

  **Every review this round found something real, and the same class four
  times.** Recorded as a memory (feedback_mutation_claims_are_about_tests):
  - a mutation table is a claim about the TEST SUITE, not the code — reviewers
    ran 17–25 mutations against these PRs and found 5–7 survivors EVERY time,
    against my own "no survivors";
  - "equivalent mutant" written into a comment was WRONG three times out of
    four;
  - a stand-in that refuses everything cannot prove a guard that only matters
    when something gets through;
  - `expect(problems).toEqual([])` is also what a check that stopped checking
    says — #1084's control was satisfied by an EMPTY corpus, and a loader
    finding nothing kept the unit suite green while SILENCING the live suite
    about three genuinely missing sessions;
  - #1086's body claimed "11 tests red"; the real number was 5, because 6 of
    the new tests passed vacuously against the buggy code.

  **#1084** (#901 + #839) reworked: corpus size pinned, census rows checked
  against the committed census (repo-deterministic provenance that never had to
  move to the live suite), the citation line matched as digits, the corpus
  match at segment granularity and separator-agnostic, the decomposition doc
  corrected — including that its OWN recorded pre-push standard ("run the suite
  under a HOME with no corpora") was skipped, which is what cost the CI failure.

  **#1085** (#826 + #880) reworked: #880's acceptance says "in BOTH places" and
  neither call site was tested — `if (true) count += 1` passed 318 tests. The
  count is an exported selector now. "ONE owner" was false: the composer's Stop
  button kept its own copy with a comment pointing at the rule it had
  duplicated. The sweep covers all FOUR atomic-save writers (two clean up only
  in a `catch`, AiWorkspaceRegistry not at all), and `writerIsAlive` now says
  why it does NOT reuse `processLock.isPidRunning` — the two want opposite
  defaults because they fail in opposite directions.

  **#1086** (#875) reworked: the three status fields are closed `z.enum`s (the
  rebuilt fixture STILL carried `process: 'running'`, which is not a
  `ProcessStatus`), a backend that FAILED TO START now raises attention instead
  of timing out silently, the throw is scoped away from `until: 'change'` — the
  one mode that always worked — and carries the zod issues.

  **OPENED — #1087** (#863): a Grid row stayed bound to a closed project, so
  its index went blank and New Agent from its empty lane failed with no toast
  and an overlay that only Escape closed. The scrub moved from the persistence
  boundary into `workspaceWithoutSessions`. A mutation showed my first guard
  silently suppressed the helper's SECOND prune (`expandedParents`), so it runs
  on every commit.

  **In review**: #1084, #1085, #1086, #1087.

- 2026-09-20 15:55Z — **#910 CLOSED. All four items merged; five PRs open.**

  **MERGED**: **oth#5** (item 1) and **#1082** (item 4, plus the submodule bump).
  #910 is closed with a table of what shipped and what each review caught.

  **The lesson of this round, four times over**: every one of these changes was
  wrong in a way only an adversarial reviewer found, and three of the four were
  wrong in the SAME shape — I had written an "equivalent mutant" or a safety
  argument into a comment, and the argument did not hold.
  - oth#5: `OpencodeStore.read` opens a DEFERRED transaction, so a
    statement-free settle never meets the lock. **The thrown `refuseReads`
    stand-in cannot express that finding — only a real `BEGIN EXCLUSIVE` can.**
    A stand-in that refuses everything cannot prove a guard that only matters
    when something gets through.
  - #1082: "promise continuations drain first" is true and irrelevant — a timer
    callback runs in the TIMERS phase, ahead of the CHECK phase where
    `setImmediate` resumes. The facade counts lease holders now.
  - #1081: the item-2 fix recreated item 3 from the other side.
  - A surviving mutant is a claim about the TEST SUITE, never about the code.

  **#1083 (#895) REDESIGNED after review, not patched.** The reviewer proved
  the ordering rule could not be made right — `ts` is `Date.now()` at 1 ms and
  the compared snapshots are two entries of ONE sequence, so a tie is
  unordered, and OpenCode emits several per millisecond with no dedupe latch.
  The tie rule **put an answered prompt back on screen**, where a keypress
  writes into a live agent's composer.

  The fix was already in the codebase: `session:resync-routing` re-emits main's
  cached snapshot on the ORDINARY event channel, which needs no ordering key
  because main updates its cache before forwarding. New
  `session:reseed-conditions` does the same for adoption / cold restore /
  wake, asked for by the renderer once its runtimes exist. That REMOVED five of
  the seven findings rather than fixing them. Also fixed: the adoption seed
  clobbered an exit observed mid-fetch, and the live conditions handler — the
  projection's only call site — had zero coverage.

  **OPENED**:
  - **#1084** (#901 + #839, one bug reported twice): image-fixture provenance
    split into a repo-only check and an opt-in live one. **CI caught a real
    defect in my own control** — it matched `CORPUS_ROOTS`, which embed
    `homedir()`, so the live check skipped every citation on any machine but
    mine and would have passed vacuously forever. It matches provider
    directory SEGMENTS now.
  - **#1085** (#826 + #880): sweep `workspace.json.<pid>.*.tmp` whose writer is
    dead (80 had accumulated in one profile); and one owner for "is this
    session working", since `undefined !== 'idle'` counted a runtime-less
    session as running.
  - **#1086** (#875): `observations.wait` never settled because the consumer
    re-declared the producer's status schema with `exited: z.boolean()`. The
    SHARED FIXTURE was the accomplice — it hand-built `exited: false`, a value
    the producer cannot emit, so the suite agreed with the bug. Rebuilding it
    alone turns 11 tests red.

  **In review**: #1084, #1085, #1086. #1083 answered, awaiting CI.

- 2026-09-20 15:20Z — **#1080 and #1081 merged. Two review blockers found and fixed.**

  **MERGED**: **#1080** (#915, one last-active derivation — closes #915) and
  **#1081** (#910 items 2/3). Both after a full round; the reply on each PR
  answers every finding point by point.

  **#1081's reviewer found a regression I introduced** (high): item 2's prefix
  flush changed which row lands at `merged[0]`, and the cursor rule did not
  follow — so the pagination marker named a row the pane holds in the MIDDLE,
  and the next older page prepended above a row that precedes it. Permanently,
  because uuid dedup fixes the order. **The fix to item 2 recreated item 3 from
  the other side.** `placeHistoryEntries` now returns `keptWindowHead`,
  observed rather than inferred, which subsumes both old signals. It also
  refuted my "equivalent mutant" claim about `index < next` (skipping a stale
  anchor lets the scan CONTINUE to one that flushes) and showed the item-2 rule
  was a guess: the window can hold a row the chunk skips on EITHER side of the
  fresh one, so the flush is now bounded by TIME as well as by the anchor.

  **oth#5 (item 1) reworked after review** — the change had made its own target
  worse. The stuck list was rebuilt every attempt, so a flush that deferred on
  attempt 1 followed by a `failed` drain on attempt 2 reported
  `{complete: true}` with the prompt gone, where the PRE-PR code reported it
  correctly. Each step now carries `pending`/`owed`/`settled`. Also: the frozen
  degraded partial could contradict a completion row that landed mid-window
  (orchestration reads `turn_completed.fullText`), and my "equivalent mutant"
  claim about the drain-first guard was FALSE — `OpencodeStore.read` opens a
  DEFERRED transaction, so a statement-free settle never meets the lock,
  reports complete and latches itself off. **The thrown `refuseReads`
  stand-in cannot express that finding at all; only a real `BEGIN EXCLUSIVE`
  can.** 314 tests, 10 mutations, no survivors.

  **#1082 (item 4) reworked after review** — blocker: the macrotask release was
  a rationalisation. `AgentTranscriptReader.transcriptRecords` walks a session
  page by page and yields with `setImmediate`, so it DOES hold the handle
  across awaits — and a timer callback runs in the TIMERS phase, ahead of the
  CHECK phase where `setImmediate` resumes. The facade now **counts lease
  holders**: `lease()` for callers that hold across awaits, `store()` unchanged
  for synchronous ones. Also fixed: a failed stat at open time wedged
  revalidation off for the process lifetime, the identity was observed AFTER
  the open (recording the NEW identity against the OLD inode, unrecoverable),
  and a working handle was released before the reopen was known to succeed.
  12 mutations, no survivors.

  **OPENED — #1083 (#895)**: a permission or question pending when a window
  closes vanished from the adopting window. Three seeding sites had the same
  hole (adoption, cold rehydrate, waking a parked session); `conditions` now
  rides the backend snapshot, a live-channel snapshot wins on `ts`, and the
  seed uses the same projection as the live channel so the composer picker
  cannot disagree. The main-side test matters most: every renderer test seeds
  a STUBBED snapshot, so a production snapshot omitting the field would leave
  them all green.

  **Lesson worth keeping**: three separate reviews this round refuted an
  "equivalent mutant" claim I had written into a comment. Two were wrong. The
  rule to apply: a surviving mutant is a claim about the TEST SUITE, never
  about the code — and a stand-in that refuses everything cannot prove a guard
  that only matters when something gets through.

  **In review**: oth#5, #1082, #1083.

- 2026-09-20 14:40Z — **#1079 merged; #1080 review round done; #910 items 1 and 4 opened.**

  **MERGED**: **#1079** (`fix/dictation-retain`, Refs #916) — hidden-pane dictation.
  Six review findings fixed first, the worst being that the `activeRef` guard
  defeated the case #916 names first and stranded a live microphone.

  **#1080** (#915, one last-active derivation) — the adversarial reviewer returned
  REQUEST CHANGES with nine sections; all nine addressed in `13c022e6`, and the
  reply on the PR answers each one:
  - **HIGH**: `lastActivitySource` silently flipped `transcript` → `runtime`, and the
    PR's own test PINNED the wrong label. The bridge sees one number and can only say
    where it arrived from, so the SOURCE now travels with the value —
    `sessionActivity` returns `{active, timestamp, source}`, the descriptor carries
    `lastActiveSource`, a tie goes to `transcript`.
  - **HIGH**: "kept because an existing caller may read them" was false — the
    descriptor is renderer-private and nothing read `transcriptActivityAt` /
    `runtimeActivityAt` once the bridge stopped recombining them. Both deleted, along
    with `latestVisibleTimestamp` (the inventory's superseded text-only tail scan).
  - The regression fixture was shaped like no entry that exists (`{type:'tool_use'}`
    is not an entry type), so it passed without reproducing anything. Replaced with
    the two REAL shapes; the `tool_result`-only user row — 20 of the 24 no-visible-text
    tails in 500 transcripts — was missing entirely.
  - Reachability is now a TEST against the real reducer (older-history paging leaves
    `lastJsonlEntryAt` null while populating `entries`), not prose.
  - Four false WHY claims corrected in place, each saying what it used to say.
  - All **seven** surviving mutants killed, plus two more.
  - `CloseOldAgentsModal`'s comment no longer tells the next reader that #915 is open.

  **OPENED — #910's remaining items**, both fail-first and mutation-tested:
  - **opencode-terminal-headless#5** (item 1): the exit drain is three transactions
    and only the first retried, so a lock between the drain and the pending-user
    flush lost the user's last prompt while reporting a 2 s wait that never happened.
    All three now share the one bounded window, each retried only while it is the one
    deferring; `detail` names the stuck step and the real elapsed time. The system
    test takes a REAL `BEGIN EXCLUSIVE` in that gap with a positive control proving
    the lock landed after the drain. One stated equivalent mutant (the drain-first
    guard), documented in place.
  - **#1082** (item 4): the host never reached the package's database-generation
    selection — it cached the handle for the process lifetime, so a replaced
    `opencode.db` was read from the unlinked inode until restart. Bounded 5 s
    revalidation; a stat FAILURE keeps the handle; the superseded handle is released
    on a macrotask (promise continuations are microtasks and all drain first).
    Relocation stays out of scope, because `resolveOpencodeDbPath` memoises for the
    process lifetime by design.

  **Environment note worth keeping**: `.worktrees/last-active` reproduces a vitest
  module-resolution failure (`Cannot find module '<root>/string_decoder'` and
  `'<root>/stream'`) that the SAME commit does not show in three other checkouts of
  byte-identical content. Verification for #1080 was done in a clean worktree:
  350 files / 2510 tests. If a worktree starts failing to LOAD suites, copy the diff
  to a fresh one before believing it.

  **In review**: #1081 (#910 items 2/3), oth#5, #1082.

- 2026-09-20 13:45Z — **eight merged. #1074 and #1077 in; #1078/#1079/#1080 open.**

  **MERGED**: **#1074** (control drain, Refs #943) and **#1077** (orchestration
  timeout, #926 REOPENED — see below).

  **#926 AND #928 BOTH REOPENED, and the mechanism is worth remembering:** a
  `Fixes #N` trailer in ANY commit on the branch closes the issue on merge,
  even when the final commit and the PR body say `Refs`. Both PRs had been
  NARROWED by review so only part of each issue shipped. Now in memory: when a
  round narrows scope, rewrite the trailer in the FIRST commit.

  **#1077 was cut down to a third of itself and is better for it.** Its retry
  guard keyed on the renderer request shape, which has NO PROMPT FIELD — so two
  different fan-out jobs shared a key and the second was refused forever, the
  same catastrophe #1069 fixed, one layer down. Nothing could clear a
  reservation either: the reviewer drove a parent through list-agents and
  close-run and it still looped on a refusal that told it to list its agents.
  What shipped is the sound half: `sendToWindow` REPORTS DELIVERY, so a request
  a closing window never received fails immediately as safe to retry.

  **#1074's reviewer found `dispose()` destroyed the registry BEFORE draining**,
  and the admission gate resolves declared effects against that registry — so
  during the drain everything was refused, reads and `operations.*` included,
  and three of my own WHY comments were false. Also: `completion:'accepted'`
  operations were never drained (every `agents.prompt`, `commands.run`,
  `workflows.start`), and the drain was unbounded while holding the exit AND
  the state-process lock. All fixed; the drain is now bounded at 10 s and
  journals `control.drain_incomplete`.

  **OPEN**
  - **#1078** (#921 LSP generation) — round done. Its reviewer proved the PR's
    CENTRAL CLAIM FALSE: `generation: key` at the call site reinstated the bug
    with all 1243 main-process tests green, because only the exported
    function's BODY was pinned, not its one call site. Now driven through the
    real `createServer` with `spawn` faked as a pair of pipes and a real
    vscode-jsonrpc peer answering `initialize`.
  - **#1079** (#916 dictation) — reviewer already reports "a PTY write after
    unmount", which is the terminal-sink case I flagged as least certain.
  - **#1080** (#915 last-active) — one `sessionActivity` rule shared by the
    TLDR footer and the agent_management inventory. The main bridge had to
    change too, which the issue does not mention: it recombined the raw fields
    itself, so publishing a unified field without touching it would have left
    the divergence where it mattered.

  **NEXT**: land those three, then #910, #901, #896, #895, #894 and down.
  Still unstarted and owner-gated: T14 (Agent Activity redesign), #944
  (always-on performance monitoring).

- 2026-09-20 13:05Z — **sweep continues: six merged, four in review.**

  **MERGED since the last entry**: **#1073** (#929, rewind attachments) and
  **#1076** (#928, atomic transcript publication), plus
  **agent-transcript-parser#35**.

  **#1076 REOPENED #928 deliberately.** The atomic/no-clobber half shipped;
  the recovery receipt did not, because every entry point mints a fresh
  `randomUUID()` before projecting, so a retry yields a NEW filename and the
  `already-published` path has no caller that can reach it. Closing it needs a
  stable retry identity threaded from whatever would retry, and there is no
  retry wrapper between the IPC handler and the writer to hang one on.

  **OPEN, round done, fixes pushed**: **#1074** (#943 control drain),
  **#1077** (#926 orchestration timeout), **#1078** (#921 LSP generation,
  reviewer still running).

  **THE REVIEWS ARE DOING THE HEAVY LIFTING, and two were near-catastrophes:**
  - **#1077** was REJECTED DOWN TO A THIRD OF ITSELF and is better for it. Its
    retry guard keyed on the renderer request shape — which has NO PROMPT
    FIELD, because the prompt is delivered separately — so two different
    fan-out jobs shared a key and the second was refused FOREVER. Same
    catastrophe #1069 fixed, reintroduced one layer down. Worse, nothing could
    clear a reservation: the reviewer drove a parent through list-agents and
    close-run and it still looped on the same refusal, which told it to list
    its agents. Guard deleted; what survives is the genuinely true half —
    `sendToWindow` now REPORTS DELIVERY, so an undelivered request fails
    immediately as safe to retry (`windowForSession` ignores `closing` while
    delivery skips it). The "orphan" justification was also disproven:
    visibility is decided in the RENDERER from session metadata.
  - **#1074**'s `dispose()` destroyed the registry BEFORE draining, and the
    gate resolves declared effects against that registry — so during the drain
    EVERYTHING was refused, including reads and `operations.*` ("No owner").
    Three of my own WHY comments were false. Also found: `completion:'accepted'`
    operations were not drained at all (every `agents.prompt`, `commands.run`,
    `workflows.start`), and the drain was unbounded while holding the exit AND
    the state-process lock.
  - **#1076**'s reviewer built a REAL FAT32 VOLUME and measured `link` →
    ENOTSUP, proving the PR regressed external drives, which `CODEX_HOME` can
    point at. Also measured a 577 MB RSS spike from the whole-file identity
    compare on a real 325 MB rollout.

  **TWO TRAPS WORTH REMEMBERING** (both now in memory):
  - `npm install --package-lock-only` after a SOURCE-ONLY submodule bump
    deleted 474 lines of per-platform esbuild entries and broke the Node 22
    fixture gate. Only resync when the submodule's own package.json changes.
  - `npx tsc -b` does NOT cover `src/control-sdk` the way CI does — it is
    platform-neutral with no timer in its lib. A `setTimeout` there passed
    locally and failed CI. Run `npx tsc -p tsconfig.control-sdk.json --noEmit`.

  **FILED**: #1075 (rewind never tells the user an attachment was lost).

  **NEXT**: merge #1074/#1077/#1078 on green, then #925 (pending-read dedupe),
  #924/#923/#922 (the remaining LSP ordering trio), #919, #918.

- 2026-09-20 11:55Z — **issue sweep: four merged, two in review, two filed.**
  Reviewers are CLAUDE orchestration children from 2026-09-20 (owner reversed
  the earlier Codex call). One reviewer per PR, one round, fix, merge on green.

  **MERGED**
  - **#1068** (`fd5af...`) — an OpenCode question modal was reject-only, so a
    user could read "red or blue?" and not answer it. Closes **#1025**. Round
    found three blockers, all one bug seen from two sides: a question can be
    REPLACED mid-answer, and the view kept the previous question's selection
    (same component instance — the outlet keys on `condition.kind`) while the
    runtime validated against the LIVE question and replied to the PAYLOAD's,
    then deleted the modal unconditionally.
  - **#1069** (`5e3ac419`) — duplicate `orchestration_create_agent`. Closes
    **#952**. The round caught a regression *worse than the bug*: keyed on the
    child's shape with the prompt excluded, a concurrent FAN-OUT of N workers
    differing only by prompt collapsed to one child and N-1 tasks were silently
    never run. `MAX_ACTIVE_RENDERER_REQUESTS = 1` makes a burst overlap by
    construction, so a fan-out was the MOST exposed shape. Now the whole TOOL
    CALL is the unit, keyed on every argument including the prompt, deduped on
    `OrchestrationBridge` because `BuiltInMcpHttpHost` builds a fresh server
    per POST.
  - **#1071** (`04990cac`) — Claude wrapper provenance. Closes **#930**. Round
    caught a second regression: I anchored on `<command-name>` after reading
    `processBashCommand.tsx`, and never found `formatSlashCommandLoadingMetadata`,
    which opens with `<command-message>` — **136 real turns against 105**, so
    every `/loop` and `/simplify` row in the picker would have become raw XML.
    Also: the never-strip-to-nothing guard was resurrecting 87 real
    `<local-command-stdout>` turns, which are provider OUTPUT, not prompts.
  - **#1072** (`4f5c4a03`) — the state lock. **#993 STAYS OPEN** (see below).
    Round showed my first fix protected only incumbents younger than five
    minutes, because the grace window is measured from the lock's `startedAt`
    — the incumbent's UPTIME — and every reason for an argv0 mismatch is
    permanent. Replaced the heuristic with the kernel: `ps -o lstart=` against
    the lock's `startedAt`. A process cannot have started AFTER the lock its
    own acquisition wrote, so later = a reused pid, at-or-before = the genuine
    owner at any age.

  **OPEN, round done, findings fixed**
  - **#1073** (#929, rewind attachments). Blocked on
    **agent-transcript-parser#35**: the round found my extractor was a THIRD
    copy of the data-URL rule that CONTRADICTED the parser's own projector —
    same bytes, same rewind, one produced an image in the transcript while the
    other told the picker the attachment was unavailable. Fixed by exporting
    `parseBase64DataUrl` from the parser and adopting its precedence. The
    submodule pointer currently references the branch commit, and
    `minimum-node-fixture-gate` is RED because of it; a review of #35 is
    running, then merge #35, re-bump the pointer to `main`, then #1073.
  - **#1074** (#943, control drain). `createControlHost.dispose()` was
    synchronous and joined nothing, so the exit and the state-process lock were
    released while an admitted mutation was in flight and its durable result
    was still queued. Reviewer running.

  **FILED** — **#1070** (a refused condition action is completely invisible;
  pre-existing shared `conditions-core`), **#1075** (rewind never tells the
  user an attachment could not be restored; the report now crosses IPC but no
  consumer reads it).

  **THE TECHNIQUE THAT FOUND ALL OF THIS**, worth keeping: every brief tells
  the reviewer to *mutate the implementation itself and report which mutations
  SURVIVE*. Four for four, that instruction produced the blocking finding —
  three of them regressions I had just introduced. A reviewer that only reads
  the diff finds far less. Second-best instruction: *count the real corpus
  rather than reasoning about it* (`~/.claude/projects/**/*.jsonl`, 1941 files;
  `~/.codex/sessions/**/rollout-*.jsonl`, 2146 files).

  **NEXT**: merge #35 → re-bump → #1073; #1074 on its round; then **#944**
  (always-on performance monitoring — large, and its acceptance needs owner
  product calls) and **#934** (extensions deferred items). T14 is still blocked
  on two owner product calls.

- 2026-09-20 09:45Z — **v0.1.0 IS PUBLISHED.** Signed, notarized, both
  architectures, `releases/latest` returns it, and the landing page's download
  buttons + status line resolve to the real DMGs (verified in a browser, not
  inferred). Stage 8 is done except the two OWNER items (hero screenshot,
  Cloudflare connect/domain) and the pre-Nord README screenshots.
  - **Merged since:** #1060 (paste envelope shown/replayed), #1061 (#959
    extension ledger quarantine), #1062 (the release cut), #1063 (#1031 item 2,
    goal-loop chip on the index), #1064 (#1031 item 3, dictation stays in the
    focused lane). #1031 was REOPENED: GitHub closed it off "Closes #1031 item
    3" while items 1 and 4 were still outstanding.
  - **Open:** #1065 (#1031 item 4, phone v3 coverage), #1067 (#1066, the
    hold-peek fix), #1068 (#1025, answering OpenCode questions). All reviewed
    except #1068, whose review is running.
  - **THE REVIEWS EARNED THEIR KEEP THREE TIMES, and twice the bug was MINE:**
    - #1061: with a quarantined row and a RUNNING extension sharing an id, one
      Remove click uninstalled the working extension and `rm -rf`'d its bundle.
      Also: the sweep's bundle protection had no test at all (deleting it left
      206 tests green), and was keyed on parsing the very field that failed to
      parse.
    - #1067: my first fix was **worse than the bug**. Latching the peek
      re-created the #1021 input trap — an overlay owning every keystroke but
      Escape, on exactly the machines the fix targets. The way out was that
      only the Cmd-LETTER keyup is swallowed; the COMMAND keyup still arrives,
      so the peek can just keep holding. Plus a toast (the half of the
      `dictation.hotkey.unavailable` precedent I had copied from), plus
      corroborating the permission with `isTrustedAccessibilityClient` instead
      of inferring it from a 20 ms probe.
    - #1065: **my central claim was false.** `agentActivity` already covers v3;
      I had run the mutation only against `src/main/remote/` and generalised.
      Corrected in the header, README, commit and PR. The review also found
      `tldrIdentity` — the phone's join key — unpinned across all 74 remote
      tests, and that `drafts` persists raw composer text (clean here by
      timing, not by process).
  - **Two standing rules, unchanged from the owner:** ONE review round per PR
    then merge on green; reviewers are CLAUDE orchestration children, never
    Codex. (The loop prompt still says Codex; the owner's later instruction
    wins.)
  - **#1025 built (#1068):** the modal can answer, not only reject. The
    options were in `metadata` all along — `foldQuestion`'s comment saying
    otherwise was stale. Wire confirmed against the SHIPPED 1.18.31 binary.
    Self-review caught that a no-options question posted `['']`, which the
    validator refused, making such a prompt unanswerable.
- 2026-09-20 07:15Z — **#1049, #1056, #1057 and #1058 MERGED.** Release 0.1.0 is
  staged and blocked only on #1060.
  - **Two standing rules changed, on the owner's word.** (1) **ONE review round
    per PR**, then merge on green — "do not fucking do 10 rounds, that is just
    crazy, just merge it after one review round so that we can get somewhere".
    #1049 took ten rounds; the marginal findings were not worth the stall.
    Anything a second round would have caught becomes a follow-up issue.
    (2) **Reviewers are CLAUDE orchestration children, never Codex.** Both are in
    auto-memory (feedback_one_review_round, feedback_pr_review_template).
  - **#1058** (new, #1030 item 4): closing a terminal deliberately leaves its tmux
    session alive for Undo Close, and NOTHING ever killed it — `killSession` had
    two callers, failed-spawn rollback and startup reconcile. A five-minute sweep
    now reaps a session absent from BOTH authorities (the persisted workspace file,
    decoded by the same function startup uses, and main's live registry) for longer
    than the undo window plus a grace. The review found three real kill races and
    all three are fixed: an undo-then-close between sweeps kept the ORIGINAL
    deadline; every authority was a snapshot taken before an await; and `stop()`
    only cleared the interval, so a run awaiting tmux could still kill during quit.
  - **#1059/#1060** (new, from the owner's screenshot): #1053 taught prompt
    ACCEPTANCE about Claude's `<pasted_content id="…">` envelope and nothing else.
    Every surface that SHOWS or REPLAYS a prompt still had it — the feed painted
    `❯ <pasted_content id="cade"> …`, and ⌘↑ replayed the envelope into the
    composer, where sending it again made Claude wrap the already-wrapped text.
    **The review earned its keep:** two of the surfaces the PR claimed fixed were
    not. View Prompts and the conversations picker read from the CATALOG
    unwrapper, whose closed wrapper list never learned the envelope — so the
    prompt was DROPPED, not shown wrapped, and a session of pasted prompts read
    "No visible user prompts found" while the feed above showed them. Rewind's
    draft feeds both the picker row and the composer prefill, so it RE-SENT the
    envelope. Fixed at both, plus the queue strip routed through the capability.
  - **Landing page verified: no code change needed** (see Stage 8). `releases/latest`
    404s today because no non-prerelease release exists; publishing the stable flips
    the buttons and the status line on its own.
- 2026-09-20 06:00Z — **#1050 MERGED** (`15183819`) and **claude-code-headless#61 MERGED** (`93f5a54`). Open: #1049 (round 7), #1056 (round 5 fix pushed), #1057 (the #1040 app half, round 1 fix pushed).
  - **#1049's seventh round produced the thing this PR needed most: a full inventory.** Rounds 3–6 each found more surfaces because I was patching reactively; the reviewer has now enumerated every renderer dialog, strip, picker and action row AND every main-process dialog call site, marking each escaped / fixed / partial. Ten more surfaces came out of it — the explorer's own two-click delete (which never reaches the escaped dialog when the file is clean), the editor conflict strip's Overwrite/Reload (identified only by its tab), AI Workspace clear/delete, extension Reload/Update/Remove (tier-0 skips the native consent dialog entirely), remote device Revoke, the generated skill/conventions previews read before Save & Enable, the directory picker (choosing a cwd IS the Codex trust decision), rewind's interactive prompt list, goal-loop and workflow continuation controls, and the local template/theme/tab/pin pickers. That inventory is the artefact to keep: it is in the PR thread and the scratchpad.
  - **#1057** review found that the fold dropped the new `transport-error` interruption, so a stream that died mid-answer left an unexplained half-response on desktop AND phone. The feed now paints "Interrupted before the response finished", and #1040's KNOWN LIMIT comment and test in the goal loop are retired with the limit itself.
  - **#1056** round 4–5: the two-clock problem is fixed at the source — the `session-list` frame carries the sender's clock and the phone converts on arrival — with the wider tolerance kept for a desktop too old to send one.
- 2026-09-20 05:30Z — **#1054 and #1051 MERGED** (`3ca516a3`, `8205e6f5`). Four PRs remain in review (#1049, #1050, #1056 in this repo; claude-code-headless #61), each on its fourth to eighth round. Draft release notes for 0.1.0 are written (`docs/decomposition/release-0.1.0-notes.md`), with the in-flight work marked PENDING and the known gaps stated. Stage 8's workflow item was already done by #1035.
  - **#1050 rounds 7–8 changed the shape of the answer, not the classification.** Excluding `stream_phase` from "progress" caught Claude's sidecar churn and simultaneously threw away the only working signal Grok and OpenCode Terminal publish — the SAME event type means bookkeeping on one provider and work on another, so no type-based rule can separate them. The hold now has two deadlines instead: thirty minutes of silence (a dispatched tool with a live process is exempt) and an absolute two hours that nothing is exempt from.
  - **#1056 rounds 3–4**: recovery from a fast phone clock could not depend on a list publication (the refresh compared signed elapsed time, which a future stamp never satisfies), and a QUIET row has no event to retire its stamp at all — so the ordering itself now distrusts a gross overshoot.
  - **claude-code-headless #61 rounds 2–4**: the error hook leaked URLs for hosts we do not proxy (gated); a completed turn's `awaiting-tool` was being cleared by a late socket death (preserved); the attribution was a guess — mitmproxy says `Client disconnected.` for its OWN inactivity timeout, proven with `tcp_timeout=1` (now one neutral `transport-error`); and a sleep-severed stream reported by the transport first lost its "Interrupted while asleep" (the adapter takes the suspension instant directly now).
- 2026-09-20 05:05Z — rounds 4 and 5, and #1040 fixed at its source:
  - **#1053 MERGED** (`f3934fce`) — the pasted-content acceptance fix is on main. **#1048 MERGED** (`46a257f0`). **agent-transcript-parser#34 MERGED**; #1051's submodule pointer now sits on parser main.
  - **#1051 APPROVED** after two more rounds. Round 2 found the selection could cross session identities (the row read is async; the default destination had become a different session, and OpenCode persists what a prompt selects onto that row) and that "never a subset" was documented but not enforced. Destination is now pinned with the selection, and all four fields are required or none are sent. The reviewer re-verified against live 1.18.30 AND 1.18.31 binaries with `noReply`.
  - **#1050 rounds 4 and 5**: six more findings, every one reproduced. A queued continuation released by a SUBAGENT phase edge (the #1024 false positive, in the one place I had reintroduced it); a stale queue latch surviving the stall pause so Resume could never recover; a streamed answer reading as silence (the reducer collapses deltas, so only state CHANGES counted as progress); one clock doing two jobs, which let turn metadata renew the screen grace forever; and finally `flow_selected`/`flow_ignored` — diagnostics about OTHER flows — keeping a stale hold alive for two simulated hours.
  - **#1049 rounds 3 and 4**: thirteen surfaces, then two more in the skill review (a repository's own default branch name, and warnings that name the file they warn about).
  - **#1056 round 1**: the server's list frame replaced the client's recency stamp unconditionally, so a projection change moved rows backwards in time — two reversals inside 300 ms — and reset the very stamp the rate limit measures from. Recency is now monotone per session. The reviewer also proved the tests passed with every screen frame DISCARDED; they now wait for receipt and cover both halves (a stale stamp must still refresh).
  - **#1040 FIXED AT SOURCE — claude-code-headless#61.** mitmproxy reports a client disconnect only through its `error` hook, which the addon never implemented, so an Esc mid-stream left the flow open holding its phase: a pane stuck on `Thinking`, and a goal loop with no idle edge to resume from (a limit this repo had pinned in its own tests). The addon now emits `response-error` and the adapter seals the flow with `interruption: 'client-disconnected'`.
  - **Lesson recorded in memory:** every round found at least one test that passed with its fix removed. Mutation-test each regression test, and synchronise on state the fix writes rather than on a sleep.
- 2026-09-20 04:20Z — rounds 2 and 3 closed; two owner-reported bugs root-caused and fixed:
  - **#1048 MERGED** (`46a257f0`) after round-3 APPROVE. The recovery mint is now restricted to memberships that can actually be re-homed (`projectId === null`); a hybrid file (`projects: []` beside stale v2 tabs) was minting an empty phantom project and, worse, hiding the file from bootstrap's empty-workspace fallback.
  - **#1053 (#1052) APPROVED** at round 2. Round 1 found two defects: the greedy unwrap spanned two SIBLING blocks sharing an id (a string that could be armed and then acknowledged by a different entry), and the envelope silently deleted every pasted prompt from composer history, because `isClaudeTypedUserPrompt` rejects text starting with `<`. The helper now lives in `@shared/claude/pastedContent` so main (did Claude accept this?) and the renderer (did the user type this?) cannot drift.
  - **#1050 round 3**: three more findings, all reproduced by the reviewer. A QUEUED continuation is not a started turn — the running turn's Stop closed our guard while ours sat in the provider's queue, and a second one went out. The "event since Stop" freshness flag is gone; an allowed Stop now drops the tracked phase outright, because a trailing event about finished work was validating the stale seed and stalling the loop to its 30-minute pause. Both deadlines now measure SILENCE, not age, so an agent that keeps working past thirty minutes is no longer paused for it.
  - **#1049 round 3**: the six named gaps were right, and the reviewer's full sweep found thirteen more raw approval surfaces — Root Agent Code Management naming its recipient (P1), Claude's interactive question picker, the editor's delete/close dialogs, the installed-skill install and update review, bulk provider switch, the switch picker, rewind, new-agent, merge, the OpenCode and Grok question bodies, and Claude's resume prompt. All escaped.
  - **#1051 (#1038)**: first review found the fix only half done, both halves reproduced against the 1.18.30 BINARY. OpenCode resolves a submission as `input.model ?? agent.model ?? session model`, so a machine-level `agent.build.model` outranked the conversation's own selection — every prompt now carries agent+model+variant together (never a subset: OpenCode persists what a prompt selects, so a partial one re-homes the session). The other half is **agent-transcript-parser#34**: the imported session ROW omitted the variant, and that row is what a programmatic submission reads. Verified against a live 1.18.31 database, where every row carries one, `"default"` included.
  - **#1054 (#1020) OPENED**: the app icon is on Apple's grid now — the Icon Composer export is full-bleed (opaque 0..1023), which macOS 12–15 draw as-is, ~24% larger than its neighbours. The export is kept byte-for-byte as `build/icon-full-bleed-1024.png`; `build/icon.png` is the padded grid version. Deliberate visual change, flagged for the owner.
  - **#1055/#1056 (T18) OPENED**: the phone remote list. `WebSocketSessionFeed` rebuilt the whole array — restamping `lastActivityAt` — for ANY event naming a listed session, and screen/process-state are broadcast unbatched, so a working agent rebuilt it at frame rate: **60 list notifications for 60 frames** through the real server. Rows sorted with no tiebreak and groups were in Map INSERTION order, so both rows and whole sections jumped. Fixed by rate-limiting the local stamp to the resolution the list sorts at, ending every comparison in the session id, and ordering groups by their most recent work.
- 2026-09-20 03:10Z — round 2 of the Codex review cycle, and one real bug found by looking at why THIS session's own loop died:
  - **#1052 FILED and fixed (PR pending): Claude's `<pasted_content>` envelope breaks prompt-acceptance matching.** Claude Code 2.1.278 commits a pasted prompt wrapped in `\n\n<pasted_content id="cade">\n…\n</pasted_content id="cade">\n` — closing tag repeats the id. `claudeSession.resolvePromptAcceptance` compares the committed text to what we wrote, the envelope is content rather than whitespace, so the waiter starves and the delivery is reported `acceptance-timeout, retrySafe: false` (the harshest branch: `do-not-retry`, no backoff) for a prompt Claude accepted and answered.
    - **This is what killed the release-readiness goal loop at 02:27:16Z**: written at 02:26:56.986Z (2649 bytes + Enter), composer `ready` 781 ms later (Claude had taken it), reported failed 19.9 s after that. The loop paused `error` with `continuationsDelivered: 0` while the agent worked on continuation 1.
    - It hits EVERY long delivery, not just the loop: orchestration `send_prompt`, remote prompts, agent management, ask-user-question answers. Three `orchestration.prompt_delivery_failed` incidents at 02:31 on the same run.
    - Fixture: `testing/fixtures/prompt-acceptance/pasted-content-envelope-2026-09-19.json`, the real transcript entry plus the delivered bytes, verified byte-identical to `buildGoalLoopContinuationPrompt` rebuilt from the persisted loop record — so the envelope is provably the only difference. Fail-first proven by mutation (both positive cases red without the unwrap; both negative cases stay green).
    - Known cosmetic follow-up, not in this PR: nothing in the renderer or the parser strips the envelope, so the feed shows `<pasted_content id="…">` verbatim in user messages.
  - **#1050 rewritten** (`b6a292d5`) after its review found the first fix wrong on all three counts: input readiness is a composer question and is TRUE mid-turn, a skipped continuation was lost for good (no second Stop ever fires), and terminal-runtime UI readiness must not gate a programmatic channel. The gate is now the provider's own `process-state` activity, a blocked continuation is HELD and released by the provider's active→idle edge, and a hold that never clears pauses visibly after 15 minutes.
  - **#1048** (`85e4ff1c`) and **#1049** (`27ae4b36`) fixes pushed; delta re-reviews running alongside #1050's.
  - **#1030**: the unsafe tmux kill I wrote was removed — `kill-session -t agentcode-` matches by prefix, and it killed a foreign session in the reviewer's isolated test. The safe design is written up on the issue.
  - Reviewers are Codex orchestration children from here on (owner's call).
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
- 2026-09-20 20:35Z — **#1100 merged (nine this pass). Three PRs open, all three reviewed and answered.**
  - **MERGED**: #1100 (`fix/rewind-attachment-loss`, closes **#1075**) — rewind now names
    what it could not bring back, per attachment, with the reviewer's finding fixed
    (the first cut printed a false message on 3 of 4 providers).
  - **#1099** (#1070, condition refusals): all EIGHT review findings fixed in `86be41db`.
    The severe one was mine: the control plane swallowed refusals, so a refused
    trust-dialog reply answered `accepted: true` to an agent that then believed a folder
    was trusted. `dispatchCustom` now takes a `rethrow` flag — views report, the control
    plane reports AND rejects. Also: unknown provider reasons no longer return `undefined`
    from the describer (Grok/OpenCode Terminal emit `stale`/`closed`/`no-live-channel`,
    and `PaneToast` renders nothing for an empty message — the providers with the most
    reachable refusal path were still silent); the phone gets all five messages instead of
    one; the AUQ row stopped printing `option-not-found at select-option` at a human.
    The three surviving mutations were real gaps: `TileLeaf.follow`'s test mocks the outlet
    to `() => null`, and the phone dispatch was an inline `useCallback` reachable only by
    mounting the whole session screen. Both now have real tests
    (`TileLeaf.conditionRefusal.renderer.test.tsx`, `remote-client/src/ui/conditionDispatch.ts`).
  - **#1101** (#925, bridge dedup): the reviewer found the implementation clean and 8 of 19
    mutations alive. The finding that mattered: the identity-guarded `.catch` delete is now
    the ONLY thing that removes a pending entry, so a single renderer error poisons that key
    **until the app restarts** — where before #925 prune healed it in 250 ms. Nine mutations
    now killed (`cae83772`), including the whole `readRunOutputs` half, which could have been
    reverted wholesale with the suite green. #925's own measurement criterion shipped as a
    test: 500 polls over 20 keys leave 20 pending entries.
  - **#1096** (#854): was CONFLICTING. Merged `origin/main` in (`d68dc6c2`) — one conflict,
    both sides additive at the same seam (#1089's wait-cap constants vs #854's
    `isNotReadyYet`). tsc clean, mcp+sessionManager 191/191.
  - Process note worth keeping: a batched mutation harness reported a live mutation as dead
    earlier in this series, so every mutation in this pass was applied **individually**
    against a verified-clean tree, with the file restored from a backup between runs.

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
