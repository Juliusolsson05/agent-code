# Rendering residue plan — 2026-07-07

What remains after the ownership-ledger rewrite cleared the correctness
backlog. Source of truth for the findings: the four investigation reports in
`research-2026-07/` (`plan-queue-dispatch.md`, `plan-json-tool-rows.md`,
`plan-subagent-task-rows.md`, `plan-opencode-rows.md`), each produced by
reading the actual debug bundles (notes, `html-clean.html`,
`proxy-semantic.json`, state snapshots), the on-disk transcripts, git/PR
archaeology, and the pipeline on `integration/rendering-pipeline`.

Context: all 46 saved debug bundles are triaged (0 untriaged, 0 new-bug);
every ownership/ordering complaint in the bundle notes is fixture-locked.
What's left splits into ONE root-cause runtime bug, ONE pre-cutover pipeline
blocker, and THREE row-presentation workstreams.

---

## P0 — the tailer unwatch bug (the haunted-queue / dead-channel root cause)

**Finding** (`plan-queue-dispatch.md`, mechanism-verified with a standalone
Node repro + on-disk rollout forensics): `FileTailer.close()` calls
`unwatchFile(this.filePath)` **without the listener argument** in BOTH
`packages/codex-headless/src/transcript/JsonlTailer.ts:239` and
`packages/claude-code-headless` (:256). Node semantics: that removes ALL
stat-watchers for the path, process-wide. `replaceSession`
(`workspace/hook/actions/session.ts` — reload, provider switch, resume,
rewind all funnel through it) spawns the new session BEFORE killing the old
one; on an in-place resume both tail the same rollout file, so the old
session's close deterministically kills the new pane's watcher. Every time.
Not a race.

Downstream this explains the dominant historical complaint class end to end:
committed tail dies → prompts written to the rollout (12ms after submit in
the 06-24 bundle) are never ingested → the queued placeholder's only
conversion path (committed user-row match) never fires → every subsequent
submit also queues → "prompt stuck in queue and does not make it to a user
message". The prompt always reached the model; the transcript tail was dead.
`lastJsonlEntryAt` 88 minutes stale with `streamPhase: requesting` is the
fingerprint.

**Fix (three PRs):**
1. `codex-headless`: store the stat listener; `unwatchFile(path, listener)`.
   Plus a 15s tail-stall watchdog: file size > offset with no emit ⇒ emit
   `tail-stalled` diagnostic and re-arm (self-healing + bundle-visible).
   Unit test: two tailers on one path, close A, assert B still emits —
   fails today, passes with the fix.
2. `claude-code-headless`: identical fix + test.
3. `agent-code`: submodule bumps + observability — `committedTailAgeMs` and
   `queueReason` on the `optimistic_user_queue` feed-debug entry; tail
   diagnostics (`{file, tailOffset, fileSize, lastEmitAt}`) in debug-bundle
   snapshots so the NEXT stall is diagnosable from a bundle alone.

Do NOT reorder `replaceSession` and do NOT weaken the #239 queue gate — both
are correct once the unwatch is scoped.

**Why P0:** it's a live data-loss-shaped bug in daily use, independent of the
rewrite, and its fingerprint contaminates any rendering soak (a dead tail
looks like a rendering bug — that's literally what most of the May/June
bundle notes were).

## P0b — task-notification vs the synthetic-user filter (pre-cutover blocker)

**Finding** (`plan-subagent-task-rows.md`): committed `<task-notification>`
entries are `type:"user"`, text starts `<`, no `permissionMode` — the new
pipeline's #338 `isSyntheticClaudeUserRow` filter will silently swallow them
at cutover. They are the ONLY carrier of background-task results (subagents
AND background Bash — verified `<tool-use-id>` in real transcripts). Legacy
paints them (badly, as raw-XML user bubbles) but does not LOSE them.

**Fix (integration branch, ~32 LOC + fixtures):** detect task-notification
shape in `observations/committed.ts` BEFORE the synthetic filter; dedicated
decision reason `task-notification-joined` (candidate carries the parsed
`toolUseId` so the view can join it to its parent Task row); fixtures
extracted from bundles 42071335 / 1b2b5e96 via the corpus machinery. Until
the row UI (P2) exists, the candidate stays visible as an entry row — never
silently dropped.

## P1 — generic JSON / MCP tool row (`plan-json-tool-rows.md`)

The most-repeated feature ask (4 bundles). One shared `JsonToolRow` fallback
in `src/providers/shared/renderer/rows/`: prettified MCP names
(`mcp__s__t` → `t` + `MCP · s` badge), unified smart headline (path keys
before description — also fixes a real bug: `headlineForTool` in
`CodexRows.tsx:164` hides file paths behind descriptions), collapsed
pretty-JSON params via the existing `CodeBlock language="json"`, key-value
top-level rendering with path/URL linkification, result slab that unwraps
the MCP text envelope and codex Wall-time wrapper, error styling preserved.

Dispatch: the shared feed fallback in `Block.tsx`
(`providerRow ?? <JsonToolRow/>`); codex's `renderCodexToolUse` stops
claiming unknown names so all three providers converge on one
registry-blessed fallback. NOT gated behind `customRendering` (that flag
gates git-widget interception, not fidelity). Lands NOW against the legacy
row path; survives cutover because the view bridge re-emits legacy
FeedRenderItems; only ~35 lines of BlockRow live-path glue are throwaway.
~2 new files (~360 LOC) + 6 edits; tests from the 4 bundles' real payloads.

## P2 — subagent / Task / notification / AskUserQuestion rows (`plan-subagent-task-rows.md`)

Archaeology verdict: PRs #277/#292 never regressed — the 06-21 "horrible"
session used MCP orchestration tool names the card dispatch never matched
(zero cards despite 73 tracked subAgents), task-notifications have zero
handling anywhere in `src/`, and #341 (stale-running lifecycle) is real and
open (57/73 stuck running, turnCount 3036, double-counted toolCalls).

Sequenced (~560 LOC total, all pre-cutover on main, survives via the bridge):
- **P2a** lifecycle fix (#341, ~130 LOC, `src/main/subagents/`): codex
  terminal inference from `wait_agent` output / child exit / inactivity;
  prune `SubAgentWatcher.metaByAgent`; fix double-counting.
- **P2b** notifications (~315 LOC): parse `<task-notification>` (carries
  `<tool-use-id>`), join into the parent Task row, suppress the raw bubble
  pre-LazyEntry (no more spacer walls), compact `TaskNotificationRow` when
  no parent visible, QueueStrip one-line chip for queued ones. Kills both
  06-29 complaints.
- **P2c** Task row v2 (+45): eligibility via shared `isAgentSpawnToolName`
  (+ MCP orchestration names) or `subAgents[toolUseId]` presence; status by
  evidence priority (notification → parent tool_result / `wait_agent`
  output → live watcher → "starting…"); a STALE visual state instead of
  eternal spinners.
- **P2d** AskUserQuestion committed-plane row (+70): answered-question
  rendering via tool_use+tool_result join; ledger fixture guaranteeing the
  unresolved picker survives cutover un-collapsed.

## P3 — opencode row dispatch (`plan-opencode-rows.md`)

Half the 07-06 complaints are ALREADY fixed by landed work (reasoning/answer
separation, stuck `Sending·41s`, blockless-text mid-word split, duplicate
user rows) — add verification fixtures, not code. Remaining gaps are thin:
lowercase tool names missing from `renderOpencodeToolUse` dispatch (reuse
Claude rows — the mapper already emits Claude shape; NO tool renaming, names
are resume identity), `glob` headline probing `path` before `pattern`,
a real `read`-result parser (the one genuinely new row), `todowrite` result
suppression under the already-rendered checklist, fold-layer + git-widget
lowercase aliases, CRLF-tolerant optimistic reconciliation, and downgrading
the "transcript unavailable: Ignored JSONL…" banner for expected child-
session bursts. Post-cutover only: task-subagent lifecycle rendering and the
`question` row.

## Sequencing & where things land

| Order | Item | Repo/branch | Size |
|---|---|---|---|
| 1 | P0 tailer fix + watchdog | codex-headless, claude-code-headless, then agent-code bump | small, 3 PRs |
| 2 | P0b notification-vs-filter | integration/rendering-pipeline | ~32 LOC + fixtures |
| 3 | P1 JsonToolRow | main (survives cutover) | ~450 LOC |
| 4 | P2a→P2d subagent chain | main (P2 int-branch fixtures alongside) | ~560 LOC |
| 5 | P3 opencode dispatch | main | ~200 LOC |
| — | Stage-3 cutover | integration → main (#442) | after soak |

P0/P0b are ordered before the soak on purpose: P0 removes the class of
"rendering bug" reports that are actually tail death, and P0b removes the
one known way the cutover could lose data. The row work (P1–P3) is
cutover-independent by construction — everything renders through components
the view bridge already targets.

## Test strategy

Same corpus discipline that cleared the correctness backlog: every fix ships
with fixtures derived from the bundle that reported it (payloads from
`proxy-semantic.json`, expected shapes hand-reduced), unit tests inside the
existing suites, and — for the submodule tailer fix — unit tests in the
submodule repos so agent-code stays free of new test files per repo policy.
