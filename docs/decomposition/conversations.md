# Conversations: discovery, listing, search, and prompt history

> Stage decomposition, written before implementation per `staged-decomposition`.
> Revised in place when a stage disproves it. Status: **approved by the user
> on 2026-09-11 with the defaults in §8**. Owner: the `feat/session-picker`
> branch.
>
> Umbrella issue: #874. Supersedes the direction of PR #701 (label identity
> only, closed 2026-09-11) and the plan in
> `docs/superpowers/plans/2026-08-30-session-picker-identity.md`. Closes the
> problem records #96, #151, #718 (regression lock), #735 (regression lock),
> #739 (partially: ordering), #773. Refs #762 (picker channel).

## 0. The complaint, restated as measured defects

The user's report on 2026-09-11: the resume picker never shows the transcript
they are looking for, it is full of orchestration review transcripts, the
ordering is off, at least half of the transcripts are missing, and the prompt
search is slow and equally useless. Every part of that is a distinct defect in
the current code, and none of them is the UI. Measured on the user's machine
against the real stores (numbers are the evidence, not estimates):

| Defect | Where it lives | Evidence (2026-09-11) |
|---|---|---|
| Hard cap of 20 rows | `useResumeSessionListing.ts:56`, `PathPickerModal.tsx:159`, both pass `20` | The focused project dir holds 57 Claude transcripts; 37 can never appear. |
| Worktree sessions are invisible | `src/providers/claude/runtime/sessionList.ts` reads ONE project dir for the cwd. Upstream Claude Code's `listSessionsImpl.ts` has `includeWorktrees` defaulting to `true` and merges every project dir returned by `git worktree list --porcelain`. Agent Code's app-side copy dropped that. Codex: `listCodexSessions({cwd})` requires an exact cwd match. | Agent-code and its worktrees hold **155** Claude transcripts across **40** project dirs; the picker reads 57 of them. Codex: **935** rollouts with the main cwd plus **200** with a worktree cwd. The repo has 35 live worktrees. |
| Orchestration children are indistinguishable | Nothing records provenance. Children are ordinary provider sessions whose first prompt is `<orchestration-handoff>…`. | Claude main dir: **16 of 57** are children; worktree dir: **9 of 16**. Codex index: **235 of 1,133** agent-code threads are handoff children, plus **357** native Codex subagents (`thread_source = subagent`) and **519** `codex exec` runs (373 of them in agent-code). The newest 20 rows are roughly half review workers. |
| Codex labels are boilerplate | `codex-headless/src/transcript/SessionList.ts` takes the first `event_msg/user_message`, which since Codex ~0.150 is the injected `# AGENTS.md instructions for <cwd>` message. | All 20 rows returned for this cwd were labelled with the AGENTS.md text. Codex's own index (`state_5.sqlite`) already stores the real first prompt as `title`. |
| Codex listing is slow | Walks and `stat`s every rollout on every open, then head-parses newest-first until 20 cwd matches. | 2,020 rollouts, 4.2 GB. **1,539 ms** cold and **1,742 ms** warm for the main cwd; **2,852 ms** for a worktree cwd. Codex's SQLite index answered the same question in **50 ms** including open. |
| Prompt search is slow | `sessionIndex.ts` folds up to 400 files per provider fully on a cold query. | Head-parsing all rollouts alone took **10.7 s**. Claude Code's global `history.jsonl` (13,174 prompts, 4.6 MB) answered a substring search in **34 ms**. |
| Nameless Claude sessions are dropped | `parseSession` returns `null` when no title, last prompt or first prompt is found. | Codex shows the same case with a hex label; the providers disagree on membership (#701's finding, confirmed). |
| In-session prompt lists are capped | `ViewPromptsModal.tsx` `PROMPT_LIMIT = 15`, `RewindToPromptModal.tsx:99` same limit; timestamps absolute only. | User 2026-09-11: "capping the view prompts command is just pure stupid"; wants relative time. |
| Rows carry no time; preview turn count is wrong | `CommandPalette.tsx:2160-2168` renders label, branch and cwd only. `SessionPreviewPane` derives "N turns" from `countUserTurns` over its 40-record tail window. | User's bringdown screenshot (2026-09-11): 20 identical rows "main · …/bringdown", no dates, preview says "1 turn" for a long planning session. Codex's index for bringdown: 98 threads, 66 orchestration children, 13 real sessions with readable first prompts and `recency_at_ms`. |

Two expectations to state plainly because no code can change them:

- Claude Code deletes transcripts after `cleanupPeriodDays` (default 30). The
  prompt history knows **1,566** sessions; only **371** transcripts remain on
  disk, and the oldest one in this project is from 2026-08-14. Those sessions
  are gone and the picker cannot resume them. Raising the retention is a user
  setting in `~/.claude/settings.json`, not a picker feature.
- Codex's index and its files drift slightly: 22 rollouts on disk are not in
  the index (March/April 2026, before the index existed) and 9 indexed rows
  point at deleted files. The catalog must tolerate both directions.

## 1. A and D

### A: what exists and is trusted

Provider stores (read-only to us, authoritative):

- **Claude Code.** `~/.claude/projects/<sanitized-cwd>/<uuid>.jsonl`, one dir
  per cwd, worktrees included. Modern transcripts start with `last-prompt`,
  `mode`, `permission-mode`, `bridge-session`, then `attachment` records
  (hook output, environment snapshot) before the first `user` record, which
  sits at record index 6–8 in this project. `{"type":"ai-title","aiTitle":…}`
  exists in 310 of 371 transcripts; `customTitle` in 6; the `last-prompt`
  record now carries only `leafUuid`. Subagents live under
  `<projectDir>/<uuid>/subagents/agent-*.jsonl` (already watched by
  `src/main/subagents`) and never in the top-level list. Global prompt history
  `~/.claude/history.jsonl` with `{display, pastedContents, timestamp,
  project, sessionId}` covers 56 of the 57 transcripts here; the 30 transcripts
  without a history record are all projected, duplicated or SDK-smoke sessions.
- **Codex.** `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` plus
  the index `~/.codex/state_5.sqlite` (WAL journal). Table `threads`: `id,
  rollout_path, cwd, title, first_user_message, preview, name, source
  (cli|exec|vscode|{subagent:…}), thread_source (user|subagent|null),
  agent_nickname, agent_role, git_branch, created_at_ms, updated_at_ms,
  recency_at_ms, archived, has_user_event`; table `thread_spawn_edges
  (parent_thread_id, child_thread_id)`. 2,007 rows. `title` is the real first
  prompt (Codex strips its own AGENTS.md injection). 278 rows carry a user
  `name`. `has_user_event` is 0 everywhere and must not be trusted.
  `thread_history_1.sqlite` holds per-turn items and is not needed for v1.
- **OpenCode.** `~/.local/share/opencode/opencode.db`, table `session (id,
  project_id, parent_id, directory, title, time_created, time_updated,
  time_archived, …)` and `project`. 507 rows. `parent_id` marks subagents.
  `opencode session list --format json` exists as a CLI fallback (#773).

App code that works and stays:

- `workspace.replaceSession(cwd, { resumeSessionId, kind })` and
  `workspace.newTab(cwd, resumeSessionId, kind)`: the resume actions.
- `SessionPreviewPane` + `historyLoader.ts` (backwards tail read, #747): the
  preview.
- `getHostTranscriptAdapter(kind).listPrompts(cwd, nativeId)`: rewind
  addresses.
- `extractPromptsFromFile` in `sessionIndex.ts`: the incremental byte-range
  prompt folder with 12 evidence-backed tests (#735). It moves; it is not
  rewritten.
- `SessionMeta.{title, agentNameId, orchestrationParentId, orchestrationRootId,
  orchestrationRunId, orchestrationRole, providerSessionId}` in the live
  workspace, autosaved through main's `WorkspaceFileStore`; the agent-name
  registry in `src/main/agentNames`.
- `relativeTime` in `src/renderer/src/lib/relativeTime.ts`.
- Command-style rules (`docs/command-style.md`) and the palette mode store.

App code that is the problem (deleted in Stage 5):

- `src/providers/claude/runtime/sessionList.ts` (app-side fork of the upstream
  lister, minus worktrees) and its dormant twin in `claude-code-headless`.
- `listCodexSessions` as the Codex listing source (kept only as fallback).
- `src/main/sessionIndex.ts` discovery, listing and search (the prompt folder
  survives), `src/main/ipc/sessions.ts`, `src/preload/api/sessions.ts`, the
  duplicated `SessionIndexEntry` in `preload/api/types.ts`.
- `useResumeSessionListing.ts`, the palette `resume` mode, `PromptSearchModal`,
  `PromptSearchSurface`, the `ResumeSection` in `PathPickerModal`, the 15-prompt
  cap in `ViewPromptsModal` and `RewindToPromptModal`.
- `MainProviderConfig.listSessions / listAllSessions /
  sessionDiscoveryUnavailableReason` and `savedSessionListing` in
  `featureCapabilities.ts`.
- PR #701 (`feat/session-picker-identity`): closed, not merged. Its
  `labelSource` provenance idea is adopted below.

### D: the end state, observable

1. **One picker.** "Resume Session…" and "Search Conversation Prompts" open
   the same Conversations surface. It lists every past conversation of the
   focused pane's **repository across all worktrees**, from **all three
   providers**, newest user activity first, with a preview pane. Enter resumes
   into the focused pane under the conversation's **own** cwd and provider.
2. **Nothing is silently omitted.** Every transcript or index row in scope
   appears exactly once, or appears in the hidden-children count. No cap; the
   list pages. A nameless conversation is shown with a marked fallback label.
3. **Children are hidden by default** (Agent Code orchestration children,
   native Codex/OpenCode subagents, `codex exec` runs, projected handoff
   transcripts) behind one toggle that shows their count. The preview of a
   parent lists its children.
4. **Labels are recognisable and carry provenance.** Ladder in §2.3. The
   second line shows provider glyph, Agent Code spoken name when the
   conversation ran here, branch or worktree, "N hours ago", and prompt count.
5. **Scope and provider filters live inside the picker** (this cwd, this repo,
   everywhere; any provider), never inherited silently from the focused pane.
6. **Search is instant** over labels, names and user prompts, with match
   highlighting; opening the picker costs under 100 ms warm and under 500 ms
   cold on this machine's corpus, and search under 50 ms. Measured by the live
   suite in §5, not asserted by hand.
7. **View Prompts and Rewind list every user prompt** with a relative time
   ("3 hours ago") and the absolute time on hover, virtualised, no cap, fed by
   the same main-side prompt reader.
8. **External operators** (`nativeHistory.list / search / prompts`) and the
   debug harness (`session:list-all`) are served by the same catalog.
9. **Codex, Claude and OpenCode rows are equally rich**; OpenCode discovery
   works (#773).

## 2. Design decisions taken (with the user's answers)

The user answered two questions explicitly on 2026-09-11 and left the rest to
the recommended defaults. Recorded here so no later session re-litigates them.

| Decision | Choice | Why |
|---|---|---|
| Data sources | **Provider-native indexes first** (user: "we should for sure use the indexes that the providers have natively"). Codex `state_*.sqlite`, Claude project dirs + `ai-title` + `history.jsonl`, OpenCode `opencode.db`. Rollout/transcript scanning is the fallback, never the primary path. | They are what the providers' own pickers use, they are complete where our scans are partial, and they are two orders of magnitude faster. |
| Verification | **Integration-heavy** (user: "write a lot of integration tests"). System-tier tests against recorded stores, plus an opt-in live suite against the real `~/.claude`, `~/.codex`, `~/.local/share/opencode`. | The current bug class (a wrong assumption about where the prompt sits in a rollout) is only catchable against real shapes. |
| Scope default | Repository family across worktrees; toggles for this cwd / everywhere. | Upstream Claude Code already does this; the user works in 35 worktrees. |
| Children | Hidden by default, one toggle, count shown, grouped under parent in preview. | Half the newest rows are review workers. |
| Surfaces | One picker; PathPicker consumes the same rows; View Prompts and Rewind share the prompt reader. | Four surfaces disagreeing is the #96 failure. |
| Ledger | A durable Agent Code conversation ledger is **in scope** (Stage 3). | It is the only exact child classification going forward and the only way to show "Apollo · feat/x" after a pane closes. |
| Ordering | Last **user** activity, not file mtime. Attention scoring (#739) is a later stage on top of the same record. | A background agent writing tool output must not outrank the afternoon's session. |
| Search scope | Labels, names, first prompt, user prompts. Assistant text is out of scope. | Assistant search needs a real inverted index; nothing in the complaint asks for it. |
| PR #701 | Closed on approval of this document; `labelSource` adopted. | Its structure (identity flattened at the provider boundary) is replaced wholesale. |
| Prompt lists | Uncapped, relative time, main-side reader. | User request 2026-09-11. |

### 2.1 Scope: the repository family

A conversation belongs to the focused pane's family when its cwd satisfies any
of:

1. it equals the focused cwd (normalised: `path.resolve`, and on darwin a
   case-insensitive compare, because one transcript here records
   `~/Desktop/development/agent-code`);
2. it is one of `git worktree list --porcelain` paths for the focused cwd's
   repository (5 s timeout, cached per repo root for 60 s, empty on failure);
3. it is under the repository root's `.worktrees/` directory (a pruned worktree
   whose transcripts still exist);
4. for Claude only, the project dir name starts with the sanitized repo root
   followed by `-` (covers pruned worktrees and the 40 dirs observed here).

Rule 4 is deliberately Claude-specific: Codex and OpenCode record the literal
cwd, so rules 1–3 are exact for them.

### 2.2 Kinds (classification)

| Kind | Rule | Default |
|---|---|---|
| `user` | none of the below | shown |
| `orchestration-child` | ledger says so (Stage 3), else first real prompt starts with `<orchestration-handoff>` | hidden |
| `native-subagent` | Codex `thread_source = subagent` or a `thread_spawn_edges` child; OpenCode `parent_id` set; Claude never (subagents are not top-level files) | hidden |
| `exec` | Codex `source = exec` | hidden |
| `projected` | first user record is a `# Handoff Summary` / `# Portable handoff summary` written by `agent-transcript-parser` (provider switch / duplicate), or Codex `originator = agent-transcript-parser` | shown, labelled "continued from <provider>" |
| `empty` | no user prompt anywhere and no title (the 0-byte transcript here) | hidden |

### 2.3 Label ladder (one order, all providers), with provenance

```
agent-code-title   user-set title from the ledger
provider-name      Claude customTitle, Codex name, OpenCode user-edited title
ai-title           Claude aiTitle; OpenCode auto title
first-prompt       first REAL user prompt, after unwrapping
cwd                basename of the conversation's cwd     (marked fallback)
native-id          first 8 chars                          (marked fallback)
```

Codex `name` is only a `provider-name` when it is not a prefix of `title`: on
this machine every populated `name` observed for bringdown is Codex's own
truncation of the first prompt ("you have now premission to go about"), not a
user-chosen name. A `name` that merely repeats the title falls through to
`first-prompt`, which carries the untruncated text.

"Unwrapping" is a closed list, each entry proven by a fixture: `<stt note=…>…
</stt>` → inner text; `<orchestration-handoff>…<task>X</task>` → `X` (the child's
label is its task); `# AGENTS.md instructions for …`, `<environment_context>`,
`<command-name>…`, `<local-command-caveat>…`, `<local-command-stdout>…` → skip
to the next user prompt. A wrapper not in the list is not stripped; it falls
through to `cwd`, and the fixture that surfaces it is the signal to extend the
list.

### 2.4 Ordering

`lastUserActivityAt` = the newest of: Claude `history.jsonl` timestamp for the
session (or the last real user record in the tail window), Codex
`recency_at_ms` (falling back to the last user message timestamp in the tail),
OpenCode `time_updated`. Ties break on `createdAt`. File mtime is the last
resort and is recorded as such in the row's provenance so a test can assert it
was not the primary key.

### 2.5 Surfaces after the change

| Today | After |
|---|---|
| Palette `resume` mode | `Conversations` picker, opened by `Resume Session…` |
| `PromptSearchModal` | same picker with focus in the search field, opened by `Search Conversations…` |
| `PathPickerModal` `ResumeSection` | same rows, scope = typed path's family, provider filter = the modal's toggle |
| `ViewPromptsModal` (15 cap) | uncapped, relative time, `conversations:prompts` |
| `RewindToPromptModal` (15 cap) | uncapped, relative time, same reader; addresses unchanged |
| `nativeHistory.*` control capabilities | same catalog; `coverage.exhaustive` becomes true for scope-bounded lists |
| `session:list-all` (debug harness) | `conversations:list` with scope `everywhere` |

## 3. Stages

Each stage names what it produces, how it is verified without any later stage,
why it is separate, and what real evidence it is built from.

### Stage 0 — Recorded corpus and expectations

**Produces.** `scripts/extract-conversation-corpus.mts` and two outputs:

- `testing/fixtures/conversations/` (committed): a structure-preserving,
  redacted recording of this machine's stores for the agent-code repository
  family plus one unrelated project as a negative control. Per provider:
  - Claude: the project-dir inventory (names, sizes, mtimes), each transcript's
    first 40 and last 20 records, every `ai-title` / `custom-title` /
    `last-prompt` record, the `history.jsonl` slice for those sessions, and the
    `git worktree list --porcelain` output of the repo at capture time.
  - Codex: a fixture SQLite file built from `threads` and `thread_spawn_edges`
    rows for the family, plus the first 25 records of a sample of rollouts for
    the fallback path (including one `originator = agent-transcript-parser`
    rollout and one `source = exec`).
  - OpenCode: `session` and `project` rows for the family.
  - A `manifest.json` with the raw counts per store and kind, so a later stage
    can prove it dropped nothing.
- `testing/fixtures/conversations/local/` (git-ignored): the same extraction
  unredacted, for the live suite and for the author's eyes.
- `testing/fixtures/conversations/expectations.json`: hand-authored **with the
  user**, listing for the family every conversation's expected `kind`, expected
  `labelSource`, and the expected default order of the top 30. This is the
  human semantics the tests bless; it is not derived from the implementation.

Redaction rule (the policy is one file, `scripts/conversation-corpus-policy.ts`,
same shape as `worktree-live-fixture-policy.ts`): every string value is
replaced by `p:<sha8>:<len>` **except** an allowlist of structural keys
(`type`, `role`, `source`, `thread_source`, `agent_role`, `originator`,
`permissionMode`, `isMeta`, `isSidechain`, `cwd`, `project`, `gitBranch`,
`git_branch`, `timestamp`, ids, paths under `$HOME` rewritten to `~`) and a
closed list of **wrapper prefixes** kept verbatim for their first 40 characters
(`<orchestration-handoff>`, `<stt note=`, `<command-name>`,
`<local-command-caveat>`, `<local-command-stdout>`, `# AGENTS.md instructions
for`, `<environment_context>`, `# Handoff Summary`, `# Portable handoff
summary`). Label tests therefore assert `labelSource` and placeholder equality,
never readable text; the live suite asserts readable text locally.

**Verified by.** Running the extractor twice yields byte-identical output; a
corpus test checks manifest counts against the fixture contents; a policy test
asserts no value outside the allowlist survives unhashed (the same gate as
`check:worktree-live-fixtures`).

**Why separate.** The current listers were written against imagined shapes
(`event_msg/user_message` as the first prompt; a 16 KB byte head; `lastPrompt`
carrying text). Every one of those is false today. Without a recording the next
implementation repeats the mechanism.

**Reality check.** This machine's stores as of 2026-09-11: 371 Claude
transcripts (155 in the family), 2,020 rollouts / 2,007 index rows (1,133 in
the family), 507 OpenCode sessions.

### Stage 1 — Provider source adapters

**Produces.** `src/main/conversations/sources/{claude,codex,opencode}.ts`, each
exporting `discover(scope): Promise<SourceConversation[]>` and
`prompts(nativeId): Promise<Prompt[]>`, where `SourceConversation` is the raw,
provider-shaped ingredients (ids, cwd, titles, first real prompt, timestamps,
provenance flags, parent links, `origin: 'index' | 'scan'`). No labels, no
ordering, no classification: those are Stage 2.

- **Claude.** Family resolution per §2.1; per transcript one `stat`, a
  record-bounded head read (until the first real user prompt or 200 records;
  never a byte cap, which is what broke Codex in #718) and a tail read for
  `ai-title`, `custom-title` and the last user timestamp; `history.jsonl` loaded
  once per process and extended by byte offset (append-only) for prompt search
  and prompt counts.
- **Codex.** `node:sqlite` `DatabaseSync` read-only on the newest
  `~/.codex/state_*.sqlite`; the required column set is probed with
  `pragma table_info` and a missing column downgrades the adapter to the
  fallback (the existing `listCodexSessions` rollout scan, bounded to the
  family) with the downgrade reason surfaced in the row provenance. The index
  and the files are unioned: index rows whose `rollout_path` is gone are kept
  only if the file check fails, marked `unavailable`; rollouts absent from the
  index (the 22 pre-index files) come from the scan. Prompts for a row come
  from the moved incremental folder over the rollout tail.
- **OpenCode.** `node:sqlite` read-only on `opencode.db`; fallback
  `opencode session list --format json` in the cwd. Prompts via the existing
  transcript adapter export.

**Verified by.** System tests (`*.system.test.ts`) pointing each adapter at a
temp `HOME` populated from the Stage 0 fixtures, asserting: exact membership
against the manifest; every field the ladder needs is present where the
fixture has it; the fallback path returns the same membership as the index for
the sampled rollouts; the case-variant cwd matches; the family includes the
pruned-worktree dirs. The live suite (§5) runs the same assertions against the
real stores and records timings.

**Why separate.** Each store has its own failure modes (WAL busy, schema bump,
deleted files, byte-vs-record framing). Normalising inside the adapter would
hide which side is wrong when two sources disagree about one conversation.

**Reality check.** Stage 0 corpus; the upstream listers
(`vendor/claude-code-src/full/utils/listSessionsImpl.ts`,
`vendor/codex-src/codex-rs/rollout/src/list.rs`) for the providers' own rules.

### Stage 2 — The catalog (the isolated hard part)

**Produces.** `src/main/conversations/catalog/`: pure functions from
`SourceConversation[]` (+ ledger rows from Stage 3, optional) to
`Conversation[]`:

```
normalize   → one record shape for all providers
classify    → kind per §2.2
label       → { text, source } per §2.3
scope       → cwd | repo | everywhere
order       → §2.4
search      → query over label, name, first prompt, prompts; match spans
page        → cursor pagination; hidden-children count per page
```

and the single consumer, `src/main/conversations/service.ts`, which owns the
cache (per family, invalidated by store mtimes) and the IPC handlers.

**Verified by.** Unit tests against Stage 0 fixtures and `expectations.json`:
membership equals manifest minus hidden kinds (nothing dropped, nothing
duplicated); order equals the expected top 30; every `labelSource` matches;
each unwrapping rule has a fixture that fires it and one that must not; search
returns the expected sessions for recorded queries. A property test: for any
subset of the fixture, `classify` and `label` are total (never throw, never
return an empty label).

**Why separate.** Classification, labelling and ordering are exactly where the
three sources disagree. Spread across surfaces they fight each other and the
result looks like a rendering bug (#96). One owner, one record.

**Reality check.** Stage 0 corpus and the user-authored expectations.

### Stage 3 — Agent Code conversation ledger

**Produces.** `src/main/conversations/ledger/`: an append-only JSONL under
`STATE_DIR/conversations/ledger.jsonl` keyed `provider:nativeId`, with events
`seen` (cwd, kind, local session id), `title`, `name`, `orchestration` (parent
native id, root, run id, role), `closed` (by user or by exit). Written by main
from the workspace autosave it already receives (`WorkspaceFileStore`), so the
renderer learns nothing new; the ledger is the durable per-conversation
projection of state the workspace already holds. Compacted to a snapshot on
boot when it exceeds a line budget. Read by Stage 2 to make child
classification exact and to supply the top label rung and the spoken name.

**Verified by.** System tests: a workspace save with a titled, named
orchestration child produces the rows; a second save changes only what changed;
the file survives a simulated restart and a truncated last line; the catalog
prefers the ledger over the prompt sniff for the same native id.

**Why separate.** It is a write path on the session lifecycle with its own
durability rules, and it must never be required for the read path to work
(historical transcripts predate it).

**Reality check.** `SessionMeta` fields listed in §1; the `<orchestration-handoff>`
sniff as the historical fallback (16/57 and 9/16 observed).

### Stage 4 — One IPC surface and one picker

**Produces.** `conversations:list`, `conversations:search`,
`conversations:prompts`, `conversations:children` in
`src/main/ipc/conversations.ts` + `src/preload/api/conversations.ts` with types
in `src/shared/conversations/types.ts` (one definition, no preload copy).
Renderer `src/renderer/src/features/conversations/`: the picker (list, filters,
children toggle with count, search with highlighting, preview via the existing
`SessionPreviewPane`, keyboard model per `docs/command-style.md`), the shared
row, and the uncapped prompt list used by View Prompts and Rewind. Every row
shows a relative time from `lastUserActivityAt` and the prompt count from the
catalog; the preview header takes its turn count from the same row instead of
counting its own 40-record tail window, which is how a long planning session
reads "1 turn" today. Commands
`Resume Session…` and `Search Conversations…` open it; `PathPickerModal`
consumes the rows; `nativeHistory.*` and `session:list-all` are re-pointed.

**Verified by.** Renderer tests for rows, filters, toggle counts, keyboard and
resume dispatch (provider and cwd come from the row, never from the focused
pane); a system test that drives the IPC handlers end-to-end over the Stage 0
temp `HOME`; the existing `session.test.ts` evidence contract (#718) re-homed
onto the new channel; the `check:keybindings` gate for any new chord.

**Why separate.** UI must not be the place where identity, scope or ordering is
decided; it renders what the catalog says, and a second opinion in the UI is the
bug this rebuild removes.

**Reality check.** The three current surfaces' JSX and the review notes on #96
(provider scope change, provenance, useful dates, readable-vs-resumable).

### Stage 5 — Deletion and locks

**Produces.** Removal of everything listed under "App code that is the
problem" in §1, `MainProviderConfig` without listing slots, PR #701 closed,
issues #96/#151/#718/#735/#773 closed by the PR, #739 updated with what landed
(ordering) and what remains (attention score). Regression locks: the #718
shape (a `session_meta` line larger than 16 KB) and the #735 shape (a live
transcript re-read in full) become fixtures in the corpus, not special tests.

**Verified by.** `npm run typecheck` on both projects, the full suite, and a
grep for imports of the deleted modules in the PR (no CI lock).

**Why separate.** Deleting before the new surface is proven leaves the app
without a picker; deleting after, in its own commit, keeps the diff reviewable.

## 4. What is being isolated

The hard part is the **catalog** (Stage 2): the one place that reconciles three
provider stores, the ledger, and the user's scope into one ordered, labelled,
classified list.

- Lives in `src/main/conversations/catalog/`, pure, no I/O.
- Single consumer: `src/main/conversations/service.ts`.
- Forbidden importers (asserted by an `importBoundaries`-style test in the same
  PR, matching the repo's existing pattern rather than a new lint):
  `src/renderer/**` (it receives `Conversation` over IPC only),
  `src/providers/**`, `src/control-sdk/**`, `src/main/sessionManager.ts`,
  `packages/**`. The sources (Stage 1) may not import the catalog either;
  data flows one way: sources → catalog → service → IPC → picker.

## 5. Tests and fixtures (the user asked for a lot of integration tests)

Tiers follow `docs/testing/standard.md`:

- `*.test.ts` (unit): catalog rules against Stage 0 fixtures and expectations.
- `*.system.test.ts` (integration, serial): temp `HOME` built from the fixture
  corpus with a real `git init` + `git worktree add` so family resolution runs
  the real `git worktree list`; each adapter, the service, the IPC handlers and
  the ledger exercised end-to-end. These are the bulk of the new tests.
- `*.live.test.ts` (opt-in, `AGENT_CODE_LIVE_CONVERSATIONS=1`): runs the
  adapters and the catalog against the developer's real stores, asserts the
  local manifest counts, the readable labels the user recognises, and the
  timing budget in D6. Never in `npm test`.
- Renderer tests for the picker and the prompt list.

No global retry, no snapshots of markup, no test that restates the
implementation. A failing test against a recorded fixture is a finding, not a
test to adjust.

## 6. Unknowns (not yet enumerated; each is a Stage 0 or Stage 1 question)

1. `state_N.sqlite` schema drift: which columns are stable across Codex
   versions; the adapter probes and downgrades, but the probe list itself is a
   guess until two Codex versions have been observed.
2. Whether `recency_at_ms` means last user turn or last any-write in Codex;
   decides the ordering source for Codex rows.
3. Whether `preview` is ever non-empty when `title` is a wrapper; decides
   whether the Codex label needs the unwrapping list at all.
4. `thread_items.item_type` values in `thread_history_1.sqlite`; decides
   whether Codex prompt search can come from the index instead of rollout
   tails.
5. `codex exec` runs: 373 in agent-code. Presumed to be workflow-mcp and
   provider-switch probes; if some are user-driven `codex exec` sessions the
   user wants to resume, the `exec` kind must not be hidden by default.
6. Claude `last-prompt` records in older CLI versions may carry `lastPrompt`
   text; the tail reader must accept both shapes.
7. OpenCode `session.directory` for worktrees and whether `project.worktree`
   is the repo root; decides OpenCode family resolution.
8. `node:sqlite` in Electron 43 (Node 24.18) prints an experimental warning
   once per process; the suppression must not hide other warnings.
9. SQLite `SQLITE_BUSY` under WAL while Codex is writing: expected to be
   absent for readers, but unverified under a live `codex exec` burst.
10. Claude transcripts that the 30-day cleanup deletes while the picker is
    open; the row must degrade to "unavailable" rather than error on resume.
11. Sibling checkouts of the same repo outside the root
    (`../agent-code-pr-merge-audit`, `../agent-code-cluster-worktrees/*`): they
    are in `git worktree list`, so rule 2 covers them while they exist; after
    removal only Claude's rule 4 does. Whether the user wants them at all.
12. The remote (phone) client lists live sessions only today; whether it
    should get the picker is out of scope and noted.
13. The exact chord and command titles; `check:keybindings` is not a proof a
    chord is free.

This list is not empty on purpose. Stage 0 answers 2, 3, 4, 6, 7; Stage 1
answers 1, 8, 9; the user answers 5, 11.

## 7. Fixture plan

| Fixture | Produced by | Consumed by |
|---|---|---|
| `testing/fixtures/conversations/claude/**` (redacted heads, tails, title records, history slice, worktree list) | Stage 0 extractor | Stage 1 claude adapter tests, Stage 2, Stage 4 system test |
| `testing/fixtures/conversations/codex/threads.sqlite` + rollout head samples | Stage 0 extractor | Stage 1 codex adapter tests (index and fallback), Stage 2 |
| `testing/fixtures/conversations/opencode/opencode.sqlite` | Stage 0 extractor | Stage 1 opencode adapter tests, Stage 2 |
| `testing/fixtures/conversations/manifest.json` | Stage 0 extractor | every membership assertion |
| `testing/fixtures/conversations/expectations.json` | user + author, by hand | Stage 2 order/kind/label tests |
| `testing/fixtures/conversations/local/**` (unredacted, git-ignored) | Stage 0 extractor | live suite only |
| Ledger event samples | Stage 3 tests write them from workspace saves | Stage 2 ledger-join tests |

Regeneration is explicit (`UPDATE_FIXTURES=1 npm run extract:conversations`)
and leaves a reviewable diff, per the testing standard.

## 8. Questions the user answered (2026-09-11, "go with the defaults")

1. Unknown 5: `codex exec` runs are **hidden with the children** by default;
   the toggle reveals them.
2. Unknown 11: sibling checkouts outside the repo root **count as this
   repository while `git worktree list` knows them**; after removal only the
   Claude sanitized-dir rule keeps their transcripts in the family.
3. Command naming: **keep `Resume Session…`, rename `Search Conversation
   Prompts` to `Search Conversations…`**, both opening the same picker.
