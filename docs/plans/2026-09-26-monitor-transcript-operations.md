# Measure transcript and catalog work before moving it off the main thread (#769, first step)

## Problem
#769 asks to move history loads (and the since-replaced session index) off the main thread. A re-check on origin/main `b3a2c481` (comment on #769) found that every transcript read and parse still runs on main. But the recordings cannot say whether that work is what stalls main:
- **Few slow reads:** 2,436 `transcript.read` samples across all monitor runs, only 3 slow-operation incidents (1.0 s, 1.3 s, 1.8 s).
- **No link to stalls:** 14 `main-stall` incidents, none within 10 s of a slow read. Main-stall incidents carry no operation attribution.
- **Double sample:** each IPC initial history load records `transcript.read` twice. `loadInitialHistoryChunk` opens a span, ends it after path resolution (`result: 'delegated'`), then `loadInitialHistoryChunkFromFile` opens a second span with the same name for the real read. Half the samples measure path resolution only, which skews the percentiles low.
- **Blind spot:** the conversations catalog is invisible to the monitor. `sessionIndex.extractPrompts` (a synchronous parse over windows of up to 16 MiB), catalog search's prompt gathering (up to 150 rows), and discovery have no monitor operation.

## Decisions (defaults)
- **The path-resolution span gets its own name,** `historyLoader.resolveInitialPath`. It stays in the perf journal and is not a monitor operation, so each initial load records exactly one `transcript.read`.
- **Three monitor operations** join the finite vocabulary:
  - `conversations.discover`: the existing `conversations.discover` span.
  - `conversations.extract`: the existing `sessionIndex.extractPrompts` span.
  - `conversations.search`: a new span around search's prompt gathering.
- **Slow-operation thresholds:** extract 250 ms (one file's synchronous parse), search 1000 ms, discover 2000 ms. Picked like the existing ones: a user-visible delay, not a precise budget.
- **No worker yet.** Moving work to a worker waits until the data says which path stalls main.

## Tests
- **History loader:** one initial load through `loadInitialHistoryChunk` records exactly one `transcript.read` (red on main: two).
- **Catalog:** a search with a query records `conversations.search`, and an extract records `conversations.extract`, driven on the recorded conversations corpus.

## Round 1 review decisions (#1352)
- **a1: a discovery that rejects left its span open.** It became a `timeout` sample at the sweep. The earlier call that discovery "cannot fail" was wrong: family resolution rejects a malformed cwd. The span now closes with `fail(error)`. Test added; red before.
- **a2: the vocabulary outgrew the histogram cap.** 26 operations × 4 outcomes is 104 pairs, but the aggregator, the snapshot parser and the history store each hard-coded 100. One derived constant, `MAX_MONITOR_OPERATION_PAIRS`, now serves all three. Test: every legal pair is stored and the snapshot parses. Red before.
- **a3, b1, c2: no test pinned the three new thresholds.** Each now gets a sample just above (a named slow-operation incident) and just below (none).
- **c1: discovery's 2000 ms threshold sat above main-stall's 1000 ms band.** A 1.5 s discovery stall raised no named incident, so discovery and search are now both 1000 ms.
- **b2: the extraction assertion ignored whether prompts came back.** It now requires at least one prompt.
- **c3: the load-time test counted samples but not which span.** With the resolver taking 80 ms, the single sample must be shorter than that, so it timed the read, not the lookup. Mapping the lookup span instead fails it.
- **Declined:**
  - b3 and c5, the corpus-install `beforeAll` timing out under heavy load: the hook predates this PR and CI runs it. Timeouts are never widened.
  - c4, a 60 s cooldown slot per scope shared by all main-scope slow operations: pre-existing semantics, outside this PR.
