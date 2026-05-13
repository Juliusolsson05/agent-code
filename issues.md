# Reporting Issues

This codebase is worked on primarily by AI agents. This guide is for
them.

**The more technical detail, the better.** File paths with line numbers,
exact symbols, transcript IDs, commit SHAs, error output verbatim,
stack traces, environment variables — over-share rather than
under-share. Every fact you omit is a follow-up round trip the next
person has to do before they can reproduce.

## Which repo

| Repo | What goes here |
|---|---|
| **agent-code** | UI, tile-tree, dispatch, session management, IPC, system-perf, settings — all renderer + main-process behaviour. Default. |
| **claude-code-headless** | Driving the real `claude` CLI: TUI parsing, JSONL handling, proxy/SSE streaming, slash-picker, permission prompts. |
| **codex-headless** | Driving the real `codex` CLI: rollout parsing, Responses adapter, screen parsing, approval overlays. |
| **agent-transcript-parser** | Claude↔Codex transcript translation, ghost primitives, rewind/clone helpers. |
| **agent-voice-dictation** | Recording, STT clients, OpenRouter polish, composer integration. |

## Bug report

```markdown
### What happened
One or two sentences. The visible symptom.

### Repro
Exact steps. If non-deterministic, say so explicitly and describe how
often / under what conditions: "happens after ~30 min of normal use
with 10+ agents active." Link the relevant transcript path —
`~/.claude/projects/-Users-foo-bar/<sessionId>.jsonl` for Claude or
`~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<id>.jsonl` for
Codex. Include the commit SHA you reproduced on.

### Where
File:line and the function or symbol if you've located it. Examples:
`src/main/sessionManager.ts:912 spawnClaude`,
`src/renderer/src/features/feed/ui/Feed.tsx onScroll`,
`packages/claude-code-headless/src/proxy/ClaudeProxyAdapter.ts:804`.
If unlocated, name the subsystem: feed renderer, JSONL tailer, proxy
adapter, dispatch mode, work-context, image paste, dictation.

### Output
Error text, stack trace, log lines — verbatim, don't paraphrase or
truncate. Include surrounding console lines if a single line was the
trigger but the context is in the lines around it. Native frames
(C++/Rust) in a v8 fatal-error trace are important — keep them.

### State
Anything that affects reproducibility: number of active panes, which
providers (Claude / Codex / terminal), how long the app had been
running, whether `AGENT_CODE_PERF` was set, whether you were in
Dispatch Mode, whether worktrees were attached.
```

## Feature request

```markdown
### Use case
The workflow the current app makes harder than it should be.

### Example
One concrete scenario, end to end — what you'd do today vs. what you
wish you could do.

### (Optional) Sketch
Implementation thoughts. Skip unless you have specifics.
```

## Performance / crash

Different evidence than functional bugs. Attach what applies:

- **Fatal-error block from the terminal.** When the main process
  OOM's, the terminal where `npm start` ran will have a `FATAL
  ERROR: CALL_AND_RETRY_LAST Allocation failed - JavaScript heap out
  of memory` line followed by a `Native stack trace` block. Include
  the whole block, not just the headline — the native frames identify
  the allocator that broke (typical signatures: `node::Buffer::New`,
  `v8::CppHeap::wrapper_descriptor`, Rust `font_types::...`).
- **System-perf popover state at the time.** Requires
  `AGENT_CODE_PERF=1` set when launching. Click the heap badge in the
  header. Report: heap used / limit, RSS, top heap spaces with sizes
  (especially `old_space` and `large_object_space`),
  detached-contexts count, native-contexts count, event-loop p99,
  60s growth Δ for heap and RSS.
- **Heap snapshot.** Manual: click "Capture heap snapshot" in the
  popover; writes to `~/.config/agent-code/heap-snapshots/manual-<iso>-<pid>.heapsnapshot`.
  Automatic: the watchdog writes one when `used_heap_size` crosses
  `min(3 GiB, 0.75 × heap_size_limit)` — same directory, `main-` prefix.
  These files are 10–500 MB; link a cloud share rather than attaching
  directly if large.
- **Growth pattern.** Three shapes matter:
  - steady monotonic climb → retention leak
  - spike-up-then-drop-to-zero cycle → transient large allocations
    (whole-file reads, big buffers, GC churn)
  - sudden jump → one-shot allocation (giant string, image, file load)

  Saying which shape you observed narrows the suspect list before
  anyone opens the snapshot.

## Security

Disclose privately to the maintainer rather than via a public GitHub
issue.

## Don't file

- How-to questions → Discussions.
- Upstream CLI bugs (`claude` / `codex` flag behaviour) → the upstream
  repos for those tools, not here.
