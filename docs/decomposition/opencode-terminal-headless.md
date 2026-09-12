# OpenCode Terminal headless — stage decomposition

Status: stages 0–6 built (2026-09-11), in review. Approved 2026-09-10: the
user approved the read pipeline and package layout, then instructed "build all
of this". Stage 0 findings were presented as they landed, not gated; none
contradicted this document. The plan's execution notes list the commits and
where the build went beyond the plan.

Issue: #864 (feature), #857 (runtime never reports running).
Plans: `docs/superpowers/plans/2026-09-10-opencode-terminal-headless.md`
(Agent Code side) and `docs/plans/2026-09-10-initial-runtime.md` inside
`packages/opencode-terminal-headless` (package side).

## Why this document exists

OpenCode Terminal (`providerRuntime: 'terminal'`, PR #755) runs the native
OpenCode TUI in a bare PTY. It tells Agent Code nothing: `process-state` is
permanently `{ active: false }`, there are no semantic events, no committed
transcript entries and no conditions. Every status surface, every orchestration
and agent-management read, and every attention badge is therefore wrong or empty
for these panes. The full surface-by-surface evidence is in #864.

Two sources must agree on one output here: OpenCode's durable store and the
TUI's live server. That is exactly the situation where forward-patching a
single class produces the 40% implementation, so the reconciliation gets its
own isolated layer and the cases get enumerated from recorded data first.

## A — what exists and is trusted

- `src/providers/opencode/runtime/opencodeTerminalSession.ts`: a working PTY
  lifecycle (spawn, readiness = first byte + 250 ms, bracketed-paste prompt
  delivery with the `opencode-terminal-not-ready` refusal code, generation
  fencing, idempotent stop). Its lifecycle behavior is trusted and kept; its
  *observability* is the gap.

  **Corrected after review:** the paste delivery described here was NOT kept.
  It looked trustworthy and was not: the refusal code only fires when the PTY
  is absent, so a prompt pasted into a TUI that had painted but was not yet
  listening was reported as delivered and then dropped (#877). Delivery moved
  to the TUI's HTTP server. This entry is left standing because "trusted
  because it has not visibly failed" is the assumption worth remembering.
- `src/providers/opencode/runtime/opencodeCliSessions.ts`: `opencode import` /
  `export` hosting. Session creation (`createEmptyOpencodeSession`) and every
  write/transform (switch, duplicate, rewind) stay on this boundary.
- OpenCode ≥ 1.18.27 on disk: `opencode.db` (SQLite, WAL) with `session`,
  `message`, `part` projection tables and an append-only `event` log whose rows
  are written unconditionally, in the same immediate transaction as the
  projections, with a gapless per-session `seq`
  (`sst/opencode@v1.18.30 packages/core/src/event.ts:205-349`,
  `commitDurableEvent`). Durable event types observed locally:
  `session.created.1`, `session.updated.1`, `message.updated.1`,
  `message.part.updated.1`, `message.removed.1`.
- OpenCode ≥ 1.18.x TUI: `--hostname`/`--port` switch the TUI's worker server
  from in-process RPC to a real HTTP server, and the TUI then authenticates with
  `ServerAuth.headers()` (`sst/opencode@v1.18.30
  packages/opencode/src/cli/cmd/tui.ts:233-249`). That server exposes `/event`
  (SSE bus), `/permission/:id/reply`, `/question/:id/reject`,
  `/tui/execute-command`, `/sync/history`, and more.
- The renderer's OpenCode transcript mapper
  (`src/providers/opencode/renderer/transcript/mapper.ts`) and
  agent-transcript-parser's OpenCode decoder both consume the
  `{ info, parts }` message record shape. No new decoder is needed if the new
  channel emits that shape.

## D — end state, as observable behavior

1. While an OpenCode Terminal agent works, its pane header (Status Mode), tab
   bar badge, Dispatch row, Agent Status panel and the close/switch/rewind busy
   guards all show it running. They return to idle when OpenCode's own
   `session.status` goes idle. No flip to idle between the steps of one user turn
   (`finish: "tool-calls"`).
2. `orchestration_wait_agents` completes for an OpenCode Terminal child when its
   turn ends. `orchestration_read_agent`, `agent_management_read_agent` (live
   and parked) and Reader / Copy Last Response return the real conversation.
3. A pending OpenCode permission or question raises the Dispatch ACTION /
   QUESTION badge. It can be answered through the existing condition-resolution
   path (HTTP to the TUI's server), and it clears when answered in the TUI
   itself.
4. `agent_transcript_read_file` / `search_file` / `inspect_file` accept
   `opencode://session/<id>` and read the session from OpenCode's store.
5. An OpenCode version without the event log, a schema that fails the gate, or
   an unreachable live server degrades to today's behavior plus a visible
   diagnostic. It never produces wrong data.

## The pipeline (one owner per signal)

| Signal | Owner | Mechanism |
|---|---|---|
| Committed `{ info, parts }` messages (live) | Durable | Type-filtered `event` tail by `seq` cursor; final content read from the `message`/`part` projection when a message commits |
| History (cold, parked, restart) | Durable | Projection snapshot, newest-first window |
| Activity (`process-state`), turn start/end, `stream_phase` | Live | `session.status` busy/retry/idle plus part-kind phase hints from the TUI server's `/event` |
| Conditions (permission / question) | Live | `permission.*` / `question.*` bus events, re-synced from `GET /permission` / `GET /question` on (re)connect |
| Screen | Nobody | No headless xterm mirror. OpenTUI is a buffer renderer with nothing on screen the live channel doesn't carry, and the 60 Hz snapshot churn is the most expensive thing the other packages do (`project_screen_snapshot_gc_churn`). |

The live channel doubles as the durable channel's doorbell: OpenCode commits the
event row before it republishes the event on the bus, so a live
`message.updated` or `session.status idle` for our session means the row is
already readable. While live is connected the durable reader never polls. While
live is disconnected it falls back to a 1 Hz primary-key lookup of
`event_sequence.seq` for the session, which costs microseconds.

## Intermediate stages

### Stage 0 — Evidence corpus and census

- **Produces:**
  - `packages/opencode-terminal-headless/scripts/census.mts`: a read-only census
    over a real `opencode.db`.
  - `scripts/probe-live.mts`: a sandboxed live recorder.
  - `testing/fixtures/durable/*.json`: sanitized real event logs, each paired
    with its projection snapshot.
  - `testing/fixtures/live/*.json`: sandbox SSE recordings interleaved with
    durable rows, with timestamps.
  - `research/census-2026-09-10.md`: counts, invariant results, open shapes.
- **Verified by:** the census asserts the invariants below over every local
  session that has an event log and reports violations with counts. A fixture
  validator checks every fixture is self-consistent: replaying its log reaches
  its own projection snapshot.
- **Why separate:** every later test is built from these files. Writing the
  reader first would mean testing the reader against the shapes that happened to
  be in context (the 40% failure).
- **Reality check:**
  - The user's `~/.local/share/opencode/opencode.db` (1.9 GB, 505 sessions, 50
    with event logs), opened read-only.
  - A sandbox run of the real `opencode` 1.18.30 binary with an isolated
    HOME/XDG tree and a free `opencode/*` model. It never touches the user's
    data or quota, and `OPENCODE_DANGEROUSLY_SKIP_PERMISSIONS` is unset so real
    permission prompts occur.
- **Invariants the census checks (hypotheses until checked):**
  1. `event.seq` is gapless per aggregate, starting at 0.
  2. Every user message's parts are written before the first assistant
     `message.updated` whose `parentID` is that user message.
  3. No `message.part.updated` targets an assistant message after the
     `message.updated` that set `time.completed`. Count any exceptions.
  4. Assistant `finish` values and `info.error` shapes. Also, which ones end a
     user turn (expected: anything except `tool-calls`).
  5. `message.removed` contexts (revert/undo) and whether the removed message
     had already completed.
  6. Child (`task`) sessions have their own aggregate and never write into the
     parent's.
  7. For sessions whose log is complete, a last-write-wins replay of
     `message.updated`/`message.part.updated` equals the `message`/`part` rows.
     This is the oracle Stage 1 is tested against.
  8. `message.data` / `part.data` omit `id`/`sessionID`/`messageID`, which live
     in columns.
- **Live questions the probe answers:**
  - The exact v1.18.30 bus event names and payloads for `session.status`,
    `session.idle`, `permission.asked`/`replied`, `question.asked`/`replied`/
    `rejected`, `message.part.delta`.
  - Whether `--port` plus `OPENCODE_SERVER_PASSWORD` works as the source reads
    (auth enforced, TUI still connects).
  - What happens when the port is already bound.
  - Which re-sync endpoints exist (`GET /session/status`, `GET /permission`,
    `GET /question`).
  - The `session.status` sequence for a prompt queued while busy.
  - Whether a child session's permission request surfaces while the parent TUI
    is the only client.
  - The ordering of the bus event against durable row visibility.

### Stage 1 — Durable reader (`src/transcript/`)

- **Produces** (names as SHIPPED; this plan's originals are noted because the
  difference is the point — the split between "hold the handle" and "tail the
  log" did not survive contact with the schema gate, which has to own both):
  - `OpencodeStore` (planned as `OpencodeDatabase` + `EventLogTail`): the
    shared, generation-keyed, read-only `node:sqlite` handle per db path, the
    schema gate, and every statement that reads OpenCode's tables — history
    pages, the event tail, session rows, and the root-session listing the
    Resume picker uses. One owner, because the gate must equal the columns the
    statements actually read, and two owners could not keep that true.
  - `readHistory()`: projection snapshot → `{ info, parts }` records plus cursor.
  - `CommittedAssembler`: pure; decides *when* a message is committed.
  - `DurableReader`: doorbell/poll orchestration.
- **Verified by:** replaying every Stage 0 durable fixture yields exactly the
  completed messages of its projection snapshot (invariant 7), in projection
  order, each exactly once. A system test writes a real SQLite file with the
  production schema, appends rows while the tail runs, and checks the gate
  rejects a schema missing a column.
- **Why separate:** it is the only code that knows OpenCode's schema. If schema
  knowledge leaks into the live or reconcile layers, a schema change silently
  corrupts status as well as history.
- **Reality check:** Stage 0 durable fixtures; the real 1.18.30 schema.

### Stage 2 — Live reader (`src/live/`)

- **Produces:**
  - `SseStream`: fetch-based SSE with Basic auth, `x-opencode-directory`,
    reconnect with backoff.
  - `LiveServerClient`: permission reply, question reject, re-sync list calls.
  - `LiveStateProjector`: pure; bus events for the session and its descendants
    become activity, turn, phase and pending-request transitions.
- **Verified by:** feeding the recorded sandbox SSE sequences produces:
  - busy at the recording's first `busy`, idle at its final `idle`, and no idle
    between steps
  - one turn per busy→idle pair
  - a visible permission from `permission.asked` until `replied`

  The expectations come from the recording's own `session.status` events, not
  from the projector.
- **Why separate:** it is the only code that knows OpenCode's bus vocabulary.
  It must stay testable without a database or a PTY.
- **Reality check:** Stage 0 live recordings.

### Stage 3 — Reconciliation and composition

- **Produces:**
  - `src/reconcile/SessionSequencer.ts`: the isolated hard part.
  - `src/OpencodeTerminalHeadless.ts`: caller passes the PTY.
  - `src/launch/`: port, password, args, env, db path.
  - `src/terminal/PtyBinding.ts`.
  - `src/conditions/`: vendored core plus `opencode.permission` /
    `opencode.question` modules with the structured runtime's custom action
    names.
  - `src/channels/`: semantic/screen/committed, the same shape as the siblings.
- **Verified by:** recorded interleavings (Stage 0 live+durable pairs) must meet
  every ordering rule the renderer depends on (#864 research):
  - the committed assistant entry precedes the final `stream_phase idle` and
    activity idle
  - `turn_started`/`turn_completed` share a `turnId` and never overlap
  - foreign-session records are never emitted
  - exit ends any open turn and clears conditions
  - `stop()` is idempotent before, during and after `start()`
- **Why separate:** this is where two sources meet. The rules live in one pure
  module with one consumer, instead of being spread across adapter code where
  they would fight (the ownership-bug class).
- **Reality check:** Stage 0 interleaved recordings.

### Stage 4 — Package repository and submodule wiring

- **Produces:**
  - The package repo's README ("Should you use this package? Probably not"),
    CI caller of `reusable-package-ci.yml`, the release caller, the
    testing-contract scripts, and `support/upstream-versions.json`.
  - In Agent Code: the submodule, aliases in `electron.vite.config.ts`,
    `tsconfig.node.json`, `tsconfig.web.json` and `vitest.config.ts`, and a
    `scripts/sync-conditions-core.mjs` target.
- **Verified by:** the package's `npm run check` and Agent Code's
  `npm run typecheck`.
- **Why separate:** build wiring failures (alias drift, missing submodule) must
  not be confused with behavior failures.
- **Reality check:** the sibling packages' existing wiring.

### Stage 5 — Agent Code runtime adapter

- **Produces:** `OpencodeTerminalSession` rewritten as a thin translator (the
  job `claudeSession.ts` does): headless activity → `process-state`, semantic →
  `semantic-event`, committed → `jsonl-entry(record,
  'opencode://session/<id>')`, conditions → `conditions`, plus
  `resolveCondition`.

  **Corrected after review:** paste delivery is NOT unchanged. It was replaced
  by `headless.submitPrompt`, an HTTP `prompt_async` submission, because a
  booting TUI silently swallows a paste and Agent Code was reporting success
  for prompts nobody received (#877). The 250 ms readiness grace survives, but
  only as a UI hint: it no longer gates delivery, because first paint proves
  neither that the composer mounted nor that it consumed anything.
- **Verified by:** adapter tests with a fake headless: the event mapping,
  identity entry, heartbeat while active, and `stop()`/exit ordering.
- **Why separate:** the package must remain usable (and testable) without Agent
  Code. The adapter is the only place Agent Code vocabulary meets package
  vocabulary.
- **Reality check:** the existing adapter tests and the structured runtime's
  mapping (`opencodeSession.ts`).

### Stage 6 — Agent Code read paths

- **Produces:**
  - An OpenCode history source in main (registry hook, backed by the package's
    `readHistory`), used by `historyLoader` for both OpenCode runtimes.
  - The renderer's terminal-runtime history skips lifted.
  - `AgentTranscriptReader` support for `opencode://session/<id>`.
  - Agent Management publishing that locator with `availability: 'available'`.
- **Verified by:** a history loader system test over a fixture database, a
  renderer test that a terminal-runtime pane loads history without mounting a
  feed, and transcript-reader tests over a fixture database.
- **Why separate:** these are consumers. They must be written against the
  already-verified record shape, not while that shape is still moving.
- **Reality check:** Stage 0 durable fixtures loaded into a SQLite file.

## What is being isolated

- **`src/reconcile/` in the package.** The only module that sees both durable
  records and live events. Its single consumer is `OpencodeTerminalHeadless`.
  Forbidden importers: `transcript/`, `live/`, `channels/`, `conditions/`,
  `launch/`, `terminal/`, and all of Agent Code (Agent Code imports the package
  root only).
- **`src/transcript/` in the package.** The only code that knows OpenCode's SQL
  schema. Agent Code reaches it only through the exported `readHistory` /
  `openOpencodeStore` API, never through SQL of its own.

## Stage 0 results (2026-09-10)

Full evidence: `packages/opencode-terminal-headless/research/census-2026-09-10.md`.
The census covered 50 real sessions with event logs; the sandbox probe recorded
six live scenarios on OpenCode 1.18.30. The design holds. The evidence
sharpened these rules, which the stages now implement:

1. **Turn boundaries come only from the live channel. This is now proven, not
   chosen.**
   - The last assistant message of a user turn has `finish: "tool-calls"` in
     139 of 450 turns (aborts and interruptions), and no finish at all in 47.
   - A durable-derived "turn ended" rule would be wrong about 30% of the time.
2. **One live turn is one `busy → idle` span.**
   - `busy` repeats 2–5 times inside a span.
   - A prompt queued while busy runs inside the same span, so one turn can
     commit several user messages.
   - `session.idle` arrives together with the final `status: idle`.
3. **Assistant commit happens on `time.completed`.**
   - Nothing changes an assistant message after that write: 0 exceptions in
     6,684 messages.
   - `finish` is set one write earlier, so it is not the commit signal.
4. **User commit happens when the first assistant with `parentID === user.id`
   appears.**
   - Later rewrites are ignored. 6,962 of them were seen; only `summary`
     changes, and 4 sessions additionally rewrite a `compaction` part.
5. **History comes from the projection, never from replaying the log.**
   Messages seeded by `opencode import` never appear in the log (55 messages
   in 5 sessions).
6. **The live-event doorbell is valid.** Every recorded durable row was
   readable before its bus event arrived.
7. **The live channel needs a connect deadline and a visible diagnostic.**
   - If the pre-allocated port is lost to a race, the TUI neither exits nor
     paints (0 bytes in 25 s).
   - Requests also block while a project instance boots.
   - `live-state { connected: false, reason: 'server-unreachable' }` is
     emitted after the deadline. The durable channel keeps running on its own
     fallback poll.
8. **Permission and question shapes are pinned by recordings.**
   - `permission.asked { id, sessionID, permission, patterns, metadata,
     always, tool }` / `permission.replied { requestID, reply }`.
   - `question.asked { id, sessionID, questions[] }` /
     `question.rejected|replied { requestID }`.
   - The condition title is built from `permission` and `patterns`.
9. **Startup and per-turn noise is ignored.** That covers `plugin.added` ×90,
   `catalog.updated`, `integration.updated`, `reference.updated`,
   `session.diff`, `message.part.delta` and `file.*`.

Incidental finding for the structured runtime, not this feature:
`opencode-headless`'s permission title lookup (`title`/`tool`/`action`) no
longer matches the 1.18.30 payload, where `tool` is an object and the verb is
in `permission`. The structured runtime's permission modal therefore has no
title.

## Unknowns

Status after Stage 0:
- **Resolved:** 1, 2, 3, 4, 5, 7, 8, 9 and 12.
- **Still open:** 6 (child-session permission surfacing; the free model never
  delegated), 10 (checked by the Stage 1 system test) and 11 (checked in
  Stage 6).

Status after Stage 6 (2026-09-11):
- **11 resolved.** Loading history into a terminal pane's runtime cannot leak
  the feed. `getEffectiveAgentSurface` pins the runtime to the terminal
  surface in every view mode, and `commandAllowedByRenderedViewPolicy` hides
  every feed-only command for it whatever `entries` holds. The renderer test
  replays a recorded session live, reloads the pane from the same database,
  and checks all three facts: the reloaded entries equal the live ones, the
  surface stays `terminal`, and feed commands stay hidden.
- **10 mitigated, not measured.** A busy read is classified (`busy`) and
  retried on the reader's next wake instead of failing the channel. The
  replay rig writes with immediate transactions beside the reader, and the
  live TUI test passed, but neither counts how often BUSY happens.
- **6 still open.**

1. The v1.18.30 bus names and payloads for `session.status`, permission,
   question and delta events (the sibling research is from 1.14.39).
2. Whether TUI `--port` + password works as the source reads, including auth
   enforcement.
3. Port-already-bound behavior. Does the TUI exit, or run without a server?
4. Re-sync endpoints for status and pending requests.
5. Queued-prompt status sequence.
6. Child-session permission surfacing.
7. Durable ordering invariants 2–5 above. Invariant 3 is the one most likely to
   have exceptions (usage backfill).
8. Compaction shapes in the log (5 local compaction parts exist).
9. `message.removed` semantics for already-committed messages. Planned default:
   ignore, matching the structured runtime.
10. `SQLITE_BUSY` frequency for a read-only `node:sqlite` reader beside a live
    writer (Stage 1 system test).
11. How the renderer's history merge behaves for a terminal pane once the skips
    are lifted: hidden feed state and command availability (Stage 6).
12. Whether OpenCode's HTTP server behaves identically under the TUI worker and
    under `opencode serve`: headers, directory scoping (Stage 0/2).

## Fixture plan

- **Durable fixtures (Stage 0 census extractor):** real event logs and
  projection rows from the user's database.
  - **Kept:** structure and every enum/identifier field. That means `type`,
    `role`, `finish`, `status`, tool names, part types, ids and timestamps.
  - **Replaced:** every free-text value (prompts, answers, reasoning, tool
    input/output, paths, commands, titles), with deterministic placeholders
    that preserve length class. That makes the fixtures safe for a public repo.
  - **Selection:** chosen to cover every shape the census finds — simple
    text, reasoning, multi-step tool turns, errors/aborts, compaction, removal,
    a parent with a `task` child, and an imported session whose log starts
    mid-history.
- **Live fixtures (Stage 0 sandbox probe):** real SSE and durable rows from a
  sandbox run with a free model, trivial prompts and a temporary project
  directory.
  - No user data, so kept verbatim except that sandbox paths are normalized to
    `/sandbox`.
  - Coverage: a plain turn, a multi-step tool turn, a permission prompt
    answered over HTTP, a question rejected over HTTP, and a queued prompt.
- **The oracle is never the reader.**
  - Durable expectations come from OpenCode's own projection tables.
  - Live expectations come from the recording's own `session.status` events.
  - Ordering expectations come from the renderer rules documented in #864.
