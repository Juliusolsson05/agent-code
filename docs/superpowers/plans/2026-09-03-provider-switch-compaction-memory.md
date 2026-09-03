# Provider switch: stop the compaction wait from pinning the whole conversation

Fixes #720. Refs #327, #365, #103.

## Problem

`scripts/analyze-heapsnapshot.mjs --owners` on the 2026-09-03 main-process
snapshot (watchdog trip at 1.97 GB) attributes 354 MiB — 80% of the reachable
heap — to one `node:timers/promises` `Timeout` whose promise chain suspends
`waitForPortableCodexSummary` inside `compactSourceBeforeSwitch`. The two
generators' saved registers hold three full `ConversationDocument`s of the same
18,362-entry Codex rollout (~118 MiB each): `before`/`compacted`, the plan's
`conversation`, and the current poll's `current`.

On top of the retention, both wait loops call `source.read()` every 250 ms for
up to 300 s. For Codex that is a full `~/.codex/sessions` tree walk
(`findCodexRolloutPathBySessionId`) plus `readFile` + `decodeJsonl` +
`decodeCodexConversation` + `analyzeCodexTranscript` of a 60–150 MB file, four
times a second, on the main thread. The log around the trip shows main
`eventLoop.meanMs` 1591 / `maxMs` 3934 and renderer heartbeat freezes of 4–7 s
for every pane, for the whole 5-minute window.

## Design

Keep the observable contract of `compactSourceBeforeSwitch` (same prompts,
same terminal conditions, same return shapes, same timeout) and change only
what the wait retains and how often it decodes.

1. **Retain scalars, not documents.** Every full read is funnelled through a
   helper that decodes, applies a selector, and returns only the selector's
   result. `before` becomes a compaction fingerprint (string | null) or a
   baseline line number; `waitForNewCompaction` takes a selector so Claude
   gets its post-compaction document and Codex gets only the latest source
   line. No generator keeps a `ConversationDocument` alive across an `await`.
2. **Decode only when the file changed.** The transcript adapter gains
   `locate(cwd, providerSessionId)` returning the on-disk path. The wait loops
   resolve it once, then poll `stat()` and re-decode only when `size:mtimeMs`
   moved (or when `stat` fails, which is treated as "unknown, re-check").
   Polling cadence stays 250 ms so the switch still completes promptly.
3. **Cap decode rate.** A 1 s floor between decodes bounds main-thread cost
   even if the provider appends continuously; worst-case added latency is
   1 s on a wait that already takes tens of seconds.

Not in scope: `switchProvider` still holds the pre-compaction `conversation`
via `plan.conversation` for the duration of `compactSource` (one copy instead
of three). Moving transcript decoding off the main thread is a separate item.

## Verification

- `compactBeforeSwitch.test.ts`: existing five contracts unchanged; new
  contracts for "locate once, no decode while unchanged", "decode again after
  the file grows", and "decodes are rate-limited while the file keeps
  changing".
- `npx tsc -p tsconfig.node.json --noEmit` for the main project.
- Before/after evidence for #365: the dominator report above (before) and a
  re-run of `--owners` on the next watchdog snapshot, or the
  `main.heap` gauge during a Codex→Claude switch of a large rollout (after).
