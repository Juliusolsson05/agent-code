# Dictation debug journal: a per-file cap (#1276)

## Evidence
- `dictation-debug/64f6ad14-….dictation.jsonl` is 1.196 GB, from one press whose recorder ran 32.8 h (#1299 is that bug).
- Measured by event, of 1.2 GB:
  - `recorder:dataavailable` 19.9 %
  - `deepgram:chunk:queue` 19.2 %
  - `recorder:chunk:push-ipc` 14.0 %
  - `main:received` 13.7 %
  - `renderer:produced` 13.5 %
  - `sample` 11.5 %
  - `deepgram:chunk:send` 4.9 %
  - `deepgram:message` 3.3 %
- Only 17 events in the whole file are lifecycle (session, device, recorder start, stream start/open/close).
- The only cleanup is a 14-day prune at startup. `DictationDebugJournalRegistry.dispose` has no callers, so journals accumulate in memory for the app's lifetime.

## Change
- Per-file budget (16 MiB). Past it, the high-frequency per-chunk and per-sample events are dropped, and one `META journal:high-frequency-suppressed` marker is written. Lifecycle, error and stop events are still written, which is what an investigation reads.
- The registry keeps at most 64 journals. The oldest is flushed and evicted, since a press id is never reused.

## Tests
- Real event shapes (layer/event/data as recorded).
- Past the budget the file stops growing with chunk events but still receives a lifecycle event.
- The registry is bounded.
- Red on main.
