# Performance: bound the heap watchdog's snapshot retries

Fixes #733. Refs #365, #364, #48.

## Problem

The main-process heap watchdog writes one synchronous heap snapshot when
`used_heap_size` crosses the trip line. On a write failure it clears the
one-shot latch so a later sample can retry — but above 25% of the V8 limit
the sampler runs every 2 s, and the failure most likely at that point
(`ENOSPC` on a disk holding 12 GB of debug artifacts, `EIO`) does not
subside. The process then repeats a multi-second synchronous
`writeHeapSnapshot` every 2 s: a freeze loop under exactly the condition
the subsystem creates.

## Design

- Keep the single-shot-on-success behaviour and the trip/sampling logic.
- On failure, record the attempt and arm a retry-not-before time
  (`SNAPSHOT_RETRY_BACKOFF_MS`, 10 minutes). Samples that trip before that
  time do nothing.
- After `MAX_SNAPSHOT_ATTEMPTS` (3) failures, give up for the rest of the
  run and say so once in the log. Ten minutes between attempts, three
  attempts: the disk had half an hour to recover; if it did not, one more
  freeze will not help.
- Expose a test-only reset so the module-level state can be exercised.

## Verification

- New `heapWatchdog.test.ts` with `node:v8` and `electron` mocked and fake
  timers: a tripped sample writes once; a failed write is not retried on
  the next 2 s sample; it is retried after the backoff; after the third
  failure no further writes happen for the rest of the run; a success after
  a failure re-arms nothing (still single-shot).
- `npx tsc -p tsconfig.node.json --noEmit`.
