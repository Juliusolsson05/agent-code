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
- [ ] Fold in the issue/branch triage results
- [ ] Fold in the agent-thread briefs
- [ ] Fold in the goal-loop freeze root cause

### Stage 2: Land the in-flight release PRs
- **Produces:** #1010, #1012 and landing #3 merged, with review findings resolved.
- **Verified by:** CI green on the merge result; the findings table is resolved
  or explicitly deferred with an issue.
- **Why separate:** these are already reviewed; they unblock nightlies and the site.
- **Reality check:** the six 2026-09-19 review reports.
- [ ] **#1010 icon.** Doc fix pushed (`b0754260`). Still to do: correct the PR body
  ("A×" → Nord dragon + `</>` mark), merge `origin/main`, CI green, merge.
  Follow-up #1020 (no margin on macOS 12–15; an owner visual call).
- [ ] **#1012 nightly.** Apply the review fixes:
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
- [ ] **Landing #3 Pages.**
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
- [ ] Root cause recorded in the ledger
- [ ] Fix PR merged

### Stage 4: Release-blocker issues (from the Stage 1 ledger)
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

### Issues
_pending_

### Worktrees / branches
_pending_

### Agent threads
_pending_

### Goal-loop freeze
_pending_

### Progress log
- 2026-09-19 05:25Z: #1019 merged → main green. Reviews of #1010, #1012 and landing #3 done.
