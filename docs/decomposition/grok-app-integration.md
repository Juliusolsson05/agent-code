# Grok App Integration

Continues the approved Grok provider design and agent-code#832. The user has
authorized component commits, pushes and linked PRs, but no merges. Parent
implements inline; orchestration agents perform independent read-only audits
and reviews of runtime, switching, rendering, streaming and test boundaries.

## A and D

A: reviewed Grok headless runtime/history/permission/relay contracts and Grok
parser decoder/archive/native-resume projectors exist in separate repositories.
The app branch now contains host publication and main 364e5a16. It pins the
reviewed parser and the owned native ACP/guard candidate; full provider runtime
and rendering registration remain the next integration stage.

D: an installed Grok CLI can be created/resumed and used as an Agent Code
provider, with correct session identity, transcript rendering, safe controls,
switch/duplicate/rewind persistence and desktop/phone delivery. Unsupported
native capabilities are explicit, not guessed to create apparent parity.

## Stages

1. Publish reviewed component changes and update the app branch to current
   main plus the exact pushed component revisions. Artifact: linked component
   PRs and source-only submodule pins. Verify package tests/typechecks/packed
   exports and inspect branch drift independently. Keep separate so old aliases
   cannot hide missing runtime/parser exports during app implementation.
2. Implement native transcript snapshot/persistence at the existing host
   adapter boundary. Artifact: Grok file-set adapter and transaction tests.
   Preserve separate summary metadata; never inject fake JSONL identity rows.
   Verify real parser projections and isolated filesystem publication, failure,
   no-clobber and rollback tests before depending on a live app session.
3. Implement Grok AgentSession/runtime and provider registrations together with
   explicit native rendering interpretation. Artifact: provider module and
   exhaustive registry/type coverage. Verify controlled PTY plus real terminal,
   history tailers and renderer ingestion against normalized recorded sessions.
   Keep physical reset/replay ownership in headless, app row ownership in app.
4. Connect switching, commands/setup/capabilities and desktop/phone surfaces.
   Artifact: integration tests covering source retirement, identity carry,
   history replacement and safe permission responses. Preserve current-main
   naming, delivery and retirement behavior; no independent Grok replacement
   transaction or shadow settings architecture.
5. Review completed changes and run deterministic app/package integration
   gates plus explicitly opted-in native loopback tests. Artifact: an app PR
   with accurate verification and remaining limitations. Never launch Electron
   or the Agent Code app; never infer release readiness from unit tests alone.

## Evidence and Isolation

The headless package owns 22 privacy-reviewed normalized native sessions,
native permission-card evidence, and minimized SSE captures. The parser owns
portable conversation semantics and loss reports. The app owns post-IPC
coalescing, renderer rows, session replacement transactions and phone delivery.
Tests consume those recorded contracts rather than invented Grok wire shapes.
No private prompts, credentials, raw home contents or full captures enter PRs.

## Unknowns and Gates

Main-turn versus sidecar streaming attribution, configured upstream/model
selection, trust/plan/MCP conditions, composer-readiness and native compaction
write sequences require source/evidence checks. Per-flow SSE is not by itself
safe app streaming; committed-only delivery is preferable to misattribution,
but must be reported honestly. History reset/caught-up is a byte boundary, not
provider idle. Native encrypted reasoning portability is not universally
verified. Component CI and app CI must be reported separately.

## Verified Stage Progress

Component PRs are now public: grok-code-headless#1 at c3ecb63 and
agent-transcript-parser#27 at 5c43207. Both have green package CI, including
Node 20.19.0 and Node 24. The app branch includes main 037da45b and those exact
source revisions; no headless file dependency or lockfile workaround was added.

The host contract now carries the complete projection through switch, duplicate
and rewind. The Grok file publisher validates native rows, counts, UUID/cwd and
format before reserving an exclusive directory; summary.json is published last
and atomically. Rollback never removes a directory another publisher owns.
Reads reject changing, partial, corrupt, unsupported-format and nonregular data.

Verified on Node 24: 62 switching unit tests, 9 real-filesystem/parser system
tests, full app typecheck, and one installed-Grok loopback test using the APP
publisher. The native test proves imported tool context reaches inference,
native system instructions are supplied and a new reply is appended without
re-executing historical tools. It does not prove general composer readiness.

Seven read-only orchestration agents audited architecture and reviewed the
host boundary. Verified format/FIFO findings were fixed and re-reviewed. The
runtime audit also required raw PTY output and process identity, now exposed
and verified in headless (150 deterministic tests). Runtime registration and
renderer consumption are NOT implemented by this publication stage.

## Source-Backed Follow-up Gates

- Grok's TUI PagerArgs does not expose the agent-subcommand --plugin-dir flag
  or a generic per-launch MCP config override. Do not invent that launch flag,
  overwrite user config, copy auth or claim built-in MCP is already supported.
- Empty/unfocused native composer placeholder text and transcript catch-up do
  not prove ready input. Capture actual focused-empty, multiline human draft,
  cleared composer and overlay states before enabling automated submission.
- App history replacement needs a correctness-bearing transport/store reset
  across desktop and phone. A diagnostic event cannot secretly become that
  contract, and native JSONL records must not contain invented reset rows.
- Upstream x-grok-session-id, x-grok-turn-idx and x-grok-req-id provide a
  candidate streaming attribution boundary. Verify against installed-native
  requests before enabling semantic rendering; matching output text is invalid.
- The initial registration must respect existing directory guards, agent-name
  identity carry, text delivery and session retirement from current main.

## Current-main continuation

Main 364e5a16 is integrated. Its new native Codex clone operation now passes one
complete TranscriptPublication to identity extraction and storage, with a
regression against the recorded native clone fixture. Full app typechecking and
84 provider-switch tests passed, followed by green app CI at 06719c38.

The app now pins headless 4814a17 (owned ACP plus framed TUI guard). The approved
automated-input route is ACP, superseding the older composer-paste gate above.
Native guard fault evidence is separate from full app/pane adoption; see
grok-native-control.md. Resume discovery must extend the new Conversations
catalog, and built-in MCP must preserve main's choice/reload and root-management
non-inheritance policy. The older package-wiring branch is already included;
continue implementation here rather than creating a competing integration.
