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
- **Discovery failure closes its span.** Today a failed discovery leaves its span open until the 10-minute sweep records a `timeout`.
- **No worker yet.** Moving work to a worker waits until the data says which path stalls main.

## Tests
- **History loader:** one initial load through `loadInitialHistoryChunk` records exactly one `transcript.read` (red on main: two).
- **Catalog:** a search with a query records `conversations.search`, and an extract records `conversations.extract`; a failed discovery records an `error` outcome.
