# Feed-debug per-session state survives a forget that races a queued append (#1207)

## Problem
`feedDebugLog.ts` keeps three per-session maps: `lastWrittenFeedDebugId`, `lastWrittenFeedDebugEpoch` and `feedDebugCapState`. `forgetFeedDebugSession` deletes them synchronously. But an append that was queued before the forget, and had not started yet, ran afterwards and wrote them back. Queue settlement only reaps `feedDebugWriteQueues`, so the state stayed for the life of the process. The #1111 reviewer's probe: 100 sessions, 100 dead entries in each map.

## Fix
- **A per-session token,** captured by each append when it is queued. `forget` deletes it.
- **When an append finishes** (in a `finally`, so a failed write counts too), a token that is no longer current means the session was forgotten meanwhile. The append then deletes the three maps again.
- **The token map is cleared by the same forget,** so it cannot grow either.

## Test
Real queue ordering, no mocks of the queue: append then forget for 100 sessions, and await the writes. The three maps and the token map must be back to their prior sizes. It was red before the fix (105 vs 5 in each map), and removing the drop is red again.
