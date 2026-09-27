# Quality loop: make Agent Code feel finished, end to end

> **Status:** RUNNING (goal loop started 2026-09-25). Stage 0 finishing. This file is the
> contract and the living ledger for a long-running goal loop. Branch
> `docs/quality-loop`, worktree `.worktrees/quality-loop`. Update it in the
> same iteration that changes reality (commit and push), and re-read it after
> every context compaction. If it disagrees with GitHub, GitHub wins: re-verify
> and fix this file.
>
> **Decisions:** the owner asked for my recommendation on each and then said
> "start the main loops" (2026-09-25), so the recommended defaults in section 5
> are ACCEPTED. The owner can still change any of them.

---

## 1. Outcome

**Owner, 2026-09-25 (paraphrased faithfully):** the app is good, really good,
but compared with its competitors it does not yet offer a fully thought-through
experience: perfect, clean UI and UX, and no bugs. That is the biggest thing to
fix if we want serious users. Set up a loop that works on a long time horizon,
digs deep for bugs, and resolves every finding, combined with an autonomous
merge pipeline: two Codex agents and one Pi agent review each PR, at most two
rounds, and after that it is safe to merge. The open-issue list is "a fat mess"
that needs a real audit. First, close the loops on the open PRs.

**Observable end state (what "done" means):**

1. Every bug class in section 3 has been hunted twice, and the second sweep
   found nothing new at severity P0 or P1.
2. Every open issue is in exactly one audited state (section 6.2): fixed,
   closed with evidence, or open with a label, a severity and a written reason.
   No unlabeled or untriaged issue remains.
3. Every UI surface in section 6.5 has had its consistency and missing-state
   pass, and the owner's batched visual checklist is answered.
4. `main` is green, and no PR opened by the loop is left undecided.
5. Owner-only items (section 10) are collected in one list and asked once.

The loop never calls `goal_loop_complete` while any of 1–4 still has workable
items. It stops early only for owner items, with outcome `blocked`.

---

## 2. What we said versus what I assumed

| Point | Source |
|---|---|
| Long horizon, deep bug hunting, resolve all findings | owner |
| Autonomous merge after review | owner |
| Reviewers: 2 Codex + 1 Pi, at most 2 rounds | owner (overrides the saved "one round" and "Claude-only reviewers" rules, for this loop) |
| Open issues need a real audit | owner |
| Close out the older open PRs first | owner (Stage 0) |
| The loop runs in this session via `goal_loop_start` | assumed |
| I implement every fix myself; subagents only hunt and review | assumed, from the owner's 2026-09-24 note that delegated implementation is risky |
| Decisions 1–15 in section 5 | proposed defaults, UNCONFIRMED unless marked |

---

## 3. Evidence (verified 2026-09-25, do not re-derive)

### 3.1 The last two months of work

Window 2026-07-24 → 2026-09-25: **299 issues** opened (238 closed, 61 still
open then) and **255 merged PRs** (+414k / −46k lines). Almost all of it landed
between 2026-08-24 and 2026-09-25; late July to mid-August was nearly silent.
By PR title prefix: **123 fix, 77 feat, 19 perf**, the rest docs/test/chore/ci.

Work streams, largest first:

1. Workspace and fleet UX: Dispatch → Grid Dispatch → Unified stage (#1013),
   multi-window, Merge Project Tabs, terminals as sessions (#872), Agent
   Activity (#1105), Agent Analytics, completion stripes, auto-follow, names.
2. Agent meta-layer: TLDR → Goal → Goal Loop, history, hook enforcement.
3. Provider breadth: OpenCode Terminal, Grok, Pi, bundled OpenCode CLI,
   no-CLI onboarding, usage readers.
4. Provider switch and transcripts: quota-independent switch, images, rewind.
5. Control plane: orchestration MCP, external operator SDK, Agent Management
   MCP, user MCP servers, Browser Pocket.
6. Platform: extensions (#577), skills (three rebuilds), key vault, dictation.
7. Performance sprint (2026-09-03 to 09-05, ~30 perf issues), then monitoring.
8. Shipping: signing, nightly and preview channels, self-update, icon.

### 3.2 Bug classes that keep coming back

These are the hunt targets. Issue numbers are examples, not a complete list.

| # | Class | Pattern | Examples |
|---|---|---|---|
| C1 | **Prompt delivery inferred from the terminal screen** | Acceptance is read from TUI text; every CLI UI change or edge case breaks sending | #683 draft blocks sends, #737 Tab accepts suggestion, #705 trust highlight, #709 compaction latch, #702 false timeouts, #1052/#1059 `<pasted_content>`, #1113 wrapped `[Image #N]`; open: #1118, #1119, #711, #877, #675–#678 |
| C2 | **Identity and ownership across reload, replace, restore, wake, second launch** | A pane is not the process; ownership is lost or doubled at transitions | #632/#638/#639/#719 Codex rollout ownership, #706 restored sessions rejected, #690 hibernated, #807/#879/#1090/#895 replacement drops state, #712/#772/#776 readiness kills healthy sessions, #952 double spawn, #993/#1094/#1098 state lock; structural fix is #918 |
| C3 | **Silent failure** | The app knows something failed and does not say | #1070 refused answers, #1075 rewind attachments, #881/#1097 dead OpenCode server, #1018/#879 orchestration false status, #1130 updater, #980 bare 403, #1066 chord |
| C4 | **Global input traps** | A modal, latch or overlay takes all input | #713 (open), #1004, #1021, #1027, #697, #867, #862 |
| C5 | **One bad record takes everything down** | Fail-all instead of quarantine | #959 extension ledger, #1014 and #1133 managed skill (fixed twice), #631 autosave, #1048 corrupt container |
| C6 | **Unbounded growth** | Buffers, logs and ledgers born without a cap | #722 130 MiB feed-debug, #724/#730–#732 ghosts, #743, #676, #804, #726, #735, #747; memory also records the proxy-events OOM and unbounded debug directories |
| C7 | **New-feature bug clusters** | Each feature grows its own bug batch within 1–2 days | Goal Loop #1004/#1021/#1024/#1033/#1138, Browser Pocket #1152–#1155, updates #1129/#1130, TLDR #1027/#1066; #841 repaired a whole merge wave |
| C8 | **Rendering order and duplicates** | The ownership ledger misplaces or doubles units | #868, #738, #855; open evidence issues #643–#646 |
| C9 | **Test hygiene** | Tests tied to personal history or wall-clock time | personal `~/.claude` history fixed six times (#641, #669, #684, #839, #901, #1084); open #700, #1107, #1171, #1009 |

C1 and C2 cause most of the fixes, and their open issues show they are not done.
C3–C6 are habits rather than single subsystems.

### 3.3 The open-issue backlog (profile at 2026-09-25)

- **90 open** before today; **102** after the Stage 0 follow-ups were filed.
- **84 of 90 had no label.** The labels that exist (`bug`, `provider:*`,
  `maintenance`, `upstream-update`) sat on 6.
- **62 of 90 had no comment at all.** 23 had not been touched in 30+ days.
- By month opened: May 16, June 4, July 8, August 12, September 50.
- By title prefix: ~31 bug, 9 perf, 8 feat, 4 chore, 3 refactor, and ~20 vague
  or long-running items (for example #103 "General optimization sweep", #100
  "Improve documentation", #117 "Add app-wide Vim mode").

### 3.4 Lessons that shape the pipeline (from the release-readiness loop and today)

- **A `Fixes #N` or `Closes #N` in any commit or the PR body closes the whole
  issue on merge**, even when only part shipped. It bit #926/#928 and, today,
  #711 (reopened). Check trailers against what actually shipped before merging.
- **Mutation-checking finds what reading does not.** Today it caught a test that
  could not fail (fake time separated two "same-millisecond" generations) and
  two surviving guards per PR. Apply every mutation **individually** against a
  clean tree; a batched harness once reported a live mutation as dead.
- **Reviewers need their own worktrees.** Reviewers mutate code to test the
  tests; two reviewers mutating one checkout corrupt each other's results.
  Each reviewer gets a detached worktree (`.worktrees/review-<pr>-<letter>`).
- **Features added during a fix pass get reviewed hardest.** Today's
  auto-reopen for LSP editors looked small and had three security and
  lifecycle defects (#1208). If a fix pass grows new behaviour, it is scope
  creep: split it out.
- **Orchestration quirks** (see memory): Claude children can fail
  `composer-unpainted` on create (create without a prompt, wait, send a one-line
  pointer); Codex children can stall at `prompt_sent` (two nudges and ~30 min,
  then replace); one create can spawn two children (#952, list after every
  batch). Pi children accept a prompt after create on the terminal runtime.
- **Main moves fast.** Merge `origin/main` into every PR right before its final
  CI; semantic breaks (a renamed prop, #1110) show up only then.
- **Dependabot was silently broken for three days** by a hand-merged lockfile
  block npm ignores (#1195). Anything npm tolerates can still break other
  consumers; lockfiles are edited surgically, never regenerated wholesale.

---

## 4. Stage 0: close out the open PRs (in progress)

Scope: the 11 open PRs older than a day. #1192 and #1186 (agents active) were
left alone. The owner delegated the decisions.

| PR | Disposition | State |
|---|---|---|
| #1159 extensions: optional `params` | merged | DONE |
| #1167 plans move to `docs/plans` | merged | DONE |
| #1110 refused keystroke above modals | merged main in, fixed the test broken by #1177's `onPtyAction` rename, merged; **#711 reopened** (item 2 remains) | DONE |
| #1121 release 0.1.1 | closed: v0.1.1 already published | DONE |
| #1141 browser pocket spec | closed: already on main via #1149 | DONE |
| #987 30-package Dependabot group | closed; replaced by #1195 and issues #1201–#1204 | DONE |
| #575 July OpenCode rendering draft | closed; missing parts filed as #1205 | DONE |
| #1195 (new) Dependabot unblock + security | reviewed MERGE-READY; `dependabot.yml` holds migration packages out of the group | MERGED |
| #1111 feed-debug cursors | two review rounds, MERGE-READY; follow-up #1207 | MERGED |
| #1106 release-readiness ledger | archived to `docs/archive/`, open items filed as #1197–#1199 | MERGED |
| #1160 README "harness orchestrator" | conflict resolved twice keeping main's newer sections | re-running the flaky #1171 job, then merge |
| #1108 LSP ordering | 2 Codex + 1 Pi, two rounds; auto-reopen withdrawn (#1208); #922–#924 closed | MERGED |

Done: #923 and #924 closed by hand after #1108 merged.

---

## 5. Decisions

Settled by the owner:

- **D-A** Reviewers per PR: **2 Codex + 1 Pi**, in parallel, non-overlapping focus. (owner)
- **D-B** At most **two rounds**. (owner)
- **D-C** The loop **merges on its own** once the gate in 7.4 passes. (owner)
- **D-D** Stage 0 dispositions as in section 4. (owner delegated)

Proposed, running on the default until answered:

| # | Decision | Default | Why | Alternatives | State |
|---|---|---|---|---|---|
| 1 | May the loop look at the running app for UX bugs? | **No.** Keep "never launch the app": audit UX from source (tokens, empty/error/loading states, keyboard paths) and batch a visual checklist for the owner | Standing owner rule | (b) dev instance with its own state dir, driven by screenshots; (c) owner does all visual QA | accepted |
| 2 | Repos in scope | **agent-code plus the owned submodule packages** (package PR, then bump PR, both through the pipeline) | Most C1 bugs live in the headless packages | agent-code only | accepted |
| 3 | What round 2 is | **Only if round 1 had valid findings: the same reviewers verify the fix commits.** New non-blocking findings become issues. Never a round 3 | Matches the owner's cap without restarting review | full re-review | accepted |
| 4 | Merge gate | Section 7.4 | | | accepted |
| 5 | What waits for the owner (`needs-owner`) | **Workspace-file migrations, release/signing workflows, security or trust-boundary changes, removing or changing a feature's behaviour, and UX changes that are product calls** | These are the calls a reviewer cannot make | fewer categories | accepted |
| 6 | New features | **Frozen.** Bugs, UX polish and missing states only; feature ideas become issues | Quality is the goal | allow small features | accepted |
| 7 | Other agents' work | **Only the loop's own issues, PRs and worktrees.** Claim with a label and comment; never prompt or edit another agent's work | Many agents run in parallel | | accepted |
| 8 | Reviewer failure | **No activity after 30 min: replace with a Codex reviewer on the same brief.** If Pi fails twice on one PR, proceed with two Codex reviewers and record it | Known stalls | | accepted |
| 9 | Budget and pacing | **≤3 hunters at once; ≤2 PRs in review at once** (≤6 children plus me); **200 continuations**, then report and restart | Credits | | accepted |
| 10 | Definition of done | Section 1 | | | accepted |
| 11 | Testing standard | Section 8 (the 2026-09-19 standard) | Proven last loop | | accepted |
| 12 | Label taxonomy | **`type:` (bug, ux, perf, feature, chore), `class:` (C1–C9), `area:`, `provider:` (exists), `sev:` (P0–P3), plus `needs-owner`, `needs-evidence`, `loop:claimed`** | Filterable backlog | `sev:` + `class:` only | accepted |
| 13 | Closing authority during the audit | **Close on its own, only with cited evidence and a comment.** Uncertain → `needs-owner`, never closed | Speed; reopening is one click | owner approves a batch | accepted |
| 14 | Rewriting issue bodies | **Edit into the template (section 6.3) and keep the original text folded under "Original report"** | The vague title/body is what people read first | comment only | accepted |
| 15 | Where tracking lives | **Labels hold state; this file holds reasoning and evidence.** No project board | Nobody maintains a board | GitHub Project | accepted |
| 16 | Structured OpenCode | **Keep; #1205 after the bug work** | Both runtimes ship | park it and invest in OpenCode Terminal only | accepted |
| 17 | workflow-mcp shared deps | **Peer dependencies (#1202)** | Removes the two-copies trap | lockstep pins | chosen under D-D |

---

## 6. Stages

Each stage: **Produces / Verified by / Why separate.** Stages run in order,
except that fixes for P0 bugs found in any stage start immediately.

### Stage 0: open PRs (section 4)
- **Produces:** every PR older than a day merged or closed with a reason.
- **Verified by:** `gh pr list` shows only fresh PRs owned by active agents.
- **Why separate:** agents are working on the same code; fixing on top of stale PRs multiplies conflicts.

### Stage 1: open-issue audit
- **Produces:** the ledger table in section 11, one row per open issue, each in
  exactly one outcome:
  - **fixed** → close with the commit or PR that fixed it;
  - **partly fixed** → rewrite down to what remains, citing what landed;
  - **still valid** → confirmed with `file:line` evidence (or a recording);
  - **duplicate/overlap** → fold into one canonical issue, close the rest with links;
  - **obsolete** → the code it describes is gone; close with the evidence;
  - **feature / roadmap / product call** → label `type:feature` or `needs-owner`, out of fix scope;
  - **cannot reproduce without real use** → `needs-evidence`, saying exactly what evidence would settle it.
  Every issue gets the full label set (section 5, decision 12), and every valid
  bug gets an acceptance criterion and names its fixture source.
- **Method:** newest first. Read the body, linked PRs, and every later PR that
  touched the same code (`git log -S`, `gh pr list --search`). Batch obvious
  closes. Use up to 3 read-only research subagents for evidence; I read every
  claim that leads to a close.
- **Verified by:** zero open bug or UX issues without a `sev:` label (features, chores and perf roadmap items carry their `type:` label and "—" for severity, as the ledger has from pass 1); every closure links evidence.
- **Why separate:** fixing from an untrusted backlog repeats work already done and misses what matters.

### Stage 2: fix the audited bugs
- **Produces:** merged PRs, P0 first, then P1 by class (C1, C2 first).
- **Method:** section 7 per PR. One issue (or one tightly coupled cluster) per
  worktree, branch and PR. Package bugs: package PR first, then the bump PR.
- **Verified by:** each PR's fail-first test and the gate in 7.4.
- **Why separate:** audit output changes what is worth fixing.

### Stage 3: class hunts
- **Produces:** new issues in the audit template, then fixes via Stage 2's method.
- **Method:** one hunt per class, ≤3 read-only hunters at once, each briefed with
  the class definition, the known examples, the likely locations, and the
  evidence standard (a failure sequence and, where possible, a failing test).
  Starting points:
  - **C1:** every screen-text predicate in `packages/claude-code-headless`,
    `codex-headless`, `opencode-terminal-headless`, `pi-terminal-headless`
    that gates prompt acceptance; replay recorded TUI streams from
    `~/.config/agent-code/proxy` and the fixture corpus against them.
  - **C2:** every transition in `SessionManager` (reload, replace, restore, wake,
    hibernate, adopt, window transfer) × every piece of per-session state;
    what does each transition copy, drop or duplicate? #918 is the design doc.
  - **C3:** every `catch` that returns a default, every `return false`/`null`
    on a user action, and every `.catch(() => {})`: does the user learn about it?
  - **C4:** every component or hook that captures keyboard input globally; what
    releases it on unmount, error or hidden state?
  - **C5:** every loop over persisted records (ledgers, manifests, workspace
    files, skills, extensions): does one bad row fail the whole set?
  - **C6:** every `Map`, array, buffer, file or directory that grows per event
    or per session: what bounds it and what evicts it?
  - **C7:** the last 30 days of new features, checked against C1–C6.
  - **C8:** the rendering ledger with recorded fixtures; the open evidence issues #643–#646.
  - **C9:** #1198's inventory, plus every test that reads `$HOME`, the wall clock or real timers.
- **Verified by:** each hunt ends with a findings file under `temp/quality-loop/`
  and issues filed; a second sweep of the same class after its fixes land.
- **Why separate:** hunts produce the backlog Stage 2 consumes; mixing them loses findings.

### Stage 4: UI/UX sweep — DELEGATED to B18 (keyboard-first loop)

**Owner, 2026-09-25:** a dedicated agent (B18, session
`86a1511a-06fc-47de-9837-31e94a2930b5`) runs its own very long loop with ONE
PR (`feat/keyboard-first-ui`). The app becomes fully keyboard-operable, with
compact, clear labels on every modal and operation, and every UI surface gets
the spacing and consistency pass below. Its brief is
`temp/keyboard-loop/BRIEF.md`. The owner reviews that PR personally; B18
never merges it.

Division of work:
- **B18 owns** keyboard access, labels, focus, and visual consistency.
- **This loop owns** functional bugs. C4 (input traps) sits in both; B18 owns
  its keyboard side.
- B18 files non-UX bugs as issues, and this loop picks them up in Stage 2.

Second opinions go both ways, sparingly. **Each iteration of this loop checks
B18's activity** (`agent_management_list_agents` / `read_agent`). If B18 has
been idle for more than 30 minutes without a finished loop or a question to
the owner, nudge it with a one-line prompt pointing back at its brief.

The surface list below is B18's starting inventory.
- **Produces:** fixes for inconsistencies and missing states; a batched visual
  checklist for the owner (decision 1).
- **Surfaces:** composer and queue strip; feed and Reader Mode; condition modals
  and strips; pane headers and stripes; Dispatch / unified stage / session pool;
  command palette and keybindings; Settings (MCP, Skills, Updates, Appearance);
  Agent Activity, Analytics and TLDR/Goal peeks; Browser Pocket; extensions
  modals; the phone remote; onboarding; toasts and errors everywhere.
- **Per surface, check:** empty, loading, error, offline and permission states;
  keyboard-only use and focus return; spacing, radius and colour tokens against
  the theme (no one-off values); copy (clear, consistent command naming per
  `docs/command-style.md`); behaviour when the window is narrow or split.
- **Verified by:** per-surface findings list; fixes merged; the owner's checklist answered.

### Stage 5: re-hunt and finish
- **Produces:** a second sweep of every class; the end state in section 1.
- **Verified by:** section 1 items 1–4 all true; then `goal_loop_complete`.

---

## 7. The review and merge pipeline (per PR)

### 7.1 Build
1. Worktree from `origin/main` (`.worktrees/<outcome>`); `git submodule update --init`;
   `node_modules` symlink only if absent.
2. For non-trivial changes, a short plan in `docs/plans/` as the first commit.
3. A failing test on the real path, from recorded data (section 8), then the fix.
4. Prove the test: revert the fix, watch it fail, restore.
5. `npx tsc -b` and the scoped vitest projects on Node 24.
6. PR body: problem, change, verification, the verification boundary, and
   closing keywords **only for issues fully fixed**.

### 7.2 Review round 1
- One detached review worktree per reviewer: `.worktrees/review-<pr>-<a|b|c>`.
- Briefs in `temp/review-<date>/` (git-ignored): a shared rules file plus one
  per reviewer, following `pr-review`'s template. One-line prompt pointing at it.
- Focus split: **Codex A** correctness and concurrency; **Codex B** contracts,
  IPC, security and lifecycle; **Pi C** tests and what the user experiences.
- **Reviewer mix rotates** (owner, 2026-09-25) to spread usage limits across
  providers: 2 Codex + 1 Pi, three Pi, Pi + Claude, with a Grok reviewer mixed
  in now and then. Each PR's mix is recorded in its disposition table.
- **Evidence first, always** (owner, 2026-09-25): understand every error with
  the staged-decomposition discipline. Measure screens, wire shapes and files
  on real recordings before building on them, and never guess a mechanism.
  #1219 needed three attempts because the first two guessed.
- Every brief requires mutation testing (report surviving mutations) and
  counting real data where behaviour depends on it.
- List the run after creating children; close any duplicate.

### 7.3 Triage and round 2
- Read every report in full. Mark each finding valid / overstated / already
  fixed / wrong, reproducing the serious ones.
- Fix valid findings that matter: correctness, regressions, data loss, security,
  real user-facing breakage. Minor polish and pre-existing problems → issues.
- **If the fix pass wants to add new behaviour, stop and split it out** (lesson 3.4).
- Round 2 only if round 1 had valid findings: the same reviewers verify the fix
  commits and report new problems only if the fix introduced them. Anything
  found in round 2 is fixed by me without a round 3, or filed.
- Disposition table in the PR body: finding | verdict | disposition.

### 7.4 Merge gate (all must hold)
- **Owner decision, 2026-09-25 (~17:15 UTC), batch merges:** the owner rejected one-PR-per-CI-cycle ("can we not do the ci cd more efficiently … an integration branch we merge all prs in to then merge integration branch in to main"; then "merge a lot of the prs in to the integration pr only for the ci cd, and we can resolve all conflicts, not the ui ones"). Ready PRs are merged into one integration branch, CI runs once on it, and it merges to main with `--merge`, so each member's head lands in main and GitHub marks it merged. UI feature PRs (#1221, #1216) and Dependabot (#1218) are excluded. **Per-member gate before the batch merges (steering q39):** for every member,
  1. three reviews complete, with no unfixed blocker or major;
  2. a public final disposition on the member PR;
  3. an accurate body;
  4. `closingIssuesReferences` checked.
  The batch head must contain current main, and its green CI stands in for each member's own run. The batch PR stays a draft until every member passes; a member that fails is removed and the batch rebuilt.
- **Public final disposition** comment on the PR (tested head, green run, material fixes, caveats) and a PR body that describes the behaviour being merged, posted BEFORE `gh pr merge` (steering q35).
1. CI green (`quality-gate` and `minimum-node-fixture-gate`).
2. `origin/main` merged in shortly before that CI run; `mergeStateStatus` clean.
   Mechanical check right before merging: `git fetch origin && git merge-base
   --is-ancestor origin/main <pr-head>` must succeed. A green head that does
   not contain the current main needs main merged in and a fresh CI run
   (#1234 and #1235 were merged without this on 2026-09-25; steering q11).
3. No unresolved valid blocking finding; disposition table present.
4. Each regression test mutation-checked.
5. Closing keywords match what shipped; partly fixed issues get a comment and stay open.
   Check GitHub's own link, not just the text: `gh pr view N --json
   closingIssuesReferences` must list only fully fixed issues. A PR opened with
   "Fixes #N" keeps that link after the body and commit say "Refs" (#1222
   closed #290 that way; reopened).
6. Not in a `needs-owner` category (decision 5).

Then `gh pr merge --merge` (never squash or rebase), close by hand any issues the
PR fully fixed but did not name, and update this ledger.

---

## 8. Testing standard (2026-09-19, unchanged)

- Fixtures come from reality: an existing corpus under `testing/`, a PTY or
  stream recording, a real persisted state file, real CLI output, or a captured
  API payload. If none exists, capturing one is the first step of the fix.
- Test before the fix, on the real code path, and watch it fail for the reason
  the user hit.
- Prefer integration over unit mocks: drive the real entry point (command, IPC
  handler, main-process service). Mock only true edges, with recorded data.
- Assert observable contracts, not implementation details.
- Never delete or weaken a failing test to get green.
- When the semantics are genuinely unclear, record the question for the owner;
  do not invent an answer and bless it with a test.

---

## 9. How the loop runs

- Started with `goal_loop_start` once this plan is approved. Goal: the section 1
  end state. `maxContinuations` 200 (decision 9).
- **Loop prompt** (re-sent at every stop):
  > Continue the Agent Code quality loop. Re-read
  > `.worktrees/quality-loop/docs/plans/2026-09-25-quality-loop.md` and `git log`
  > on `docs/quality-loop`, trust them over memory, and check GitHub for PRs,
  > CI and reviewer children you started. Take the first unfinished item in
  > stage order. Follow the pipeline in section 7 and the testing standard in
  > section 8. Update the ledger and progress log in the same iteration and push.
  > Never edit other agents' work. The one exception: check on B18 (the
  > keyboard-first loop, session 86a1511a-06fc-47de-9837-31e94a2930b5) every
  > iteration and nudge it if it has stalled for 30+ minutes; answer its
  > second-opinion questions briefly. Call `goal_loop_complete` only when
  > every item in section 1 holds, or with `blocked` when only owner items remain.
- Each iteration does one unit of work (an audit batch, a PR step, a hunt) and
  appends a line to the progress log (section 12).
- `tldr_update` after each unit; `goal_set` only if the direction changes.

---

## 10. Owner-only items (collected; asked once)

- B18's keyboard-first PR (the owner merges it).
- **Issues labelled `needs-owner` by the audit** (one line each; the loop does
  not touch them until answered):
  - #1157 When can extensions require host 0.10.0 (drop the `init.method` alias)?
  - #1098 Two launches racing a stale lock: build the `.break` breaker, or accept the residual?
  - #1031 item 1: should the phone list hibernated agents and wake one?
  - #944 Does the performance qualification run block a release?
  - #766 Replace the raw PTY replay with a serialized screen, or close as moot?
  - #739 Smart resume (attention score + preview): still wanted, or delivered by #899?
  - #1199 Should v3 get a parked-note surface for buried panes?
  - #115 A secrets-only log sanitizer at the write/export boundary, or close?
  - #103 Close the "general optimization" umbrella in favour of its children?
  - #102 Typed logger / console consolidation: steps 1-2 only, or close?
  - #97 Is the current pin behaviour still wrong (and what should pin do), or close?
  - #290 item 1: are duplicate `providerSessionId` rows illegal, legal only with lineage, or legal but excluded from resume lookup?
- **Decided 2026-09-25:** remove the on-disk ghost log (PR #1235; #1227 closed).
- **B18's UI-pass defaults** (ask-2; B6 agreed, marked UNCONFIRMED in #1221): Title Case per the HIG, "folder", "Agents" (kept accurate where terminals are listed), and the dictation chip moved to the toast band.
- #1199: should v3 have a parked-note surface?
- #1160: confirm the "harness orchestrator" positioning once it is live.
- Batched visual checklist from Stage 4.
- Anything labelled `needs-owner` during the audit.

---

## 11. Ledger: open-issue audit (Stage 1 output)

**Stage 1 pass 1 (2026-09-25):** 89 open issues audited against origin/main
`e3579837` by three read-only research agents, and labelled on GitHub
(type/class/sev/provider plus needs-owner or needs-evidence). The full
per-issue evidence is in the agents' reports (session transcript). The
labels hold the state (decision 15). Closed: #700 (duplicate), and
#922/#923/#924 (fixed by #1108). No issue was closed on a FIXED claim without
a merged PR: the audit found **no stale-but-fixed issue** that was not
already covered. Today's own filings (#1197–#1208) are labelled too.

Next in Stage 1: rewrite PARTLY-FIXED bodies down to what remains (decision
14), and put the NEEDS-OWNER list in section 10.

| # | outcome | sev | class |
|---|---|---|---|
| #1217 | NEEDS-EVIDENCE | P3 | C9 |
| #1215 | FEATURE | — | C7 |
| #1214 | VALID (in open PR #1216) | P3 | C2 |
| #1213 | FEATURE | — | C2 |
| #1212 | VALID | P3 | C9 |
| #1210 | FEATURE (PR #1216) | — | C7 |
| #1187 | VALID (test counts the lane-port probe) | P3 | C9 |
| #1171 | VALID | P2 | C9 |
| #1157 | NEEDS-OWNER | — | — |
| #1138 | VALID | P2 | C1 |
| #1127 | VALID chore | — | — |
| #1119 | VALID | P2 | C1 |
| #1118 | VALID → PR #1219 | P2 | C1 |
| #1117 | VALID | P2 | C3 |
| #1114 | PARTLY-FIXED (spawn still waits on db path) | P3 | C3 |
| #1107 | PARTLY-FIXED | P3 | C9 |
| #1098 | NEEDS-OWNER | P3 | C2 |
| #1097 | VALID | P2 | C3 |
| #1091 | VALID | P2 | C3 |
| #1031 | NEEDS-OWNER (item 1) | P2 | — |
| #1009 | VALID | P2 | C9 |
| #944 | PARTLY-FIXED (qualification run) | — | C7 |
| #934 | FEATURE | — | C7 |
| #927 | VALID | P3 | C3 |
| #924 | FIXED by #1108 (closed) | — | — |
| #923 | FIXED by #1108 (closed) | — | — |
| #922 | FIXED by #1108 (closed) | — | — |
| #919 | PARTLY-FIXED | P2 | — |
| #918 | PARTLY-FIXED (umbrella) | — | C2 |
| #896 | FEATURE | — | C7 |
| #894 | PARTLY-FIXED (only Pi emits) | — | C2 |
| #877 | PARTLY-FIXED (live test not on prod path) | P1 | C1 |
| #833 | NEEDS-EVIDENCE | — | C9 |
| #800 | PARTLY-FIXED (Codex draft unknown) | P2 | C4 |
| #797 | NEEDS-EVIDENCE | P2 | — |
| #784 | VALID | P3 | — |
| #775 | PARTLY-FIXED | P2 | — |
| #769 | VALID | P2 | C6 |
| #768 | PARTLY-FIXED | P3 | — |
| #767 | PARTLY-FIXED | P2 | C6 |
| #766 | NEEDS-OWNER | P3 | — |
| #764 | FEATURE | — | C7 |
| #762 | VALID | P2 | C6 |
| #760 | FEATURE | — | C8 |
| #739 | NEEDS-OWNER | — | C7 |
| #736 | FEATURE (step C may be a live /compact bug) | — | C7 |
| #732 | VALID | P2 | C6 |
| #731 | VALID | P3 | C6 |
| #730 | VALID | P2 | C8 |
| #713 | VALID (keyboard side → B18) | P2 | C4 |
| #711 | PARTLY-FIXED (item 2) | P3 | C3 |
| #700 | DUPLICATE of #1107 (closed) | — | C9 |
| #686 | NEEDS-EVIDENCE | P3 | C9 |
| #678 | VALID | P3 | C2 |
| #677 | VALID | P3 | C8 |
| #676 | VALID | P3 | C6 |
| #675 | VALID | P3 | C2 |
| #646 | VALID chore | — | C8 |
| #645 | VALID | P3 | C8 |
| #644 | NEEDS-EVIDENCE | P3 | C8 |
| #643 | VALID | P3 | C3 |
| #601 | FEATURE | — | C7 |
| #518 | FEATURE | — | C7 |
| #512 | PARTLY-FIXED | P3 | — |
| #496 | FEATURE | — | C7 |
| #372 | PARTLY-FIXED | P2 | C6 |
| #370 | PARTLY-FIXED | — | C3 |
| #369 | PARTLY-FIXED (no counters/evidence) | P1 | C6 |
| #365 | NEEDS-EVIDENCE | P2 | C6 |
| #340 | NEEDS-EVIDENCE | P2 | — |
| #339 | NEEDS-EVIDENCE | P1 | C1 |
| #327 | NEEDS-EVIDENCE (no OOM in 50 runs) | P0 | C6 |
| #290 | PARTLY-FIXED (marker cannot fire) | P1 | C2 |
| #259 | FEATURE | — | C7 |
| #244 | PARTLY-FIXED | — | C7 |
| #243 | PARTLY-FIXED | P2 | C3 |
| #240 | FEATURE | — | C7 |
| #234 | VALID chore | P3 | — |
| #233 | VALID chore | — | — |
| #210 | FEATURE | — | C7 |
| #193 | NEEDS-EVIDENCE (replay says guard was right) | P3 | C2 |
| #179 | FEATURE | — | C7 |
| #117 | FEATURE | — | C7 |
| #115 | NEEDS-OWNER | — | — |
| #103 | NEEDS-OWNER (close umbrella?) | — | — |
| #102 | NEEDS-OWNER | — | — |
| #100 | PARTLY-FIXED | — | — |
| #99 | FEATURE | — | C7 |
| #97 | NEEDS-OWNER | P3 | — |

---

## 12. Progress log (newest first)

- 2026-09-27 (01:50 local) — **Owner decided all 12 items** (temp/manager/owner-decisions-2026-09-27.md: keep the fixtures, 90-day retention, never delete resumable runs, and the rest as recommended; approvals are recorded as OWNER-APPROVED comments). **Merged:** #1338 (Refs #1283), claude-code-headless#64 (Refs #1273, crash-only residual stated), and **batch C #1378** (`d5d71d0a`): #1351, #1328 (Fixes #1277), #1340 (Refs #243). New owner asks: deleting 23 leftover plaintext TLS key-log dirs (q91), and the #1384 toast. #1371 manager-verified. #1323 (B31's keyboard follow-ups) owner-approved; B31 is merging it.

- 2026-09-26 (23:50 local) — **Merged since 21:13:** #1325 (Refs #1280; body corrected after merge, q77), #1331 (Fixes #1320), #1342 (Refs #1302), agent-transcript-parser#37 (Refs #1295), workflow-mcp#67, plus four package Dependabot groups (opencode-headless#17, agent-transcript-parser#39, claude-code-headless#65, codex-headless#61).
  - **Blocked on the owner:**
    - #1353, the fleet titles (q73); its privacy fix is manager-verified (q82);
    - #1340, the dictation deadlines and wording;
    - #1351, 120 s / 5 min;
    - #1328, the "No goal yet" residual;
    - #1330, the retention window;
    - #1275 and wfm#65, parked for their TTL/Resume;
    - wfm#63, A/B;
    - #1332, its defaults;
    - #1339, its default;
    - q69, the public fixture history;
    - #1349;
    - #1323, which needs an owner.
  - **Fleet ops:**
    - #1350: stranded prompts are cleared by reloading the worker (W1–W4 were each reloaded at least once);
    - a WiFi drop killed three workers, which were revived;
    - load peaked at ~330, from 60+ finished reviewer agents plus a proxy-folder grep. Fixed by closing reviewers, a 3-reviewer cap per worker, and a no-whole-proxy-grep rule.
  - **Gate hardening:** merge-gate.sh (owner items, 0 behind, stale-body tripwire, exact-head CI, verdicts, manager-verify files).
  - **Final-pass cap outcomes:** cch#64's crash-only gap is accepted as stated; wfm#65 is parked.

- 2026-09-26 (21:13 local) — Since the last entry: **#1332 MERGED** (Fixes #372: the Codex mirror bound and the provider-neutral proxy reader; q68 found 3 UNCONFIRMED defaults merged without the owner's OK, now put to the owner), **codex-headless#57 MERGED** (a tall draft is still a draft; merged 6 commits behind, but main CI was green afterwards), **#1343 MERGED** (Refs #1327). Merges now go only through `temp/manager/merge-gate.sh`, which enforces UNCONFIRMED/owner, 0-behind, exact-head CI, disposition, labels and review verdicts. Filed #1350 (prompts stranded after an absorption timeout block delivery as a "human draft"; 3 workers affected; assignment files are the workaround) and #1355 (OpenCode serve spawn timeouts under load). q69: the public fixture history exposure has no secrets and is an owner decision. The machine is overloaded (load 40–60); rule: one tsc per worker.

- 2026-09-26 (19:47) — **Batch #1345 MERGED** (`ba29fb98`): #1326 (Reload Agents re-checks ownership; Fixes #1282), #1333 (a terminal survives a same-id respawn; Fixes #1281), #1337 (the GoalLoop grace test; Fixes #1314). Each member had 3 reviewers with verified blockers and a disposition; clean merges on main `b3a2c481`; the batch CI on exact head `5df3bf3a` was green. Local runs failed only on the known `stream` import quirk plus one timing test that passed in CI. Next batch (B): #1338, then #1325/#1331 after the q42 orphan-carry integration, then #1332 after the #56 pointer. q66 holds wfm#65 and the #1275 app half.

- 2026-09-26 (19:25) — **codex-headless#56 MERGED** (`f100f055`, the bounded Codex events mirror, off the synchronous path; manager verified q62 under the final-pass cap). **Integration batch #1345 opened:** #1326 (Fixes #1282), #1333 (Fixes #1281), #1337 (Fixes #1314); clean merges on main `b3a2c481`; CI running. New worker rules: never block on waiting (background CI and tests); reviewer rotation codex/codex/opencode, no Claude or Grok reviewers (`temp/manager/usage.md`); a final-pass cap after 3 verifications. Filed #1339 (optional Usage MCP, P1). Holds: #1328 (owner residual), wfm#63 (owner A/B), #1330 (owner window), #1340 (q61), #1342 (q63), wfm#65 and the #1275 app half (q64, plus the owner's retention window).

- 2026-09-26 (18:30) — **#1319 MERGED** (`b3a2c481`, Fixes #1313; Refs #800, still open for its residual #1327). Codex now sees a native draft before writing into it, and a restart can write into an empty 0.157 composer, using the settled screen from codex-headless#55. The gate: 3 reviewers × 2 rounds, then a focused verification pass by round-2 A/B (both MERGE-READY), exact-head CI green, contains main. **New worker rule:** any reviewer whose latest report is FIX-BEFORE-MERGE must verify before READY; this gap hit #1319, wfm#63 and #1325/#1331. #1325 may merge before the held #1326. Holds: #1326, #1328 (q56), wfm#63 (q57), cch#64 (q53), atp#37, #1330 (owner).

- 2026-09-26 (18:00) — **Holds and integration.** q53: cch#64, where the proxy tail loses or duplicates events on rotation. q54: W1 owns the shared proxyEventsReader, and W4's app half builds on it. q55: wfm#63, whose stale-root sweep is unsafe; it moves to a private-parent pid lease. q51/q52: #1328 is redesigned to refuse rather than evict racily. #1326 now contains #1324 (`f897700f`) and its a/c verifiers are running. The manager audit now reports cross-branch file overlap on every tick.

- 2026-09-26 (17:52) — **#1324 MERGED** (`d15a9756`, Fixes #1267, closed). session:spawn launders provider exceptions before they cross IPC and journals a fixed signature. Merged alone: 3 reviewers × 2 rounds, disposition plus q42 addendum, exact-head CI green, contained main. Main moved, so #1319/#1325/#1326/#1331 are merging it in; #1326 applies the q42 Map integration first. Holds: q50 atp#37 (managed statusLine runs), q51 #1328 (live-Goal eviction race), #1330 (owner retention window). New reviews: claude-code-headless#64 (#1273).

- 2026-09-26 (17:47) — **workflow-mcp#64 MERGED** (`80363d77`). It pins libexpat 2.8.5-r0 (fixes CVE-2026-93990), which repairs the image-contract check on every workflow-mcp PR. 3/3 reviewers MERGE-READY; exact-head CI 8/8 green. #1331 (Fixes #1320, stacked on #1325) is in review. q48: #1319 becomes Refs #800. q49: #1330 must retain tasks, quarantines and unknown outcomes.

- 2026-09-26 (17:40) — **codex-headless#55 MERGED** (`6334d5ac`). A settled-screen API: no parse pending, no open DEC 2026 synchronized update, and the provider has painted since the last resize. 3 reviewers; A/B verified MERGE-READY in round 2; exact-head CI green. W1 now bumps #1319 to it. Also: q44 holds atp#37 (env allowlist); q47 holds #1330 for the owner's retention decision; #1326 is back to W3 (q47 point 2). Reviewers are running for #1330 and wfm#64.

- 2026-09-26 (17:35) — **Switched to manager plus four Claude workers** (owner decision). The goal loop is replaced by a 5-minute manager tick.
  - **Setup:** the plan, worker rules, claim formula (`next-issue.sh`, atomic `mkdir` claims) and transcript audit (`audit.py`) are in `temp/manager/`. B32 is restarted as the watcher (`temp/steering-loop/BRIEF-v2.md`).
  - **In flight:**
    - W1: #1319 plus codex-headless#55, round 2.
    - W2: #1325 round 2; #1320.
    - W3: #1326 round 2; #1328 (Fixes #1277) round 1; #1274.
    - W4: #1295 via workflow-mcp#63 and agent-transcript-parser#37 (round 1); #1273.
  - **#1324:** the lifecycle test is fixed (q42). It merges alone once exact-head CI is green.
  - **Merge order:** #1324 → #1326 → #1325, because the three share the reload path (q42).
  - **q43:** workflow-mcp#63 must clean up its temp root when setup fails; the image-contract pin is fixed in a separate PR.

- 2026-09-26 (17:55) — **New #1326** (#1282, C2): Reload Agents re-checks ownership (a skip before each kill; a commit-time re-check that kills orphaned successors), and the live draft, images and unread marker carry over. Five fail-first tests on the recorded workspace. A post-spawn check was redundant with the commit check (its mutant survived) and was removed. Three reviewers are running. In flight: #1319 and #1324 (round 2), #1325 (round 1).

- 2026-09-26 (17:30) — **Round-1 findings fixed; round 2 is out.**
  - **#1319:** review C found a blocker: Agent Code's own Enter on a Codex pane wrote raw into a native draft, because the composer submit bypasses the delivery gate. Submit now refuses while `composer-occupied` (every provider), and Ctrl+C passes through to clear the draft (the recorded 0.157 way). Review B's gaps are pinned (publication through the real `screen` listener; the final empty check alone).
  - **#1324:** a non-Error throw is never read; proxy guidance is limited to Claude with the proxy on; failures journal a fixed signature (C: the posix_spawnp fact was lost from every artifact); Reload Agents keeps curated sentences.
  - A's session for #1319 was lost in the restart, so a new A was started for round 2.
  - **#1325** round 1 is in progress. **Next:** #1282.

- 2026-09-26 (16:40) — **Goal loop restarted** (`goal_loop_start`, 200 continuations). The previous loop record did not survive the session restart, and I wrongly reported it as running. New loop prompt: act on steering notes first, batch merges per §7.4, no B18 nudges (B18 finished; #1221 merged), keep issues and labels in sync, and never stop to wait. In flight: #1319 (B and C re-reviewing) and #1324 (#1267, 3 reviewers). Next: #1280 and #1282 (C2).

- 2026-09-26 (00:30) — **Batch #1318 merged** (`33fd8f83`) on the owner's explicit "yolo merge". Main CI on it is green, and it also cleared main's red run from #1221's renamed labels. All 12 members registered merged; the post-merge integration review said MERGE-READY. Issue hygiene pass: 52 recent issues labelled, status notes on #1292, #1281, #1273, #372 and #1267, duplicate #1217 closed.
  - **Owner decision (2026-09-26):** keep the loop going; "we are in a really good state." Batch merges stay the default.
  - **#1319** (Codex drafts, #800/#1313): the q40 fix and the review-A fix are in `e8490f29` (a text-only empty proof must hold on two polls). B and C were restarted on that head after the session restart lost them.
  - **Next:** #1267 (main relays raw spawn exceptions over IPC; P2, security), then C1/C2 P2s (#1280, #1282).

- 2026-09-25 (15:10) — **Merged: #1308** (`7f273e06`, closes #1272; body rewritten first) and **codex-headless#53** (`d7d7a5d`). The bump is **#1317** (refs #372). #1309 is remerged onto `7f273e06`, with a fresh gate running.
  - **Third reviewers (q37):**
    - MERGE-READY: #1257, #1263, #1284, #1287 and #1298, with minors only.
    - FIX-BEFORE-MERGE: #1286 and #1297, both now fixed.
      - #1286: creates show the three curated spawn failures (Claude proxy, missing folder, missing CLI, whose sentence now lives in shared), and nothing else.
      - #1297: a hover on stale rows can't carry over (reset on landing, hover ignored while stale). The integration requirement for #1221 is posted on #1221.
    - Both C reviewers are on their one verification round.
  - **codex-headless#54:** round 2 found the cwd forging both hints. Fixed by anchoring the hints to Codex's hint rows, never the status row; the final disposition is posted.
  - **New #1316** (#1315, the Pi bootstrap waits for its bridge). B's six mutants all now fail tests, and round 2 is out.
  - ~~Decision: a pointer-only bump PR relies on the package PR's reviewers~~ **Withdrawn (steering q38):** owner decision 2 (§ line 180) sends the bump PR through the pipeline too. #1317 gets three pointer-specific reviewers and its own disposition before merge.

- 2026-09-25 (14:20) — **#1300 merged** (`1d25b0ed`, closes #1261). #1171 closed by hand (same failure). #1308 is remerged onto `1d25b0ed`, with a fresh gate running; it merges next.
  - **Steering q37 (quorum):** #1257, #1263, #1284, #1286, #1287, #1297 and #1298 had only reviewers A and B. None merges without a third. Independent C reviewers (Pi/Grok alternating) are now reviewing each final head. #1297's C must cover stale selection, paging and overlap with #1221, and #1284's C the unreviewed package commit 052a476. #1297's posted two-reviewer disposition got a public correction.
  - **#1297:** the round-2 test now drives a scroll, so it reaches `loadMore` (verified by mutation). Body rewritten; disposition posted but not final until C reports.
  - **#1287:** misplaced and stale `carryGoalLoops` JSDoc fixed. Body and disposition wait for C.
  - **New #1315 (P2, C1):** every Pi `orchestration_create_agent` bootstrap fails with "Pi bridge is not connected" (5 of 5 today), and a retry succeeds. Pi delivery doesn't wait for the bridge.

- 2026-09-25 (13:45) — **claude-code-headless #63 merged** (`64fd0eaf`, disposition posted first). #1309 is bumped to it and remerged onto `54287d90`. Its last failure was the #1261 palette flake, which #1300 fixes.
  - **Main CI red on `54287d90`:** `GoalLoopService` 'unrelated traffic cannot renew the screen grace' saw 2 deliveries where 1 was expected. It is not reproducible locally (15 isolated runs, 6 shuffled whole-file runs). Filed **#1314** (C9, suspected fake-timer and real-I/O interleave); timeouts must not be widened.
  - **Steering q36:** the codex-headless#53 fixture held provider instruction text under base64. It is now sanitized byte-for-byte, the commit was amended out of the branch history (head `0800cba`), and the redaction is noted in the PR. Reviewers A and B were re-prompted for their final round. Memory: read the WHOLE fixture before committing.
  - **Dispositions:** drafts exist for #1257, #1263, #1284, #1286, #1287, #1297 and #1298. Each is posted when its PR reaches the head of the queue. Still owed before merge:
    - #1297's round-2 test doesn't exercise its fix (the ArrowDown guard);
    - #1287 has a wrong comment;
    - #1284's package commit 052a476 was never reviewed;
    - most bodies are stale.
  - **#919 is needs-evidence:** each window's `beforeunload` reads live state at its own close, and there is no stored cross-window vote.
  - **#800 + new #1313:** a raw PTY recording of Codex 0.157 shows a dim placeholder, a plain draft and a two-row footer. The 0.149.1 classifier returns `unknown` for both frames, and the app's empty check refuses every browser-pocket restart (#1313). **codex-headless#54** (live, attribute-aware `getComposerState`, mutation-checked) is under review by Codex ×2 and Grok. The app PR follows after it merges.

- 2026-09-25 (13:15) — **#1301 merged (`54287d90`, closes #1276).** It went green first, so the queue order became #1301 before #1300. That was intentional; one merge per cycle holds either way.
  - **Steering q35 (process):** #1301 merged without its public disposition, and its body described pre-review behaviour. Both were fixed after the merge; the disposition includes the confirmed `tMs` caveat. **The public disposition and an accurate body are now a pre-merge gate** (§7.4), alongside reviews, CI and current-main ancestry.
  - **#1300:** remerged onto `54287d90`. Round-2 A's plan/body drift is fixed (focus race, not frame selection; product gap is #1307). The pre-merge disposition is posted, and a fresh gate is running on `6ae2738f`. It merges next on green.
  - **#1310 final round:** A and C blocked on overcounted widths (🌡/🗓 text-presentation pictographs, U+200B). Fixed with narrow-by-default widths (`\p{Emoji_Presentation}`, `\p{Cf}` = 0), which also makes flags 2 cells. The unknown-width guard test was added. Disposition posted on `0690e66c`.
  - **#369 is needs-evidence:** the counters and the completed-flow replay are done, but the corpus holds 0 `response.failed` or `response.incomplete` events (34 dumps, 702k chunks). All open P0/P1 issues now need evidence or the owner. **Next:** P2 by class, starting with #372 (C6, Codex proxy mirroring).

- 2026-09-25 (12:45) — **Round-2 findings fixed and dispositioned (final round):**
  - **#1312:** a rejected /model delivery after Stop no longer counts the untouched agents as failed. The modal now pins Return's stop, Escape during /model, stops during later agents and the per-run reset.
  - **#1311:** attach and detach carry the page document, so a late detach from the dead page can't take the live page's reference. The debug inline terminal detaches only an attach main accepted.
  - **#1309:** a typed row that matches a known hint ("Press up to edit") is now a draft, not cleared. The `readComposer` adapter is tested.
  - **#1308:** B's round-2 findings were already fixed in 5077e3a6; disposition posted.
  - **Queue:** #1300's gate is running on main 3c12bb73; #1301 is next. #1310 is waiting on its 3 final-round reviewers.

- 2026-09-25 (12:20) — **#1310 reworked for steering q34:** only a full row is a hard cut now.
  - A row one cell short is ambiguous, because xterm drops trailing spaces, so it keeps its space. The worst case there is a timeout.
  - The new negative test was red on 85c3490e and is green on d40fec0b.
  - CJK sweeps now run on even body widths. The odd-width misses (43 of 121 widths) are pinned as the #1292 residual, and the PR says Refs #1292.
  - All 3 reviewers were re-prompted for the final round.
  - #1300 and #1301 both contain main 3c12bb73; their fresh gates are running. #1300 merges first.

- 2026-09-25 (11:50) — **main CI for #1258 + #1264 is green** (run 36149128459), noted on #1264.
  - #1261 flaked again, on #1309; it was re-run, and #1300 is still first in the merge order.
  - **New PR #1312** fixes #1271: a running bulk provider switch can be stopped after the current agent. 3 reviewers.
  - **#1293 is needs-evidence:** there are no recorded Codex or Claude frames of the dialog or working states to anchor the predicates on.

- 2026-09-25 (11:25) — **No merges this cycle:** 13 PRs are queued or running, and so is main's check of #1258 + #1264.
  - #1261 flaked a fourth time (#1286) and was re-run. #1300, which fixes it, merges first once green.
  - **New PRs:**
    - #1310 fixes #1292: CJK hard wraps, which were missed at 85 of 121 widths.
    - #1311 fixes the agent half of #1281: a raw PTY view now survives a same-id wake. The plain-terminal half is a recorded residual, since terminals have no detach call.
    - Each has 3 reviewers.
  - **#1308 round 1:** the list scrollbar no longer ends recording, and the reviewers' two mutants are now pinned.

- 2026-09-25 (10:50) — **Merged #1258** (`c13de395`, closes #1248) and **#1264** (`a56d696a`, closes #1242).
  - **Process slip (steering q31):** #1264 merged 5 s after #1258 on a tested head that did not contain #1258. Its disposition is corrected, and main's push CI for `a56d696a` is the check of the combination.
  - **Rule from now on:** after a merge, remerge main into the next PR and wait for a fresh gate before merging it. Never two merges off one check. Saved to memory.
  - **Steering q30:** #1301 now tracks every in-flight evicted writer per press, tested A→B→C in both landing orders.
  - **New PR #1309** fixes #1291 (C1, journal evidence): the rollback reads the attribute-aware composer. 3 reviewers.
  - Every open PR is re-merged with the new main, and #1286 now uses the shared `MISSING_WORKSPACE_FOLDER_PREFIX`.

- 2026-09-25 (10:05) — **Merged claude-code-headless#62** (`2ce428cf`). #1284 now points at that merge commit.
  - **Round 2 is complete and its findings fixed** for #1284, #1286, #1287, #1297, #1298, #1300 and #1301. All of them, plus #1257, #1258, #1263, #1264 and #1266, now only wait on CI: 13 PRs are queued on congested runners.
  - **New PR #1308** fixes #1272 (the shortcut recorder releases on outside click or blur). It has 3 reviewers.
  - **#1299 corrected (steering q29):** 230,747 non-zero audio samples came after `deepgram:close`, so a silence stop alone is not enough. "Stop when the provider stream closes" is now the first proposal. The defaults are an owner call.
  - **#1301 design changed (q29):** past the budget, events go into per-minute summaries instead of a single suppression marker. Replaying the 1.2 GB file gives 17.6 MB, and the 26 h post-close tail stays visible.
  - **Watchdog:** the goal loop is active (6 of 200). The keyboard loop is done and waiting on the owner (#1221). The steering reviewer is active.

- 2026-09-25 (09:35) — **Merged #1265** (`9bb035c2`, closes #1243).
  - **All Stage 3 hunts are done.** C7 filed #1302–#1306, all P3.
  - **New P1 #1299:** dictation kept the mic open 32.8 h (Deepgram streamed for 6.8 h). There is no max duration and no silence stop. The defaults are an owner call.
  - **New PRs:**
    - #1300 fixes the #1261 extension CI race. Steering q28 required 3 reviewers; they are Codex, Pi and Grok.
    - #1301 fixes #1276, the dictation journal cap. It has 3 reviewers.
  - **Round-1 fixes pushed:**
    - #1286 (q22 flattened at the `sessionSpawnErrorMessage` source; keybind gate follows the mounted overlay; latch generation);
    - #1287 (no carry for `newConversation` or a successor without `goal_loop`);
    - #1297 (the keyboard ignores stale rows while a new scope loads);
    - #1298 (output hash, faithful fixture, marker parity);
    - #1300 (a `focusFrame` wait; product gap filed as #1307).
  - **#1284 round 2 fix:** the sidecar invariant is now "newest body not in the log", which covers bodies over the per-body cap. Zero budget cleans up at load.
  - Every open PR was re-merged with main. Only `pull_request` runs are cancelled from now on.
  - **Review quorum (q28):** new PRs get 3 reviewers. PRs opened before q28 keep their 2-reviewer rounds, which steering accepted then.

- 2026-09-25 (08:40) — **Merged #1262** (`0198af02`, closes #1241).
  - **Stage 3 hunts done: C1, C2, C3, C4, C5, C6, C8, C9.** Only C7 (new-feature clusters) and the second sweeps remain. Findings files are `temp/quality-loop/hunt-c{1,8,9}.md`.
    - C1 filed #1291–#1294. #1291 has journal evidence: 4 of 5 rollbacks are `rollback-exhausted`.
    - C8 filed **P1 #1288**, plus #1289 and #1290, with comments on #644 and #1231. The loop re-counted #1288: 270 of 2,212 rollouts have 1,232 colliding keys.
    - C9 filed #1295 and #1296, and commented the #1261 root cause (a modal palette focus/ordering race, not the activation log line).
  - **New PRs:**
    - #1287 fixes #1279: a goal loop follows its pane through a replace.
    - #1298 fixes P1 #1288: a shared Codex rollout identity.
    - #1297 is the picker test race. Steering q27 found a real product bug behind it: an enablement refresh reset the highlight, so Enter resumed the wrong conversation. It is fixed fail-first.
  - **#1284 / package #62:**
    - Round 1 fixes: the newest body is kept in a sidecar for bundles, and a zero budget writes no body.
    - Steering q26 fix: zero now means no sidecar either.
    - The trailer is `Refs #1273` (steering q24).
  - **Steering q25:** don't init `vendor/*` submodules in fix worktrees; only `packages/*` are needed for tsc.

- 2026-09-25 (07:45) — **Merged #1260** (`d525d457`, closes #1246).
  - **Disposition correction (steering q24):** reviewer B's writeFile residual was not fixed. It is filed as #1285 and noted on #1260.
  - **Stage 3 hunts C2, C4 and C6 are done:** `temp/quality-loop/hunt-c2.md`, `hunt-c4.md` and `hunt-c6.md`. Only C1, C7, C8 and C9 remain, then the C3/C5 second sweeps.
    - C2 filed #1279–#1283.
    - C4 filed #1269–#1272.
    - C6 filed #1273–#1278. #1273 is **P1**: a live Claude `proxy-events.jsonl` reached 2.37 GB today, 92.9 % of it `body_b64`.
  - **New PRs:**
    - **#1284 + claude-code-headless#62:** a per-file request-body budget. The trailer is `Refs #1273` (steering q24), because the live-file retention residual stays open on #1273. Reviewers are Codex × 2; a Claude reviewer was blocked by the folder-trust dialog and replaced.
    - **#1286 (#1269, #1270):** the New Agent overlay owns no input while hidden, reopens its latch after a failed create, and the q22 raw spawn toasts in `pane.ts` are gone. Reviewers are Pi and Grok.
  - **Round-2 fixes pushed:**
    - #1264: a deleted folder is consumed, not retried forever. The shared `MISSING_WORKSPACE_FOLDER_PREFIX` was added, and #1267 is filed for q22 at the source. Both reviewers said MERGE-READY, and the minors are fixed.
    - #1266: the page epoch now covers the plain open path, and pending opens are subtracted. The A1 TOCTOU is #1268.
  - **#1265:** both reviewers said MERGE.
  - **Waiting on CI:** #1257, #1258, #1262–#1266, #1284, #1286. #1261 (the intermittent extension test) hit #1258 again.
  - **Process note:** cancelling stale runs by SHA also cancelled main's push run; it was re-run. Filter on `event=pull_request` next time.

- 2026-09-25 (06:55) — **Merged #1256** (`451842b5`, closes #1245) and
  **#1259** (`9c6e48fc`, closes #1249) plus grok-code-headless#4 (`97e3038`).
  - **P2 C3 batch:** #1262, #1263, #1264 and #1265 are open, with review
    fixes pushed.
  - **Steering q22:** no raw spawn IPC text in any toast; the shared
    `SESSION_START_FAILED_MESSAGE` is used everywhere.
  - **#1266 (#1208):** renderer-driven, main-authorized LSP reopen after
    server loss. It is transactional against the manager's own count
    (steering q23); three reviewers.
  - **#1230:** moved to needs-evidence. The source settles `chalk.dim`, but
    no raw PTY capture exists; a synthesized frame would be invented data.
  - **#1261 (intermittent extension Electron test)** hit #1260 again; the
    job was re-run.
  - **Stage 1 check:** the 40 open issues without `sev:` are all
    feature, chore or perf roadmap items (plus B18's #1220). The
    verified-by line now says so.
  - **P0/P1:** all remaining ones are needs-evidence or needs-owner (#327,
    #339, #290; #369's in-code fix landed in #1238).
  - **Next P2s:** C8 #1233/#1231 (ghosts), C3 #1097, then C6 #769/#767/#372.

- 2026-09-25 (05:45) — **Merged #1236** (`b21ed712`, closes #762) and **#1254**
  (`9c1de6e3`, closes the P1 #1240). Two review rounds are done on
  #1256–#1260, and every round-2 finding is fixed; each merges on green
  CI (only a main merge or CI remains).
  - **Steering q18–q21 caught real data-loss paths:**
    - goal-loop: a failed copy started empty and later persisted `{}`;
      q19 found a delayed valid-loop loss;
    - workspace: a null tab or project replacing a real one kept 6 of 27
      and 3 of 13 agents, so it now gets a typed lock;
    - a FIFO mutant harness hung twice (use bounded runs; never pipeline
      a blocking mutant).
  - **Shared evidence rule across the store family:** a digest-named atomic
    copy, taken before any write can drop a row. A failed copy never fails
    reads; writes wait for it. The helper is duplicated in #1257/#1258/#1260
    until merged; consolidate onto `src/main/storage/preserveInvalidBytes.ts`
    afterwards.
  - Opened #1262 (#1241 picker resume failure). Filed #1261 (intermittent
    extension Electron test). Remaining P2s: #1242, #1243, #1244.

- 2026-09-25 (04:45) — **Merged #1252** (`d86ef9b9`, closes #1239) and **#1238**
  (`dd5a44f7`, Refs #369) plus codex-headless #52 (`ae0e935`). Open:
  - **#1236:** q15 fixed (the preload announces its document on every load,
    so a reload retires old leases). Waiting only on CI.
  - **#1254 (#1240):** round 2 found keyed `startControlTask` step rows read
    as damage. The consistency check is now executor-kinds-only, with a
    missing-intent rule (0 hits in the real journal); q17 fixed (no
    per-launch re-quarantine). Merges on green.
  - **#1256 (#1245):** v2 shapes added per q16. Review A's
    `detachedSessions` suspicion was verified (27→3 agents) and fixed with a
    typed lock and entry re-homing. Round 2 is out.
  - **#1257 (#1247)**, TLDR/Goal per-record set-aside: A's atomic copy,
    history salvage and revision floor are fixed; B is pending.
  - **#1258 (#1248)**, goal-loop per-loop set-aside: in review.
  - **#1259 (#1249)** plus grok-code-headless#4, mistyped summary fields: in
    review.
  - Filed #1253, #1255. The CI queue is saturated; superseded runs are
    being cancelled.

- 2026-09-25 (03:40) — **#1237 merged** (`77beed18`, closes #877). Round 2 is MERGE
  on #1236, #1238 (+ codex-headless #52) and #1252. Two-round residuals fixed in
  the same PRs:
  - #1236: leases are now keyed to the document (a per-load preload id), not to
    `did-start-navigation`, which Chromium fires before the throttle where the
    app blocks `will-navigate`, so a blocked link click froze debug panels.
    Mutants J, A and E are pinned. Filed #1253 (picker colour-only selection,
    pre-existing).
  - #1238/#52: the proxy leaked the upstream body and socket for every exchange
    the client closed after `response.completed` (16 of 30 recorded); fixed in
    the proxy. Single transport terminal pinned; filed #1255 (no idle after a
    mid-stream end).
  - #1252: raw provider error text removed from panes (shared
    `SESSION_START_FAILED_MESSAGE`); a failed process outranks transcript
    states; no timer on failed panes.
  - **#1254 opened for #1240** under steering q12–q14. Recovery keeps
    idempotency: a torn tail resumes fully; other damage blocks keyed intents
    where lost rows could hold their key; the block derives from the preserved
    evidence and clears only by naming its digest. Plan commits `8be3658b`,
    `4ea65889`. Reviewers: Grok (A) and Pi (B).
  - Merges waiting only on CI: #1236, #1252; #1238 waits for #52's merge and a
    submodule bump.

- 2026-09-25 (midday):
  - **Merged:** #1229 (Fixes #1117; package PR opencode-terminal-headless#9 merged first), #1234 (Fixes #678), #1235 (Fixes #731; the on-disk ghost log is removed).
  - **GATE MISS (steering q11):**
    - What happened: #1234 and #1235 were merged on green heads that predated #1229 on main, without first merging main into them (§7.4(2)).
    - Remediation: the combined main `9d446f03` was checked locally. `tsc` is clean, and the full suite has 2 failures, both known local timeouts (workflows control; `store.test`, which passes alone). main CI is being watched.
    - Rule reinforced: before every merge, check that the PR head contains current origin/main; if not, merge main and wait for fresh CI.
  - **Opened:**
    - #1237: #877 live proof. Review fixes: the exact prompt is asserted, and inherited config env is cleared.
    - #1238 + codex-headless#52: #369. A real leak: about half of real Codex responses have no response-end, so their flows were held until the watchdog. Fixed at the semantic terminal, plus heartbeat gauges.
    - #1252: Fixes #1239, a P1 from the C3 hunt. Its test runs on the real workspace and the recorded `posix_spawnp` failure.
  - **Hunts:** C3 and C5 are done (`temp/quality-loop/hunt-c3.md`, `hunt-c5.md`). Filed #1239–#1251.
  - **#290:** items relabelled needs-owner and needs-evidence, with live-workspace evidence.
- 2026-09-25 (late morning):
  - **#1236 opened (Fixes #762):** screen IPC by interest.
    - Plan commit first; a recorded-frame fail-first test that is red on main.
    - Five mutations killed.
    - Reviewers: A Codex, B Claude, C Pi. Steering q7 applied.
  - **#1229:** round 2 was merge-ready. B's new finding (the banner survived a successful read) is fixed. Package PR opencode-terminal-headless#9 is MERGED and the pointer is at its merge commit; waiting on CI.
  - **#1235:** round-1 minors fixed (docs, comments, cleanup contract tests); round 2 is on the post-merge head.
  - **#1234:** containment test added. A's major (ambiguous-twin settlement) is declined as an accepted residual, with evidence (0 occurrences in 2,410 transcripts); round 2 sent to A.
- 2026-09-25 — **Owner approved removing the on-disk ghost log.**
  - #1227 closed unmerged; #1225 and #1232 closed. #1231 was re-scoped to live ghosts.
  - **#1235 opened (Fixes #731):** removes the journal, IPC, preload and retention bucket, cleans the old directory on launch, and updates the design doc. It has merged main (kept `sweepGhosts`); reviewers are A Claude and B Pi.
  - **#1228 MERGED** (Fixes #730).
  - **#1234 opened (Fixes #678):** notification twins resolved by body, then by a unique id. It corrects two corpus tests that had blessed the misattribution. Reviewers: A Codex, B Pi.
  - **#1091:** labelled needs-evidence (a transport change needs a recorded drop first).
  - **Next: #762.** An explorer mapped every `session:screen` consumer:
    - main and prompt delivery never need the renderer's screen;
    - picker is already owned by conditions;
    - `latestScreenRef` and `claudePaste` are dead;
    - only debug surfaces need frames.
  - **Local env note:** `workflows/control.system.test.ts` times out locally on origin/main too, while CI is green.
- 2026-09-25 — **#1224 MERGED** (Fixes #1138, after steering q5: a partly unreadable report is unknown). **#1226 MERGED** (Fixes #1119; follow-up #1230).
  - **#1227 (restore reads ghost logs):**
    - Blocker from reviewer A: stale ghosts repainted as duplicates. Fixed with a last-content-update clock and response identity.
    - Steering q6: a straddle hid lost tails; 7 real cases were found and fixed.
    - The restore no longer holds tail-passed ghosts.
    - Follow-ups: #1231 (Codex ghost id), #1232 (Reload Agents ids).
    - **On hold:** owner asked whether the on-disk ghost log should be deleted entirely (nothing has read it since July; 2.1 GB).
  - **#1228 (Fixes #730):** 3,231 re-mints counted on disk; `sweepGhosts` extracted after review; follow-up #1233. Round 2 is running.
  - **#1229 (Fixes #1117):** a host heal on `db_path_recovered_late`. A busy late open now reports (opencode-terminal-headless#9), and a failed heal keeps the lifetime banner. Round 2 is running.
- 2026-09-25 — **#1223 MERGED** (Fixes #732, ghost-log orphan pruning).
  Round 2: A, B and C all MERGE-READY. The disposition table is in the PR
  body. **#1227 opened** (Fixes #1225): restored panes read their ghost log
  under the persisted id, and the dead spawn bootstrap is gone. Reviewers:
  A Claude, B Pi, C Pi. **#1226 round-1 fixes** (`c6496dba`):
  - whitespace-only prompt plus image skips the text wait, which could never
    confirm;
  - the rollback branch and the separator are now tested; 5 mutants killed.
  Round 2 sent to B and C; A is still on round 1. **#1224 round-1 fixes**
  (`ac45391a`):
  - The Monitor tool reports as "shell", so a persistent monitor parked the
    loop for 2 h and then paused it.
  - Each background-work report now holds for 45 min and then DELIVERS.
  - The latch is kept when the report is unknown.
  - 7 mutants killed.
  Round 2 sent to A, B and C.
- 2026-09-25 — **#1222 MERGED** (#290 marker slice). GitHub closed #290
  through a closing link left from the PR's original "Fixes" wording, so it
  was reopened with the remaining items. The merge gate now checks
  closingIssuesReferences. #1223 round 2 all MERGE-READY (waiting on CI).
  #1226 (#1119 image literal) opened.
- 2026-09-25 — **#1219 MERGED** (#1118 closed): the composer text is reconstructed
  from recorded geometry. #1160 MERGED. #1222 (#290 marker slice): 2 Codex + 1
  Pi, two rounds, all MERGE-READY; waiting on CI. #1223 (#732 orphan ghost
  logs): round 1 found missing/empty/partial workspace.json must mean unknown
  owners (fixed with the parser's completeness, as tmuxRecovery does) and that
  **nothing has read a ghost log on restore since 0cb71e99** (filed #1225,
  C2 P2); round 2 running. #1224 (#1138 goal loop waits for background work):
  evidence captured on the wire from Claude 2.1.282 (`background_tasks` on
  the Stop payload), reviewers Pi + Grok + Pi. #731 measured 0 duplicates, so
  needs-evidence (explained by #1225). 18 partly-fixed issues rewritten; the
  needs-owner list is in §10.
- 2026-09-25 — #1219 round 2: the pattern matcher was withdrawn (it matched an
  earlier part of the same paste); the composer text is now reconstructed from
  the recorded geometry (full line = divider - 1, calibrated by the Pi
  reviewer). #1222 (#290 marker slice, Refs not Fixes after steering note 2)
  opened, under review. Owner: rotate reviewer mixes; evidence first always.
  A 30-minute watchdog cron (session-only) restarts this loop and nudges the
  other two if they stall.
- 2026-09-25 — #1219 round 1: both Codex reviewers found real false-confirmation
  and baseline gaps in the strip-everything approach; replaced with a
  wrap-tolerant pattern (inserted whitespace allowed, missing whitespace not),
  3 new mutation-proven tests; round 2 running. Steering note 1 received:
  keep §4 in step (done), leave dialog chrome to B18, move to C1/C2 P0–P1.
- 2026-09-25 — Stage 1 pass 1 done: 89 issues audited and labelled; #700
  closed as a duplicate. #1108 merged, and #922/#923/#924 closed. #1219 opened
  (#1118, C1 paste tail through a hard wrap), under review by 2 Codex + 1 Pi.
  #1160 re-running the flaky #1171 job. The owner added a **steering
  reviewer** (session d98f3f4b-2846-4a58-a2cd-5d10566e6a02, a Codex agent; the brief first went to 0c009320 by mistake and was handed over; brief
  `temp/steering-loop/BRIEF.md`) that reviews both loops and may send batched
  notes. The keyboard loop opened draft #1221 (tracking #1220); its
  second-opinion #1 was answered (agree on all 5, with notes).
- 2026-09-25 — Owner accepted the recommended decisions and started the loops.
  Stage 4 is delegated to B18 (keyboard-first, one PR, owner merges). Merged
  #1195, #1111, #1106; #1108 has all review findings fixed (the Pi round
  added a close test) and is waiting on CI; #1160 re-merged main.
- 2026-09-25 — Plan written. Stage 0: merged #1159, #1167, #1110; closed #1121,
  #1141, #987, #575; reopened #711; opened #1195; archived the release ledger in
  #1106; resolved #1160; #1111 two review rounds MERGE-READY; #1108 two Codex
  rounds done (auto-reopen withdrawn → #1208), Pi review pending. Filed #1197,
  #1198, #1199, #1201–#1205, #1207, #1208.

---

## Out of scope

- New features (decision 6), including the ideas filed as `type:feature`.
- Other agents' PRs, issues and worktrees (decision 7).
- Launching the app (decision 1, unless changed).
- Release engineering beyond what a bug fix needs.

## Verification boundary

Nothing in this loop runs the app, a packaged build, a long soak or a real
signed self-update. Each PR states what it could not verify; UX that can only
be judged by eye goes on the owner's checklist.
- 2026-09-27 09:42Z B6: q93 sent to W2 (#1391 held, not batched); q94 sent to W3 (och#10 + app pointer held: creation-time order loses launch-window rows). Manager-verified #1349 a/c (764bdeb0 red at c90fea0c; totalOnDisk survivor is a residual) and #1353 c (88ccb3ea .git walk). Batch D #1389 waiting on the exact-head quality-gate.
- 2026-09-27 10:00Z B6: och#10 MERGED 7a009541 (q94 resolved: latch-based gap report; precreated/backward-clock/BUSY pinned; recheck2 a/b MERGE-READY). App pointer PR (Fixes #1114) must pin the host latch + no-input-before-first-output contract. #1349/#1353/#1364 member-gate PASS, going to batch E. Batch D #1389 still queued for a CI runner.
- 2026-09-27 10:05Z B6: q95. #1391 capped (round5-a: resultIsError OR-merge paints a corrected result red); scope narrowed to a unit-wise tool-result tuple by later resultAt, then manager inspection, out of batches. #512 wiring into useKeybinds.ts sequenced after W1 #1394; dismiss stack goes in new files only.
- 2026-09-27 10:10Z B6: batch D #1389 quality-gate was starved in the queue for 70 min (newer runs kept starting ahead of it); cancelled and re-ran run 36307880057.
- 2026-09-27 10:14Z B6: q96: cxh#70 held (late rename restores an old latest body), sent to W1. #1391 manager-verified at 39c712b6 (unit-wise tool result; 3 tests red at 8aa9ab02; block-index residual), READY once exact-head CI is green. Batch D quality-gate re-queued.
- 2026-09-27 10:19Z B6: q97. #1397 held: merged och#10 (7a009541) can still lose a commit after BUSY + late db-path recovery (B/C reproduced); W3 does the package repair first (report on onPositioned, fail-first real SQLite), then the app bump with bounded prepaint input. Lesson: the #10 recheck scope did not cover BUSY during late recovery.
- 2026-09-27 10:24Z B6: the macOS runner pool (5) is the bottleneck; batch D is 2nd in the queue and already contains main 95aff39b. Cancelled the held #1397 CI to free a slot.
- 2026-09-27 10:45Z B6: q98 disk: 1.2 GiB free. Removed 136 clean worktrees fully merged into origin/main (7 with temp/notes kept) → 34 GiB free. #1360 ENOSPC run re-run as infrastructure. q99: #1392 capped, scope narrowed (drop tail-parser recovery → follow-up issue). Batch E probe (#1349/#1353/#1364/#1383 onto the batch D head): merges clean, tsc 0. Batch D quality-gate running.
- 2026-09-27 10:50Z B6: q100 sent to W3 (#1397 pre-attach flush bypasses the refusal; neutral copy). #1392 manager-verified at d14fb426 (4 tests red at 84ef2f1a). #1396 design call B: settle only at bootstrap-complete, follow-up issue for redelivery double-count (a hidden queued prompt is not acceptable). Batch D quality-gate still running.
- 2026-09-27 11:00Z B6: batch D #1389 MERGED 5e22c7b0 (#1361 Fixes #645, #1371 Fixes #1341). Batch E #1404 built from 5e22c7b0 with #1349/#1353/#1364/#1383 (member gates PASS); CI queued. q101: #1396 held (the bootstrap guard can retire a real queued prompt). #1392 waiting on its exact-head CI; #1391 body tripwire.
- 2026-09-27 11:25Z B6: q103 (my error): batch E was built on stale 95aff39b, missing batch D. Merged 5e22c7b0 in at 870c607c (no D∩E files); body corrected; the old green CI is void; new exact-head CI running. Rule added: non-member merge-gate on every batch PR before merge.
- 2026-09-27 11:55Z B6: batch E #1404 MERGED 505efa6a from exact head 870c607c (#676, #1231 closed; #767 and #1296 Refs, still open). q105 (my error): merged after a MANUAL check (ancestry, CLEAN, both checks SUCCESS) WITHOUT running the non-member merge-gate.sh, and with no disposition comment. Disposition posted after merge. From batch F on: disposition comment first, then the non-member gate PASS output is pasted into the batch record, then merge. No merge on any FAIL.
- 2026-09-27 12:08Z B6: q106 sent to W3 (#1413 cooldown per session); q107 → W1 via its assign file (the prompt was refused: #1350 native draft; reload when idle). #1403: all a/b/c latest MERGE-READY, READY after CI. Batch F #1415 waiting on quality-gate.
- 2026-09-27 12:35Z B6: manager-verified #1376 c (docs only), wfm#65 c (survivor pinned e6bfd315; app 6441fd86 keeps a lineage while ANY member is resumable) and wfm#63 a (superseded: API keys refused, no sweep). OWNER-PROXY DECISION: wfm#65/#1275 cost ACCEPTED (a lineage that ever failed, was cancelled or was interrupted is kept forever; tightening needs a package change). q108 → W2, q109 → W4 (#1417 fixed at 83c3a4e5, reviews running). Batch F #1415 quality-gate running.
- 2026-09-27 12:45Z B6: batch F #1415 MERGED 5ebd2455 after the non-member gate PASS (recorded on the PR): #1360, #1366, #1368 (Fixes #1362), #1391 (Fixes #1290), #1394 (Fixes #1307), #1400 (Fixes #784). #1394 on main unblocks the #512 useKeybinds wiring (W2).
- 2026-09-27 12:55Z B6: batch G #1422 opened from 5ebd2455: #1330, #1377, #1386, #1398, #1403 (member gates PASS; disposition posted). q110: #1420 held (SECURITY: destination/token split), W2 fixes it fail-closed, then fresh reviews. #1376 conflicts with main, so W4 merges main in. #1413 NEED-MANAGER is next.
- 2026-09-27 13:00Z B6: #1413 manager-verified at fd5c2ef9 (verify a/b majors fixed; 2 new tests red at f72f8670; q106 per-session cooldown present). Batch G #1422 CI running.
- 2026-09-27 13:30Z B6: batch G #1422 MERGED after the non-member gate PASS (recorded): #1330, #1377 (Fixes #1107), #1386 (Fixes #1289), #1398, #1403. Manager-verified #1423 (b1 split to #1425). q111: #1424 held (W3).
- 2026-09-27 13:40Z B6: batch H #1428 opened from 6938e612: #1413, #1376, #1406 (member PASS; disposition posted). #1392 gate fails on c round-2 FIX, sent back to W2 for manager check.
- 2026-09-27 14:05Z B6: manager-verified (independent check agents running the old source): #1392 c at a4a0f191 (6 red), #1424 a/b at d859e68a (9 red; 4 residuals), #1426 a/b at c32d4bae (1 red; a1 decline accepted). q112: batch H body set to Refs #1273. q113: #1420 security hold continues; secrets must be bound to destination identity.
- 2026-09-27 14:20Z B6: batch H #1428 MERGED b7ae6e30 after the non-member gate PASS (recorded): #1413, #1376, #1406 (Fixes #1187). #1273 was auto-closed by #1376 sidebar link, so it was reopened with a comment (q112). q114: #1420 decision: legacy tokens kept, withheld until the user confirms.
- 2026-09-27 14:30Z B6: batch I #1432 opened from b7ae6e30: #1423 and #1424 (member PASS; no closing refs, so #1250 stays open). #1392 and #1426 wait on CI.
- 2026-09-27 14:50Z B6: q115: #1411 held (a failed per-run readdir becomes [] and then deletes refused evidence). New worker-common rule "Unknown is never empty" (q109/q115), sent to W2/W3/W4 (W1 has a blocked input; it is in the file). Batch I #1432 still queued.
- 2026-09-27 15:05Z B6: q116 sent to W3 (#1434: unknown→[] in discovery; plan-first). #1429 manager-verified (the mutation test fails as expected). Batch J candidates at member PASS: #1367, #1392, #1395, #1407, #1408, #1416 (q107 plan-first confirmed), #1421, #1426. Batch I #1432 CI running.
- 2026-09-27 15:20Z B6: q117 PTY exhaustion. Root cause: the Agent Code main process (pid 94543, 13h26m up) holds 509/511 ptmx masters with only 34 sessions, a leak, filed #1437 P1. All workers told to pause new reviewers/probes; #1436 reviewer A told to cap concurrency at 4. Owner restart of the app would free them (B6 revives workers after).
- 2026-09-27 15:35Z B6: batch I #1432 MERGED dc9b7519 after the non-member gate PASS (recorded; no closing refs, #1250 open). Batch J #1438 opened from dc9b7519: #1367, #1392, #1395, #1407, #1408, #1416, #1421, #1426; local tsc running. #1429 needs manager-verify-c. PTY is still 506/511 (#1437); a restart is needed.
- 2026-09-27 15:55Z B6: q117 recurrence. #1436 reviewers B/C ran 24-way probes despite the pause; B stopped by prompt, C INTERRUPTED and capped at 4; caps appended to all #1436 briefs; no probe processes remain. q118: #1420 held (bind to reference IDs); W4 #1417 owns the manual-ledger loader, and #1388 drops its edit. OWNER-PROXY: #1381 = option B (durable gap row). Batch J #1438 CI running (local tsc 0).
- 2026-09-27 16:10Z B6: batch J #1438 MERGED 181717c2 after the non-member gate PASS (recorded): #1367, #1392 (Fixes #1207), #1395 (#1321), #1407 (#1363), #1408 (#1212), #1416 (#1285), #1421, #1426; #1250 stays open. Today: batches D through J merged (7 batches, ~35 PRs).
- 2026-09-27 16:25Z B6: manager-verified #1431 (3ecabbd6) and #1429 c (the fixes are real; c8e858c1 is tests only, so the disposition gets corrected). Batch K #1441 opened: #1429, #1436; merge waits for #1429 disposition correction and CI. #1431 conflicts with main, so W3 merges main in.
- 2026-09-27 16:40Z B6: q119. #1442 (#1381 gap row) held: owner-proxy answer says option B must survive restart (reseed from incident records) or the claim is narrowed with a follow-up issue; held on cch#69; plan rewrite plus residual issues; spinner decision pending. Batch K #1441 CI running; the #1429 disposition correction is posted.
- 2026-09-27 16:55Z B6: q121. PTY at hard limit: reloading W1 failed (posix_spawnp); the #1446 reviewers cannot take prompts. W1 is idle until an app restart. Owner restart (#1437) is now blocking. #1445 filed (restart-durable gap store: OWNER DECISION, related to #1235). q120: #1442 narrowed to the app-run lifetime.
- 2026-09-27 17:05Z B6: q122 disk 100% (137 MiB). Removed 116 clean worktrees fully merged into main, now 40 GiB free; worker cleanup-after-merge rule added. PTY still exhausted, so the owner restart is required.
- 2026-09-27 17:15Z B6: batch K #1441 MERGED after the non-member gate PASS (recorded): #1429, #1436 (Fixes #1334); #1250 open.
- 2026-09-27 17:25Z B6: q123 (my error): batch bodies F–K kept a future-tense "Merge only after" line and K a HOLD. All 6 bodies corrected to past tense, plus a post-merge comment on #1441. merge-gate.sh tripwire now fails on "merge only after"; plan rule added: conditions go in comments, the body is past tense before merge.
- 2026-09-27 17:35Z B6: all READY PRs re-gated on 12b531e3; only #1431 passes, so batch L #1448 opened (single member). W2/W3/W4 were idle with undelivered queues; nudged directly to code-only work (no new agents under PTY exhaustion). W1 is down until the app restart.
- 2026-09-27 17:50Z B6: q124: #1431 body truth fixed. INCIDENT (mine): a failed sed inside `gh pr edit --body "$(...)"` blanked the #1431 body for about 1 min; restored verbatim from userContentEdits. The other 9 PR bodies were verified non-empty. Rule: python plus assert plus --body-file.
- 2026-09-27 18:10Z B6: batch L #1448 MERGED after the body-truth check (past tense, via body-file) and the non-member gate PASS (recorded): #1431 (Fixes #1305).
- 2026-09-27 18:30Z B6: #1420 security check (independent check agent, 7 mutations killed): R1/R2/R4 hold; R3 BROKEN, because re-setting the VALUE of the input that supplies the host sends the token to it (two sequences reproduced). FIX-BEFORE-MERGE; B6 design: bind to a digest of the other inputs' values, plus agent set_secret on destination-bearing inputs goes to pendingReview; fresh A/B/C after the fix.
- 2026-09-27 18:40Z B6: W2 fixed #1420 R3 at ae9135ff (binding plus a digest of the other inputs' values; agent set on destination inputs means review plus disabled); held for fresh A/B/C after the PTY restart. W3 answered: #1442 spinner A (owner proxy), #1433 after #1411/#1450, #1339 usage snapshot saved. Checking #1411/#1417 for W4.
- 2026-09-27 18:55Z B6: q127 ruled (no narrowing; hash all inputs; agent/import changes need review; a user Settings change counts as confirmation). #1411 manager-verified a/b/c; pre-existing two-store deletion filed #1453. #1417: fixes verified, 2 data-integrity survivors to pin (inode cache key, journal retry order) before verification.
- 2026-09-27 19:05Z B6: batch M #1454 opened with #1411. #1411 changed Closes→Refs #1251 (row 13 lives in unmerged #1417).
- 2026-09-27 19:45Z B6: the owner restarted the app. PTY back to 25/511. Layout restored (2x4: watcher, keyboard B12, B6, B20 / W1, W2, W3, W4). Review pause lifted; all workers and the watcher revived with their pending assignments; #1439 (the PTY leak fix) reviews first. New main window 6a8e328b.
- 2026-09-27 20:00Z B6: owner away; 5-min tick recreated after the app restart. Checks: #1434, #1450, #1456, cch#68 and wfm#63 MERGE-READY; cch#68 MERGED 1cfa8c92, wfm#63 MERGED 6bcaf113; #1375, #1417, wfm#71 code OK but bodies stale; #1420 (case-insensitive id), #1388, #1414, #1455 each have one FIX item. Batch O #1461 (member PRs merged via GitHub, the owner's history form) in CI. Batch P queue: #1384, #1440, #1447, #1449, #1456.
- 2026-09-27 20:10Z B6: W4 READY #1375, #1456, wfm#71 (wfm#71 is 11 behind after #63 merged, so it needs a main merge); #1463 opened for the pointer bumps (cch#68, wfm#63, parser#37). Batch O #1461 CI running (e03147ae).
- 2026-09-27 20:20Z B6: workflow-mcp#71 MERGED 513374d5 (gate PASS recorded); #1463 to re-point at it. Batch O CI still running.
- 2026-09-27 20:30Z B6: och#11 MERGED 3935a3bb; cch#69 needs a main merge (behind after #68). #1354 manager-verified (doc-only fixes). CLOSED as W1 recommended, branches kept: #1390 (needs a package PR), #1399 (needs a run identity, #1405), #1410 (7 findings, can't converge under the freeze). Refused the #1275 app PR (freeze). Batch P queue: #1374, #1375, #1384, #1434, #1440, #1447, #1449, #1450, #1456.
- 2026-09-27 20:45Z B6: batch O #1461 MERGED 53568fb6 (#1439 PTY leak fix, closes #1437; #1451 Usage MCP, closes #1339). Batch P #1464 built the owner's way: 9 members merged via GitHub (#1356, #1374, #1375, #1384, #1434, #1440, #1447, #1449, #1456); local probe tsc 0. #1450 held for the next batch (index.ts); #1354 is a draft.
- 2026-09-27 20:55Z B6: cch#69 MERGED 0928344e (#1442 to re-point). #1412 manager-verify-b written (b2 fails 2/9 when reverted; b1/b3 the accepted LSP limit), but exact-head CI fails 8 LSP core tests, a real failure sent to W2. Batch P #1464 CI running.
- 2026-09-27 21:05Z B6: #1420 SECURITY manager-verified MERGE-READY at 17bde9e1 (case-insensitive guard fails when reverted; all attacks refused); gate PASS, next batch with #1450. #1388, #1414 and #1455 re-check running. Batch P #1464 CI running.
- 2026-09-27 21:20Z B6: batch P #1464 MERGED f0bcf09c (9 PRs; closed #1347 #1373 #1370 #1306 #1348 #1425 #1372 #1427). #1388 manager-verified. Batch Q #1465 built via GitHub merges: #1354 #1397 #1420(security) #1450 #1452 #1463; #1417 excluded (codex.ts conflict). #1414 and #1455 need test-only pins.
- 2026-09-27 21:35Z B6: 10 PRs open (from 35). Batch Q #1465 CI running. Checking the W2 pins (#1414, #1455) and the #1412 CI fix. cch#66 is 11 behind, so W2 merges main.
- 2026-09-27 21:45Z B6: manager-verified #1414, #1455 and #1412 (pins killed; #1412 CI fix is test-only). #1455 and #1412 gate PASS; #1414 needs its disposition comment. Next batch R after Q: #1388, #1412, #1414, #1455, #1417.
- 2026-09-27 21:55Z B6: batch Q #1465 MERGED 2bb66465 (closed #234 #1114 #1304 #1430 #1295; #1409 stays open). cch#66 MERGED 487f029c (#1382 to re-point). Batch R #1466: #1388 #1412 #1414 #1455 merged via GitHub; the body corrected to Refs #1268 (the sidebar link had leaked in as Fixes). #1417 conflicts with #1388 and main, so W4 merges main after R.
- 2026-09-27 22:05Z B6: 6 PRs open (#1466 batch R in CI, #1442, #1417, #1396 held, #1382, #1216). #1216 is the owner's opt-in auto-titles feature (2 days old, conflicts with main, no reviews, body asks for explicit owner approval), left for the owner.
- 2026-09-27 22:30Z B6: batch R #1466 MERGED 4b7e6696 (#1388, #1412, #1414, #1455; closed #1303 #1385 #1453; #1268 stays open). 5 PRs open: #1417 (main merge), #1382 and #1442 (CI after package re-point), #1396 (held on #1402), #1216 (owner).
- 2026-09-27 22:40Z B6: batch S #1467 with #1442 (title corrected: it lasts for the app run, not a restart). #1382 conflicts with #1442 on the cch gitlink, so it takes 487f029c (contains #69) after S. #1417 CI running after its main merge.
