# Claude queue idle settlement (#677)

## Problem
`markStaleWhenIdle` is how Claude queue debt settles (`settleDebtByCohort` + `settleRemoveDebtByCohort`) and how unattributed survivors are marked stale. It had one live call site: a semantic event arriving while the session was already idle.

Exact-evidence carriers (a content-bearing `remove`, `popAll(content)`) deliberately leave debt for that settlement. Two orderings therefore stranded a queue chip for an item that had already left:

1. **Live:** the turn's last semantic event lands while `processActive` is still true, and the process then goes idle. The process-state handler never settled.
2. **Bootstrap:** production replay delivers no semantic events. The recorded `exact-remove-after-open-dequeue-debt` run ends with 3 pending items and `debt.count = 3`.

## Rule
Every transition INTO idle asks the same question through one helper, `settleClaudeQueueIfIdle` in `useIpcSubscriptions.ts`:

| Site | Idle means |
|---|---|
| semantic event (existing) | `!processActive && streamPhase === 'idle' && !awaitingAssistant` |
| process-state flip | `!active && streamPhase === 'idle'` (the handler clears `awaitingAssistant` itself) |
| bootstrap-complete | no live signal (`!processActive && streamPhase === 'idle'`). `awaitingAssistant` is excluded because queue-op replay forces it true. |

Each site commits the result to `claudeQueueBySession` after `setRuntimes` returns, the same rule as the other queue commits.

**Not done:** restoring inline settlement in the carriers. That was the #670 bug: it consumed the item the carrier named.

## Tests
`claudeQueueIdleSettlement.renderer.test.tsx` drives the real subscriptions through the fake feed:

- the issue's exact carrier sequence, settled on the process-idle flip;
- no settlement while the process is still active;
- the process-idle settlement is committed (a later `user` entry must not bring the item back);
- the recorded fixture replay, settled at bootstrap-complete and committed;
- no bootstrap settlement while the process is live.

**Fail-first:** 2 fail on origin/main.

**Mutations killed:**
- no process settle;
- no process commit;
- no bootstrap settle;
- no bootstrap commit;
- bootstrap ignores the live signal;
- process path ignores `active`.

## Narrowed (manager decision, option B, after review round 2)
- **Process-state flip:** does NOT settle. A redelivered `dequeue` (queue-operation records carry no uuid) can make `debt >= pending` cover a genuinely queued prompt, and at a live flip that would hide a real queued user prompt.
- **Bootstrap-complete:** settles only when the open debt covers EVERY pending item, stale ones included (`debtCoversPending`). The recorded fixture proves this case.
- **Semantic site:** unchanged.
- **Scope:** the live-idle half of #677 waits on the redelivery follow-up issue, so this PR says `Refs #677`, not `Fixes`.
