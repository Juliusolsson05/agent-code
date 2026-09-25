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
- **Verified by:** zero open issues without a `sev:` label; every closure links evidence.
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
1. CI green (`quality-gate` and `minimum-node-fixture-gate`).
2. `origin/main` merged in shortly before that CI run; `mergeStateStatus` clean.
3. No unresolved valid blocking finding; disposition table present.
4. Each regression test mutation-checked.
5. Closing keywords match what shipped; partly fixed issues get a comment and stay open.
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
