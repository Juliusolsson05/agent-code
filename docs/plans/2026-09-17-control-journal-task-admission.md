# Fix control journal JSON poisoning and window task admission

Refs #974, #975

## Context

While resuming a fleet of sessions after an unplanned app termination
(2026-09-14), two independent control-plane defects surfaced together:

1. **(#975)** Every operator history read covering events appended by the
   current process fails capability output validation with
   `invalid_output: Capability returned a non-JSON value`. Reads that only
   touch events loaded from disk at startup succeed, so a restart masks
   the failure — the worst possible shape for an audit surface.
2. **(#974)** Every externally invoked window-executed lifecycle capability
   (`agents.resume`, `agents.create`, `agents.duplicate`, …) is blocked
   before any effect with
   `unavailable: Task requires one existing original call and cannot be
   started twice`, because task admission runs under the renderer bridge's
   throwaway correlation id instead of the original durable call id.

Both were reproduced live on 2026-09-17 against the running dev app; the
journal on disk contains the evidence for both (request keys shaped
`task-start:<bridge-uuid>`, and history reads failing only for
append-path events).

## Root causes

- **#975** — `createControlExecutor` builds each journal write with
  `requestKey: request.requestKey` unconditionally, so calls without a
  request key append events carrying `requestKey` as an *explicit
  `undefined` own-property*. Zod 4 object parse preserves such keys, so
  the in-memory cached event keeps `requestKey: undefined`, while
  `JSON.stringify` silently drops it when the line is written to disk.
  The capability output guard (`z.json().safeParse`) rejects `undefined`,
  so any response containing the in-memory copy fails. Load-path events
  (re-parsed from disk) never contain `undefined`, which is exactly why
  only recent events fail.
- **#974** — `ControlRendererBridge` forwards the original durable call id
  as `context.operationId` (with its own fresh `requestId` for reply
  correlation), but `createControlRegistry().invoke` rebuilds the handler
  context from only `{ requestId, caller, owner }` and drops
  `operationId`. `startControlTask` then falls back to
  `context.requestId` — the bridge's UUID — and `operations.start` cannot
  find a journaled origin for it.

## Fix

1. **Writer** (`src/control-sdk/core/executor.ts`): include `requestKey`
   in the journal write only when a request key was actually supplied.
2. **Holder invariant** (`src/main/control/history/FileControlHistory.ts`):
   an appended event's in-memory shape must equal its JSON shape. Strip
   explicit-`undefined` own-properties from the schema-parsed event before
   it is cached and returned, so no future writer can poison the cache
   this way. (Load-path events cannot contain `undefined` — `JSON.parse`
   never produces it — so normalizing at append closes the hole
   completely.)
3. **Context passthrough** (`src/control-sdk/core/registry.ts`): forward
   `context.operationId` into the frozen handler context so window
   lifecycle tasks admit under the original durable call id.

## Tests (written red first)

- `FileControlHistory.test.ts`: an executor call *without* a request key,
  followed by a `history.list` capability read of those events, must
  succeed; and every event returned by `events()` must pass `z.json()`
  and deep-equal its disk round-trip.
- `registry.test.ts`: invoking with
  `{ requestId, caller, operationId }` must deliver `operationId` to the
  capability handler's context.

## Verification

- New tests red before the fix, green after.
- Existing suites for `src/control-sdk` and `src/main/control` stay green.
- Typecheck clean (`npx tsc --noEmit`).
- Live re-check after rebuild+restart of the dev app: `history.read` of a
  fresh call succeeds, and `agents.resume` admits (`operations.read`
  leaves `not_found` and reaches a terminal result).
