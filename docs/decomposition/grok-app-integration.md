# Grok App Integration

Continues the approved Grok provider design and agent-code#832. The user has
authorized component commits, pushes and linked PRs, but no merges. Parent
implements inline; orchestration agents perform independent read-only audits
and reviews of runtime, switching, rendering, streaming and test boundaries.

## A and D

A: reviewed Grok headless runtime/history/permission/relay contracts and Grok
parser decoder/archive/native-resume projectors exist in separate repositories.
The app branch contains package/build wiring only and is behind current main.

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
