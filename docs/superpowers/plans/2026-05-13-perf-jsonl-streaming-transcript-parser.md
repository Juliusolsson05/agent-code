# Perf: stream JSONL transcript parsing in WorktreeActivityIndex

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop allocating whole transcript files as Buffers/strings during the 60 s background `WorktreeActivityIndex` refresh by replacing `readFile + split('\n') + map(JSON.parse)` with `createReadStream + readline.createInterface`. Target: drop the 60-second background spike pattern (currently 100–200 MB transient peak per refresh) to <1 MB transient peak per parsed transcript.

**Architecture:** Introduce one tiny shared streaming helper (`streamJsonl`) that mirrors the existing pattern in `src/main/ghostJournal.ts:244` (createReadStream + readline.createInterface for line-by-line async iteration). Refactor `src/main/worktreeActivity/transcriptParser.ts` to use it. No other behavior changes. No on-disk format changes. No new dependencies. No new tests (per repo convention `feedback_no_test_bloat`); rely on existing `test:worktree-activity` to confirm parity.

**Tech Stack:** Node.js `fs` (createReadStream), `readline` (createInterface), TypeScript 5.5, electron-vite build pipeline.

**Out of scope (separate future PR):**
- Streaming the 30 MB `worktree-activity-index.json` file in `indexStore.ts`. That file is a single JSON object, not JSONL — streaming requires either a JSON-stream parser dependency or a format migration shim. Documented as a TODO in this plan's final task.
- Changes to `sessionIndex.searchSessionPrompts` and `historyLoader.readTranscriptEntries` whole-file reads. Same pattern, separate PR each.

---

## File Structure

| File | Role | New / Modified |
|---|---|---|
| `src/shared/runtime/streamJsonl.ts` | One exported async-iterable function `streamJsonl<T>(path)` that yields parsed JSONL objects line-by-line, holding at most one line in memory at a time. Documentation explains when to use this vs `FileTailer` (one is for static reads, the other is for live-growing files). | **Create** |
| `src/main/worktreeActivity/transcriptParser.ts` | Replace the `readFile + split` body of `parseTranscriptForActivity` with a `for await (line of streamJsonl(...))` loop. Same `IndexedTranscript` output shape. Same error semantics (malformed lines are skipped, not thrown). | **Modify** (lines 1, 22, 26–36) |

That's it. Two files. The branch is `feat/perf-jsonl-streaming-transcript-parser`. Worktree at `.worktrees/perf-jsonl-streaming`.

---

## Why these decisions

- **Why a NEW shared utility instead of inlining**: future PRs (sessionIndex, historyLoader) will need the same primitive. Having one canonical implementation prevents three slightly-different streaming loops drifting apart over time, and makes the "this is what 'stream JSONL' means in this codebase" answer obvious to future-me.
- **Why `src/shared/runtime/`**: that's where `jsonlTailer.ts` lives — the runtime/ subfolder is the documented home for Node-only runtime helpers shared between main and the headless packages. Co-locating with the existing tailer makes the relationship visible.
- **Why not pull a streaming-JSON dependency** (e.g. `clarinet`, `JSONStream`): for line-delimited JSONL the stdlib `readline.createInterface` is enough and matches the style we already use in `ghostJournal.ts`. Pulling a parser would be over-engineering.
- **Why no new tests**: per saved repo convention (`MEMORY.md` → "Don't add new tests in feature/fix PRs"). The behavior is verified by `npm run test:worktree-activity`, which exercises `parseTranscriptForActivity` indirectly through `loadEntryFromDisk` round-trips. If that test passes before and after the change, parity is confirmed.
- **Why we stop here, not also fix `indexStore.ts`**: that file's on-disk format is single-JSON, not JSONL. Migrating to JSONL is a useful follow-up but introduces a format migration that this PR shouldn't bundle.

---

## Tasks

### Task 1: Set up the worktree

**Files:**
- Create: `.worktrees/perf-jsonl-streaming/` (new worktree)
- Reference: `.worktrees/dead-code-sweep-v2/` (template for setup pattern)

- [ ] **Step 1: Create the worktree off current `main`**

```bash
git worktree add /Users/juliusolsson/Desktop/Development/agent-code/.worktrees/perf-jsonl-streaming \
  -b feat/perf-jsonl-streaming-transcript-parser main
```

Expected: `Preparing worktree (new branch 'feat/perf-jsonl-streaming-transcript-parser')` and `HEAD is now at <main-head> Merge pull request ...`

- [ ] **Step 2: Symlink `node_modules` from the main checkout to skip a fresh `npm install`**

```bash
ln -s /Users/juliusolsson/Desktop/Development/agent-code/node_modules \
  /Users/juliusolsson/Desktop/Development/agent-code/.worktrees/perf-jsonl-streaming/node_modules
```

WHY a symlink: the worktree shares the same `package.json` as main, and `electron-rebuild` is a heavy `postinstall` step we don't want to repeat. This is the standard pattern used in prior worktrees in this repo.

- [ ] **Step 3: Initialize submodules in the worktree**

```bash
cd /Users/juliusolsson/Desktop/Development/agent-code/.worktrees/perf-jsonl-streaming && \
  git submodule update --init --recursive
```

Expected: clones each of the 5 submodules (`agent-transcript-parser`, `agent-voice-dictation`, `claude-code-headless`, `codex-headless`, `vendor/codex-src`) and checks out the pinned commits. Without this step `npm run build:app` fails with `ENOENT: no such file or directory, copyfile '.../packages/claude-code-headless/src/testing/proxy-testing/mitmAddon.py'`.

- [ ] **Step 4: Verify clean baseline tests**

```bash
cd /Users/juliusolsson/Desktop/Development/agent-code/.worktrees/perf-jsonl-streaming && \
  npm run test:worktree-activity
```

Expected: `npm run test:worktree-activity` exits 0 with terminal output ending in success (the script prints test results from `scripts/test-worktree-activity-index.ts`).

If it fails: STOP. Do not proceed — investigate the pre-existing failure before adding changes.

- [ ] **Step 5: Verify clean baseline build**

```bash
cd /Users/juliusolsson/Desktop/Development/agent-code/.worktrees/perf-jsonl-streaming && \
  npm run build:app
```

Expected: ends with `✓ built in <N>s`. No errors.

---

### Task 2: Create the shared `streamJsonl` utility

**Files:**
- Create: `src/shared/runtime/streamJsonl.ts`

- [ ] **Step 1: Write the new file**

Create `/Users/juliusolsson/Desktop/Development/agent-code/.worktrees/perf-jsonl-streaming/src/shared/runtime/streamJsonl.ts` with this exact content:

```ts
import { createReadStream } from 'fs'
import { createInterface } from 'readline'

// Stream a JSONL file as an async iterable of parsed objects, holding
// at most one line in memory at a time.
//
// WHY this exists: the obvious `readFile(path, 'utf8').then(t =>
// t.split('\n').map(JSON.parse))` pattern is the dominant source of
// transient memory spikes in this app's main process. For a 50 MB
// transcript that pattern transiently keeps four representations live:
// a 50 MB Buffer, a 50 MB JS string, a 50 MB-ish array of substrings,
// and the array of parsed JS objects. Total transient peak ~150-200
// MB per call. Replaced with this helper, the peak per call is
// O(longest_line), which for our JSONL transcripts is typically
// <100 KB even for large tool_use entries.
//
// WHY a yielded `null` for malformed lines instead of `throw`: the
// historical behaviour in transcriptParser was `try { JSON.parse } catch
// { continue }` — malformed lines are skipped silently because partial
// writes happen mid-append and recovering from them is normal. Callers
// here filter out nulls themselves, which keeps the parse error visible
// at the call site (matches the existing pattern instead of hiding it
// inside this helper).
//
// WHY no transform/yield-shape variant: YAGNI. If a future caller wants
// to map-while-streaming they can `for await (const line of streamJsonl)
// yield mapped(line)` in their own async generator.
//
// NOT a tailer: this helper opens the file at a snapshot of its current
// size and yields once. For live-growing files use FileTailer in
// `jsonlTailer.ts`, which tracks offsets and re-reads on chokidar/poll
// events.
export async function* streamJsonl<T = unknown>(
  path: string,
): AsyncIterable<T | null> {
  const stream = createReadStream(path, { encoding: 'utf8' })
  // crlfDelay: Infinity makes readline treat \r\n as a single line
  // terminator (Windows-authored files are uncommon for our transcripts
  // but the flag is the documented best-practice default).
  const rl = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of rl) {
      if (!line.trim()) continue
      try {
        yield JSON.parse(line) as T
      } catch {
        // Malformed JSONL line — partial appends, truncated lines, or
        // pre-existing junk in archived transcripts. Yield null so the
        // caller can either skip-and-continue (current behaviour) or
        // count parse errors for diagnostics if they want to.
        yield null
      }
    }
  } finally {
    // Ensure the underlying file descriptor closes even if the caller
    // breaks out of the loop early. readline closes its own internal
    // state when iteration ends; we still close the stream explicitly
    // because the readline contract doesn't guarantee FD closure on
    // async-iterator break.
    rl.close()
    stream.close()
  }
}
```

- [ ] **Step 2: Verify it compiles standalone**

```bash
cd /Users/juliusolsson/Desktop/Development/agent-code/.worktrees/perf-jsonl-streaming && \
  npx tsc --noEmit -p tsconfig.web.json 2>&1 | grep -v "TS6305\|in 'tsconfig.web.json'\|in the program because\|Matched by include\|^$" | head -20
```

Expected: empty output (no real errors — `TS6305` noise from stale `.tsc-out/` is filtered out, as in PR #84).

- [ ] **Step 3: Commit the helper as its own commit**

```bash
cd /Users/juliusolsson/Desktop/Development/agent-code/.worktrees/perf-jsonl-streaming && \
git add src/shared/runtime/streamJsonl.ts && \
git commit -m "$(cat <<'EOF'
Add shared streamJsonl utility for line-by-line JSONL reads

The dominant source of transient memory spikes in the main process is
the `readFile(path, 'utf8') + split('\n') + map(JSON.parse)` pattern
used in several JSONL-reading sites. For a 50 MB transcript the
pattern transiently keeps a 50 MB Buffer, a 50 MB string, a 50 MB
array of substrings, AND the parsed JS objects all live at once.

This helper wraps the existing createReadStream + readline pattern
already used in ghostJournal.ts so callers can replace those whole-file
reads with a one-line-at-a-time async iterable. Peak transient memory
drops from O(file_size) to O(longest_line).

Used by the next commit in this branch. Future commits should be able
to reuse this in sessionIndex and historyLoader the same way.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

Expected: commit succeeds with one file changed (+50 / -0 ish).

---

### Task 3: Refactor `transcriptParser.ts` to use `streamJsonl`

**Files:**
- Modify: `src/main/worktreeActivity/transcriptParser.ts` (lines 1, 22, 26–36)

- [ ] **Step 1: Read the current contents**

```bash
cd /Users/juliusolsson/Desktop/Development/agent-code/.worktrees/perf-jsonl-streaming && \
  cat src/main/worktreeActivity/transcriptParser.ts
```

Expected: the 61-line file beginning `import { readFile } from 'fs/promises'`. Confirm it matches what you expect before editing.

- [ ] **Step 2: Replace the whole file with the streaming version**

Use Write or Edit to make `src/main/worktreeActivity/transcriptParser.ts` exactly this:

```ts
import type {
  WorktreeActivityEvent,
} from '@shared/work-context/types.js'
import {
  extractWorktreeActivityEvents,
} from '@shared/work-context/extractors.js'
import { streamJsonl } from '@shared/runtime/streamJsonl.js'
import type {
  IndexedTranscript,
  TranscriptCandidate,
} from '@main/worktreeActivity/types.js'

export async function parseTranscriptForActivity(
  candidate: TranscriptCandidate,
): Promise<IndexedTranscript> {
  // This parser stores only compact worktree facts, never rendered
  // transcript content. That keeps the persisted index small and keeps
  // privacy/blast-radius sane: the raw Claude/Codex JSONL files remain
  // where the providers wrote them, while Agent Code stores enough
  // metadata to answer workspace orchestration questions quickly.
  //
  // WHY streaming instead of `readFile(...).then(t => t.split('\n'))`:
  // this function is called once per transcript inside the
  // WorktreeActivityIndex 60s background refresh loop. With heavy
  // users carrying 5+ MB transcripts, the whole-file pattern allocated
  // 3-4x the file size transiently (Buffer + string + split array +
  // parsed objects), producing the 100-200 MB spike pattern visible in
  // the system-perf popover every ~60 seconds. Streaming line-by-line
  // drops the transient peak to one line at a time (~tens of KB even
  // for large tool_use entries) at no semantic cost.
  const events: WorktreeActivityEvent[] = []
  let discoveredCwd = candidate.cwd

  for await (const raw of streamJsonl<Record<string, unknown>>(candidate.file)) {
    // streamJsonl yields null for malformed lines (partial writes,
    // truncations). Skip them — matches the prior catch-and-continue.
    if (raw === null) continue
    if (!discoveredCwd) discoveredCwd = extractCwd(raw)
    events.push(...extractWorktreeActivityEvents(raw, candidate.mtimeMs))
  }

  return {
    ...candidate,
    cwd: discoveredCwd,
    indexedAt: Date.now(),
    events: events
      .filter(event => event.path)
      .map(event => ({
        path: event.path,
        branch: event.branch,
        ts: event.ts,
        kind: event.kind,
        source: event.source,
        primaryWeight: event.primaryWeight,
      })),
  }
}

function extractCwd(raw: Record<string, unknown>): string {
  if (typeof raw.cwd === 'string' && raw.cwd.length > 0) return raw.cwd
  const payload = raw.payload as Record<string, unknown> | undefined
  if (typeof payload?.cwd === 'string' && payload.cwd.length > 0) return payload.cwd
  return ''
}
```

Diff from current:
- Line 1 removed: `import { readFile } from 'fs/promises'`
- New import added: `import { streamJsonl } from '@shared/runtime/streamJsonl.js'`
- Lines 22 (the `readFile`) and 26 (the `for (const line of text.split('\n'))`) replaced by a single `for await (const raw of streamJsonl<...>(candidate.file))` loop.
- The `JSON.parse` try/catch is gone because `streamJsonl` yields `null` on parse failure; the caller skips nulls (which preserves the original "skip malformed lines" semantics).
- The new WHY comment block (in the function body) documents the change.

- [ ] **Step 3: Verify the file typechecks**

```bash
cd /Users/juliusolsson/Desktop/Development/agent-code/.worktrees/perf-jsonl-streaming && \
  npx tsc --noEmit -p tsconfig.web.json 2>&1 | grep -v "TS6305\|in 'tsconfig.web.json'\|in the program because\|Matched by include\|^$" | head -20
```

Expected: empty output (no real errors).

- [ ] **Step 4: Run the existing worktree-activity test for parity**

```bash
cd /Users/juliusolsson/Desktop/Development/agent-code/.worktrees/perf-jsonl-streaming && \
  npm run test:worktree-activity
```

Expected: same success output as the baseline run in Task 1, Step 4. If the test now fails when it was passing before, STOP — the refactor changed behaviour. Investigate before committing.

- [ ] **Step 5: Run the broader test suite**

```bash
cd /Users/juliusolsson/Desktop/Development/agent-code/.worktrees/perf-jsonl-streaming && \
  npm run test:review-fixes
```

Expected: `settings coercion ok` / `prompt templates ok` / session-ownership exits silently with code 0. If anything fails, STOP.

- [ ] **Step 6: Run the production build**

```bash
cd /Users/juliusolsson/Desktop/Development/agent-code/.worktrees/perf-jsonl-streaming && \
  npm run build:app
```

Expected: `✓ built in <N>s` at the end, no errors.

- [ ] **Step 7: Confirm no `cc-shell` regressions**

```bash
cd /Users/juliusolsson/Desktop/Development/agent-code/.worktrees/perf-jsonl-streaming && \
  git diff main --no-color | grep -ic "cc-shell\|ccshell\|cc_shell"
```

Expected: `0`.

- [ ] **Step 8: Commit the refactor**

```bash
cd /Users/juliusolsson/Desktop/Development/agent-code/.worktrees/perf-jsonl-streaming && \
git add src/main/worktreeActivity/transcriptParser.ts && \
git commit -m "$(cat <<'EOF'
perf(worktree-activity): stream JSONL transcripts instead of readFile

parseTranscriptForActivity used to do
`readFile(path) → text.split('\n') → map(JSON.parse)` per transcript.
For a 50 MB Claude transcript that transiently kept the 50 MB Buffer,
50 MB JS string, the split-array of substrings (~50 MB), and the
parsed JS objects all live at once. With WorktreeActivityIndex's
60 s background refresh calling this for each candidate sequentially,
the per-tick peak was ~100-200 MB — visible in the system-perf
popover as a recurring spike-and-drop pattern every minute,
suspected primary cause of recent main-process OOMs.

Switching to streamJsonl drops the transient peak to one line at a
time. Same output shape (IndexedTranscript), same malformed-line
behaviour (silently skip), same call site contract. Verified
test:worktree-activity passes unchanged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

Expected: commit succeeds with one file changed (+15 / -8 ish).

---

### Task 4: Push and open the PR

**Files:** none

- [ ] **Step 1: Confirm we're on the right GitHub account**

```bash
gh auth status 2>&1 | head -6
```

Expected: `Active account: true` next to `Juliusolsson05`. If the active account is `Julius-o1`, switch with `gh auth switch -u Juliusolsson05` BEFORE pushing (per saved memory `reference_gh_account`).

- [ ] **Step 2: Push the branch**

```bash
cd /Users/juliusolsson/Desktop/Development/agent-code/.worktrees/perf-jsonl-streaming && \
git push -u origin feat/perf-jsonl-streaming-transcript-parser
```

Expected: `[new branch] feat/perf-jsonl-streaming-transcript-parser -> feat/perf-jsonl-streaming-transcript-parser` and the GitHub PR URL hint at the bottom.

- [ ] **Step 3: Open the PR**

```bash
cd /Users/juliusolsson/Desktop/Development/agent-code/.worktrees/perf-jsonl-streaming && \
gh pr create --title "perf(worktree-activity): stream JSONL transcripts instead of readFile" --body "$(cat <<'EOF'
## Summary

The 60 s background refresh in \`WorktreeActivityIndex\` was calling \`parseTranscriptForActivity\` per discovered transcript, and that function used \`readFile(path, 'utf-8').then(t => t.split('\n').map(JSON.parse))\`. For a 50 MB JSONL transcript that pattern transiently kept four representations live: the 50 MB Buffer, the 50 MB JS string, the 50 MB-ish array of substrings, and the parsed objects. Sequentially across all candidates per refresh, this matched the 100–200 MB spike-and-drop pattern visible in the system-perf popover every ~60 seconds and is the most likely primary cause of the recent main-process OOM crashes the user has been seeing during normal work.

This PR:

1. Adds a small shared \`streamJsonl\` helper in \`src/shared/runtime/\` that yields parsed JSONL objects one line at a time using \`createReadStream\` + \`readline.createInterface\` (same pattern \`ghostJournal.ts\` already uses).
2. Replaces the \`readFile + split + map\` body of \`parseTranscriptForActivity\` with a \`for await\` loop over \`streamJsonl\`.

Peak transient memory per parsed transcript drops from O(file_size) to O(longest_line) — typically tens of KB per line even for large tool_use entries.

## Out of scope (separate PRs)

- The same pattern exists in \`src/main/sessionIndex.ts:287\` (palette search) and \`src/main/sessions/historyLoader.ts:121\` (session resume + pagination). Both will reuse \`streamJsonl\` in follow-up PRs.
- The 30 MB \`worktree-activity-index.json\` file in \`indexStore.ts\` is single-JSON, not JSONL — streaming it requires a format migration shim or a JSON-stream parser dependency. Worth doing later, deliberately deferred from this PR.

## Test plan

- [x] \`npm run test:worktree-activity\` passes (unchanged from baseline)
- [x] \`npm run test:review-fixes\` passes
- [x] \`npm run build:app\` succeeds
- [x] \`git diff main | grep -ic cc-shell\` returns 0
- [ ] Manual: \`AGENT_CODE_PERF=1 npm run dev\`, open badge popover, observe \`large_object_space\` over ~5 minutes. The 60 s spike pattern that was hitting 100–200 MB should drop substantially (target: <30 MB per refresh).

## Stats

2 files changed (+~65 / -~10).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: the command prints the PR URL (e.g. `https://github.com/Juliusolsson05/agent-code/pull/N`). Stop after opening — do NOT merge automatically per saved memory `feedback_no_auto_merge`.

---

### Task 5: Brief the user and wait

**Files:** none

- [ ] **Step 1: Print a one-paragraph summary to the user**

Format:
- PR URL
- Two files changed, +N/-M line stats
- What to do to verify manually (run `AGENT_CODE_PERF=1 npm run dev`, watch popover for ~5 minutes, confirm LOS spike pattern drops)
- Explicit reminder we're waiting on their merge approval (per `feedback_no_auto_merge`).

- [ ] **Step 2: Stop. Do not merge until the user explicitly authorizes.**

---

## Self-review

**Spec coverage:**
- ✅ "Stream JSONL transcript parsing in the 60 s refresh" → Tasks 2 + 3
- ✅ "One shared utility for future PRs to reuse" → Task 2
- ✅ "No new tests" → no test files in the touched list
- ✅ "Worktree + PR" → Tasks 1, 4

**Placeholder scan:**
- No "TBD" / "fill in" / "similar to" — every step has exact code or exact command.
- The PR body is the complete copy that will go on GitHub.

**Type consistency:**
- `streamJsonl<T>(path: string): AsyncIterable<T | null>` — same signature used in Task 2 (definition) and Task 3 (consumption, instantiated as `<Record<string, unknown>>`). The `null` yield variant matches the existing catch-and-continue behaviour preserved in Task 3.
- `parseTranscriptForActivity(candidate: TranscriptCandidate): Promise<IndexedTranscript>` — signature unchanged from the original at line 14-16.
- `IndexedTranscript` / `TranscriptCandidate` / `WorktreeActivityEvent` types untouched — pulled from the same import sources as the original file.

No issues found.
