# Control history recovery without duplicate effects (#1240)

## Problem

`FileControlHistory.load()` rejects the whole journal on any damage:
- an unterminated tail;
- a row that JSON or `historyEventSchema` rejects;
- a sequence gap.

The rejection is cached. Every control call writes a `received` row first, so every call, reads included, then fails with `history_unavailable`, across restarts, until someone edits `events.jsonl` by hand.

A failed append also sets `poisoned` for the rest of the process.

## The boundary this must not break (steering q12)

The journal is not only an audit log. `executor.ts` looks up a prior `received` row by `(caller, requestKey)`:
- it replays the stored result;
- or it answers `interrupted` / `unknown`;
- it never re-dispatches.

`FileControlHistory.test.ts` pins this across a reopen, including when the final `result` write was lost.

The issue's suggested repair ("rename the file aside, continue with a fresh history") deletes those rows from the active ledger. A caller retrying the same key would find nothing and run the effect a second time. So recovery must keep every row that can still be trusted, and must refuse any keyed call whose evidence may have been in a row it cannot read.

## Evidence

- **The real journal:** `~/.config/agent-code/control-history/events.jsonl`, 5,885 rows, Sep 5–24.
  - Kinds: result 1,846, received 1,383, dispatched 1,380, step 813, transport 462, duplicate 1.
  - Rows contain only ids, timestamps, capability ids, callers and payload digests; prompts and results live in `payloads/`. Real lines can therefore be committed as fixtures unredacted.
- **Request keys are in active use** (808 rows): `dispatch.configure` and `commands.run` from external callers, `agents.prompt` steps from agents, and `operations.start` from the application. A policy that blocked keyed calls would block real traffic, so it may only apply where evidence is truly unknown.
- **Write ordering in the executor** (`executor.ts`): `received` is appended and awaited inside `exclusive` before anything else. `dispatched` is appended and awaited before `ports.dispatch`. `result` comes after the effect. Every append is one `writeFile` of `JSON + "\n"` followed by fsync.

## Design

`load()` classifies the file instead of throwing.

### 1. Clean
Every line is newline-terminated, parses, validates, and `sequence === index + 1`. Unchanged.

### 2. Torn tail only
Every complete line is clean; the bytes after the last `\n` are not.
- Preserve the original file byte for byte at `events.quarantined-<ISO>.jsonl`.
- Atomically rewrite `events.jsonl` as the verified prefix (temp file, fsync, rename, directory fsync).
- Serve **fully**.

This is safe because of the write ordering above. The torn bytes are the last append. Every earlier row of the same call is in the prefix, because appends are serialized on `tail`.
- **A torn `received`:** that call never passed its intent write, so it was never dispatched. A retry dispatching once is correct.
- **A torn `dispatched` / `step` / `result`:** the call's `received` is in the prefix, so a retry finds it and answers from the stored result, or `interrupted` / `unknown`.
- **A torn `duplicate`:** it has no effect.

This holds even when the torn bytes happen to be a complete JSON row missing only its newline. Dropping it from the active ledger loses no idempotency evidence, and the bytes stay in the quarantine copy.

### 3. Damaged rows before the tail
A complete line fails JSON, fails the schema (for example a newer build's event kind after a downgrade), or the sequence has a gap or reorder. Rows after that point may still be fine, but what was lost cannot be known in general.
- Preserve the original bytes as in case 2.
- Rewrite `events.jsonl` with every row that parses and validates, in file order, renumbered `1..n`. Sequences are process-local paging cursors (`history.list` snapshots), and nothing durable references them.
- Write `recovery.json` beside the ledger, recording:
  - the quarantine path;
  - the counts;
  - a **blocked-key set**: for each damaged line that still parses as a JSON object with a string `caller` and `requestKey`, that pair;
  - `keyedCallsBlocked: true` if any damaged line yields no object, or if there is a sequence gap. A gap means rows are missing, and a missing row could have held any key.
- **Policy while `recovery.json` exists:**
  - Calls without a request key proceed normally. They never consult the journal for dedupe, so a lost row cannot cause a duplicate.
  - A keyed call whose `(caller, requestKey)` has a `received` row among the salvaged rows proceeds normally. The executor finds its evidence.
  - A keyed call on a blocked pair is refused at the `received` append: `history_unavailable`, `not_started`.
  - With `keyedCallsBlocked`, every keyed call without salvaged evidence is refused the same way. Duplicate effects are worse than a refused mutation.
  - Reads and unkeyed calls keep working, which ends the P1 "every call fails".
- **Clearing:** the operator removes `recovery.json` once the preserved file has been inspected. The incident names both paths. Automatic expiry was rejected: request keys have no lifetime in the contract, so no timeout can be proven safe.

### 4. In-process write failure
`poisoned` no longer blocks for the process lifetime. A failed append drops the cached load. The next append re-reads the disk, which is the only truth about what landed:
- a partial row becomes case 2;
- a fully landed row is simply present;
- a persistent disk error fails the append again, as it should.

### Reporting
`FileControlHistory` takes an optional `onRecovered(report)`. `createControlHost` forwards it, and `index.ts` records an app-run incident `control.history_recovered` (warn) with the case, the quarantine path, the counts and the key policy. The history stays a zero-dependency module.

## Tests (fail-first on main, real rows)

The fixture is the first N real rows of the owner's journal. Case 2 uses a real row cut mid-line. Case 3 uses a real row with its `kind` changed to one this build does not know (a downgrade), and a line of non-JSON bytes.

1. **Torn tail, idempotency preserved:** a real prior call with a request key completes through the executor. A torn row is appended. Reopen, then retry the same key: the stored result comes back and the handler is **not** invoked. A new keyed call dispatches exactly once. The original bytes equal the quarantine file, and the report names it.
2. **Torn tail after a lost result:** the result write fails, then the tail tears. Reopen and retry: `interrupted` / `unknown`, handler not invoked.
3. **Schema-rejected received row with a key:** reopen. A retry of that key is refused `not_started` with the handler not invoked. An unkeyed call and a `history.list` read succeed. An unrelated keyed call with salvaged evidence replays.
4. **Unparseable middle line:** a new keyed call is refused and an unkeyed call succeeds. After `recovery.json` is removed, the keyed call dispatches once.
5. **In-process failed append:** the next call recovers without a restart.

## Out of scope

- Salvaging the idempotency lookup for rows the executor writes in a future format. The blocked-key extraction reads only the stable `caller` / `requestKey` fields.
- A UI for inspecting quarantined journals. The incident plus the file path is the surface for now.
