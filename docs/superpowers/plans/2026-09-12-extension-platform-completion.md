# Extension platform completion

Status: active implementation loop. Continues PR #577 from clean foundation `e13a9910`.
Tracking issue: #934. Latest integrated main: `69d3022a`.

The maintainer authorized completing the reviewed platform on 2026-09-12, including
implementation, tests, review, SDK/example updates, and PR synchronization. Merging
requires a separate explicit instruction. This plan is the current execution record;
the July plans preserve historical reasoning but their snapshots, same-realm design,
and no-new-test instructions do not describe the implementation being completed.

## Outcome and boundaries

A user can author an extension against the published SDK contract, install a built
GitHub/local bundle, use its commands/settings/views, close and restore views, restart
Agent Code, update code and permissions, recover an interrupted update, and uninstall
without losing saved extension data. Requested background work continues with no view
open. Each view has explicit identity and commands have deterministic ownership.

The accepted backlog also includes scoped filesystem/transcript/Git reads, prompt/file/
Git writes, network access, and contributed themes. Each capability ships only with a
complete manifest/consent/broker/SDK implementation and meaningful boundary tests.
Hosted third-party MCP server processes (#244), a marketplace, arbitrary host React,
custom feed/tool-result rendering, and automatic merges are outside this continuation.

## Invariants and design decisions

- Extension code stays in isolated frames and never receives the host preload API.
  Source-window and origin checks, capability enforcement, and bounded messages remain
  requirements for every new route. Genuine keyboard input must not become authority
  that an extension can forge through arbitrary postMessage commands.
- Background activation is explicit. A managed runtime owns extension-wide state and
  commands; view lifetime must not accidentally create or destroy that shared state.
  The current closure-bound `registerView` ABI cannot simply move functions into another
  frame. Resolve the SDK/view-module boundary explicitly, preserving or clearly migrating
  existing bundles, before implementing a second execution context.
- Metadata contributions remain discoverable without executing extension code.
- Namespaced IDs, first-party keybinding precedence with reported conflicts, per-extension
  settings, and state/keybinding preservation on uninstall remain product contracts.
- Extension panes own durable workspace metadata but no provider process. Every restore,
  close, Dispatch, and command path must respect that distinction.
- Installed code identity covers every served file. Bundle, ledger, and grant changes
  have a recoverable transaction boundary; housekeeping must never delete the last valid
  version after an interrupted update.
  New installations use immutable generation directories. One atomic ledger replacement
  publishes the generation, full content hash and approved manifest permissions together.
  This avoids an in-place directory swap plus a second grant-file commit: before publish
  the old generation remains valid; after publish the new generation is complete. Legacy
  records retain their existing grant checks until reinstalled. Cleanup removes only
  unreferenced generations, and preserves ambiguous backups left by the older installer.
- Extension state is separate from disposable bundles and the renderer's persisted
  Settings blob. Scope powerful APIs to explicit project/session authority; do not expose
  generic preload calls, unrestricted file paths, or shell execution as shortcuts.
- Keep substantial WHY comments adjacent to decisions. Tests exercise observable
  behavior and safety/recovery boundaries rather than source-string implementation.

## Execution loop

For each checkpoint: inspect current evidence, reproduce the relevant failure in an
isolated environment, implement the smallest coherent change, run targeted checks,
review the actual diff, repair failures, and commit with the evidence and next step.
Update this checklist and the tracking issue/PR as scope or evidence changes. Continue
until the acceptance matrix is complete; a green narrow test is not task completion.
Keep a concise session status and preserve unrelated work in other worktrees.

## Checkpoints

- [x] **1. Current baseline.** Merge a captured current-main commit into this existing
  PR branch without rewriting its history; reconcile changed workspace/command/settings
  contracts; isolate node_modules/submodules; establish typecheck and relevant suite
  baseline. Retain evidence for unrelated baseline failures.
- [x] **2. Runtime and SDK contract.** Implement requested startup/lazy activation,
  extension-wide command ownership, independent view lifecycle, bounded activation and
  shutdown, and useful state/error reporting. Verify a headless command-only extension
  and multiple views against one shared runtime. Update the companion SDK in its own PR.
- [ ] **3. Commands and panes.** Add command acknowledgements/errors and bounded pending
  invocation handling. Repair focus and genuine keyboard routing, Dispatch panel opening,
  detached/buried restoration, undo, and layout transitions without spawning providers.
- [ ] **4. Installation and authority.** Recover interrupted bundle/ledger/grant commits;
  serialize concurrent changes; use full bundle identity for reload and consent; invalidate
  stale runtimes/grants on update/remove; bound archive/hash/storage work and verify origin,
  traversal, capability denial, and network isolation behavior in the real frame boundary.
- [ ] **5. Startup and management UX.** Prevent blank metadata from breaking host
  registries; guarantee theme-before-mount; bound activation failures; provide retry and
  accurate install/remove/permission state; group settings by extension and report binding
  conflicts without losing either extension's metadata.
- [ ] **6. Complete capability/contribution scope.** Add scoped read/write/service APIs
  and themes using current app-owned services. Each route must enforce installed-byte
  identity, consent and target scope; unsupported capabilities must fail clearly. Preserve
  the existing first-party command, theme and settings ownership contracts.
- [x] **7. Authoring and examples.** Align SDK source, generated output, manifest schema,
  authoring guide and examples. Move Timer shared state into its runtime, consume declared
  settings, exercise permissioned observation and closed-view reminders, and validate
  committed build artifacts from a clean checkout. Migrate Mini Games from its v1
  same-document modal to v2 runtime/view modules and validate the actual bundle through
  Agent Code's installer, scheme and modal lifecycle. Keep companion work reviewable.
- [ ] **8. End-to-end acceptance and review.** Run the matrix below, full relevant local
  checks, build/package verification, and current CI. Review changes for security,
  lifecycle, data recovery, accessibility and unrelated diffs; fix every valid finding.
  Update PR descriptions around final behavior and report exact verification/limitations.

## Acceptance matrix

Use isolated state directories, local fixtures and disposable projects. Never install
test bundles into the maintainer's real extension state or prompt a real agent as a test.
The maintainer explicitly emphasized broad integration coverage on 2026-09-12. Treat
the matrix as required executable integration coverage wherever practical, including
failure/race paths. Test real installer/storage/IPC/frame/runtime boundaries rather than
only helpers or mocked return values; add each regression alongside its implementation.

| Journey | Required evidence |
| --- | --- |
| Clean author build and local/GitHub install | SDK contract, bundled JS/CSS, consent, visible contributions |
| Cold command with no views | One activation, one command execution, result/error acknowledgement |
| Background Timer with zero/one/multiple views | One engine, continued reminders, consistent settings/state |
| Pane/modal interaction | Focus, shortcuts, sizing, theme, close/undo and focus restoration |
| Grid/Dispatch/spotlight/detached/buried | Placement and restore preserve metadata; no provider spawn |
| App restart | Requested startup activation and durable views/state restore correctly |
| Code and permission updates | All assets change runtime identity; consent and revocation reach live code |
| Cancel/failure/crash/concurrent install | Recoverable old/new version and matching ledger/grants |
| Malformed/hostile bundle or messages | Bounded resource use and enforced origin/capability/target scope |
| Uninstall/reinstall | Runtime stopped and contributions removed; user data retained |
| Packaged Electron | Production file origin, scheme/CSP, frame startup, installed built artifact |
| Mini Games migration | Four command-routed modal entries install, open directly, close and reopen from its committed v2 bundle |

## Progress and evidence

- Read-only review completed at PR head `9dad5b13`: 100-file diff, all extension-specific
  files, plans, discussion/history, SDK, and Timer example source. Findings are source
  review observations until reproduced. Last recorded CI success was 2026-08-28.
- Existing extension worktree was clean at takeover. The root worktree has an unrelated
  untracked loose-ends plan and other worktrees are active; leave them untouched.
- Integrated main `552914f5` and its pinned submodules. Replaced only this worktree's
  node_modules symlink with an independent Node 24 `npm ci --include=dev` install.
  Reconciled terminal parity, provider wake/undo metadata and external command routing.
- Integration verification: control SDK typecheck and workflow-mcp build passed;
  `tsc -b --pretty false` passed after reconciling merge errors. Focused command targeting,
  ownership and Dispatch checks passed (38 tests); extension/installer and pane/session
  recovery checks passed (104 tests). Full platform/Electron acceptance remains pending.
- Installer filesystem tests now mock the state location into a temporary directory;
  denying consent alone did not isolate staging or tier-zero installations.
- Reproduced four placement/undo failures with a renderer regression suite. Extension
  views now open as detached rows in the focused Dispatch project/lane, and both detached
  undo paths restore UI metadata without spawning providers. The regression suite plus
  existing terminal placement and MCP continuity checks passed (19 tests); app typecheck
  passed. This completes part of checkpoint 3; runtime, focus and keyboard work remain.
- Installation publication now uses immutable generation directories and one atomic
  ledger write for code identity plus approved permissions. Real filesystem tests capture
  disk state immediately before/after publication and restore those crash snapshots;
  both recover to matching code and consent. Coverage also checks failed publication,
  concurrent installs, active staging during cleanup, corruption, legacy migration,
  asset-only changes, tampering, stale generation URLs, removal and data preservation.
  All extension suites pass (99 tests). Ambiguous pre-generation backups are preserved.
  Live cross-window invalidation and resource bounds are still part of checkpoint 4.
- Main now publishes catalog changes to every window. One renderer catalog orders list
  responses against publication events, and stale frame brokers reject requests before
  React teardown (including requests awaiting permission lookup). Settings and missing
  panes expose load failures with retry; failed removals retain their row. Eight renderer
  regressions pass. This verifies the broker/store behavior; real Electron multiwindow
  and focus/keyboard acceptance still remain.
- Bundle hashing streams bounded chunks, counts empty directories and rejects oversized
  files before allocating contents. Local staging checks entry/depth/byte budgets before
  copying. A digest captured from the old implementation verifies legacy grants remain
  compatible. All 111 extension and catalog tests plus app typecheck pass. Compressed
  archive extraction and message/storage quotas still need the remaining boundary audit.
- First real Electron 43.1.1 probe ran the actual scheme handler and installer with
  isolated state and a sandboxed iframe inside a file-origin host. The child reported
  `window.api` undefined and denied access to the parent's sentinel API. It also
  reproduced mounting before the first theme push: the mount callback saw an empty
  `--theme-canvas`. The mounted guard prevents duplicate mounting, so the observed
  defect is initial ordering, not duplicate mounts. Next: commit a repeatable Electron
  regression harness, repair the activation/theme/mount handshake and bounded startup,
  then implement the explicit shared-runtime/view-module SDK boundary.
- The repeatable Electron system test now passes 16 startup/storage/isolation/recovery
  scenarios through the actual installer, IPC, sandboxed frame and React bridge, using
  the production parent/child CSP and isolated file-origin host. The initial red run
  reproduced the empty theme at first mount. Activation and parent intent now meet at
  one theme-before-mount gate, readiness waits for successful mounting, and the host
  enforces a 10-second startup deadline with an actionable cause and fresh Retry.
  Chromium's frame tree verifies failed documents are actually destroyed. Named and
  default-exported modules both load, matching the SDK's documented defineExtension
  form. Missing exports/views/bundles, syntax and mount errors, no bootstrap, permission
  denial, storage calls and a hung activation are executable regressions.
- The Electron test runs in the ordinary system suite and CI; dependency setup prepares
  Electron explicitly because v43 otherwise downloads on import. Tests do not download
  binaries or load ambient env files. The original 111 focused checks remained green;
  the new stale-reply regression raises focused coverage to 112, and the final affected
  frame/catalog run passed 22 checks. App typecheck and testing contract passed. CI at
  committed head `37dd073e` passed both quality-gate and minimum-node-fixture-gate; the
  new startup commit still requires its own CI run.
- Next checkpoint remains the shared runtime. Current main's control host already
  observes all registered windows with generation-bound renderer ownership; use curated
  adapters over those services rather than treating a hidden window's empty Zustand
  store as global workspace state. The public v2 contract must separate runtime and view
  entry modules, keep legacy v1 view bundles explicit, and verify one engine across zero,
  one and multiple views before claiming background activation complete.
- The managed runtime transport is now implemented behind a main-owned service. It
  creates one isolated, nonfocusable browser context per active extension, with a narrow
  sender-bound preload, bounded JSON/IPC/call queues, command results, view request
  identity and published state. Publication synchronously retires an updated/removed
  generation and rejects its pending calls. A command deadline destroys the stalled
  runtime and reports an unknown outcome without replaying it. Direct external requests,
  popups and renderer navigation are denied in its private browser session.
- A second real Electron system journey exercises this private service using actual
  installs: 40 concurrent cold calls admit the bounded 32 and activate once; two logical
  view requests share state; the engine ticks with no visible views; command errors do
  not restart it; update, timeout, uninstall and reinstall preserve the expected storage
  and reject stale work. Activation failures/hangs, namespace spoofing, host preload/Node
  isolation and a local HTTP egress probe also pass. The full focused run now passes
  118 tests, including both Electron journeys. This is the transport foundation, not
  completed public background support: manifest v2, its SDK, activation routing and
  separately mounted view modules still need wiring and real UI acceptance.
- Main advanced by 13 commits to `115e26fc` while this checkpoint was built. GitHub now
  reports merge conflicts and has not scheduled CI for `2eae57bb`; its baseRefOid response
  still showed the old merge base, while git/compare proved the divergence. Integrate
  this captured main after committing the runtime checkpoint, then resume v2 wiring.

- Integrated main `115e26fc` in merge commit `3ff8d9a1`, preserving TLDR history
  and extension surfaces. Combined typecheck passed; 147 of 148 checks passed and
  the remaining filesystem fixture exceeded its setup deadline creating 10,100
  directories. Commit `86183463` now tests the real walker at and above a smaller
  injected threshold; all nine hash checks pass with production limits unchanged.
- Normal runtime retirement now revokes authority immediately, sends an explicit
  shutdown request, waits at most 500 ms for cleanup, and destroys the window.
  Replacement activation waits for teardown; failure/unknown command outcomes still
  force immediate destruction. Browser-storage clears are serialized so a late old
  clear cannot race a replacement. The real Electron journey verifies asynchronous
  deactivate/subscription cleanup, denied writes during retirement, hung cleanup,
  replacement startup and idempotent disposal with no surviving runtime windows.
  The launcher also requires an explicit completion record after assertions/teardown.
  Public v2 view modules, SDK and activation routing remain the next checkpoint.

- Main-side view connections now fix owner, installation revision, view id and a
  host-minted instance id. Ownership is inserted before activation and checked again
  after each await; detach/window-close or publication cannot resurrect an attachment
  or deliver a reply to a replacement. Published state carries a per-view sequence
  for ordering initial snapshots against pushes. Real Electron tests verify two owners,
  namespace isolation, shared state, connection limits, close during attach/request,
  replacement of a pending attachment and update revocation. Typecheck passes. These
  are logical view clients against the real service; actual v2 iframe modules and the
  application IPC adapter remain to be wired before the public version gate advances.

- Public v2 wiring is in progress: separate per-view entry validation/containment,
  a registered-application-frame IPC adapter with navigation generation checks,
  correlated palette commands, independent iframe mount contexts and sequenced
  state subscriptions. Startup/lazy activation events now govern cold engines;
  installs/updates start explicitly requested background runtimes. Quit pauses the
  reusable service during the cancellable native-window phase and resumes it after
  a veto; final session shutdown disposes it. The narrow Electron journey passes
  explicit activation, update reconciliation and pause/resume regressions, and
  typecheck passes. The full Electron journey reached every legacy and public v2
  assertion (two actual windows, shared state, cold command and zero-view ticking)
  but the new completion check caught the fixture exiting during final cleanup.
  A window-all-closed keepalive now matches the runtime fixture; rerun pending.
  SDK/Timer migration, native focus/shortcuts, service capabilities and the complete
  application/restart acceptance matrix remain open.

- Public v2 frame rerun now passes with its completion record: all legacy frame
  journeys plus real command-before-view, independent modules in two application
  windows, shared published state and continued zero-view work. The standalone
  runtime journey passes its expanded activation and pause/resume coverage; 119
  other focused checks pass and typecheck passes. CI at committed foundation
  `54b29767` passed quality-gate (9m41s) and minimum-node-fixture-gate (48s).
  SDK v2 types/build support has begun in companion PR #1, with plan commit
  `f251605`; its generated output and author fixture still need verification/pinning.

- Verified the actual production preload build and ran the full managed-runtime
  journey against its emitted `out/preload/extensionRuntime.js`, including its
  `.js` loading semantics in the sandbox. The app preload remains unchanged;
  a build plugin emits the runtime as one independent CommonJS asset and watches
  its inputs. electron-vite 5's experimental isolatedEntries mode failed in a
  non-TTY build (stdout.clearLine); explicit esbuild emission avoids that path.
  Rechecking the runtime after startup snapshot/publication locking also passes.

- SDK 0.4.0 is committed at `05f97d2` in companion PR #1. Its clean install,
  compilation/type contracts, real multi-entry author build/import and legacy
  single-entry/dynamic-import build pass; rebuilding leaves committed dist clean.
  The host Electron fixture now builds and installs those public SDK artifacts.
  Its renderer build is still running under heavy local contention, so that exact
  artifact journey remains pending. The host guide now distinguishes v2 ownership,
  activation and cleanup from retained v1 semantics. A real runtime regression
  also verifies that closing a view before dispatch cancels author execution,
  while already dispatched work finishes at most once and its stale reply is denied.

- Storage boundary work has started with real filesystem regressions. The initial
  run reproduces corrupt-file replacement, unbounded saved state/queued work,
  unsafe values, mutable queued inputs and residue after failed publication.
  Repair must preserve unreadable bytes, bound JSON and aggregate state, serialize
  reads with writes, and release idle queues. This belongs to checkpoint 4 and
  must pass its own regression and runtime journeys before completion is claimed.

- The SDK-built artifact journey completed successfully, including every legacy
  and public-v2 assertion plus teardown. Its local renderer build took 733 seconds
  under contention; the standalone run has no build deadline, while the ordinary
  system wrapper still enforces six minutes. SDK CI passed both push/PR authoring
  jobs at `05f97d2`. Host CI at `e617f682` is still running.
- Storage repair passes 58 focused storage/install/grant checks and the real
  managed-runtime journey. It preserves corrupt/unreadable data, bounds per-value
  JSON and aggregate bytes/keys, snapshots queued inputs, serializes reads/writes,
  bounds admission and removes failed staging files/idle queues. The final 14 storage
  regressions pass, including invalid-UTF-8 preservation and global admission.
  Final app typecheck passes. Saved files that exceed the new limits or are corrupt
  remain untouched and report errors; no automatic destructive reset is performed.

- Native focus/shortcut work is now implemented locally and under verification.
  The input grammar is shared by the renderer resolver and a main-owned native
  input gate. Only registered application main frames configure capture; genuine
  Electron input identifies its focused child document. Parent-owned iframe and
  per-document URL identity reject stale/other-instance events and child message
  forgeries. Pane focus commits before routing a command; keyboard selection also
  moves DOM focus into the view. Modal capture retains palette/own-surface close
  while leaving native editing in the author document. The real Electron journey
  now exercises the actual command router and a real Dialog shell. Five new DOM
  routing regressions plus existing keyboard checks passed (55 total before the
  modal extension); the expanded Electron run/typecheck remain in progress.
- CI at `999a7451` passed its ordinary suites but failed the coverage rerun on one
  timing assertion: the zero-view timer had not ticked after exactly 100 ms (3869
  other checks passed). The test now polls read-only state for bounded progress,
  preserving the one-engine/zero-view invariant without assuming a scheduler
  timeslice. This is an implementation-test repair under #934, not a new issue.

- The expanded native-input Electron journey now passes, including its final
  teardown record: genuine pane commands commit focus first, custom palette
  bindings route once, forged child input and stale document packets are denied,
  modal Option editing remains native, and modal close destroys its own surface.
  The same run passes SDK-built two-window/shared-state and zero-view progress
  checks. Final app typecheck passes after correcting fixture helper types.
  All 57 focused keyboard checks pass, including DOM repeat/release forwarding
  and focus moving during selection; the DOM suite performs no network fetches.
  The full-app focus/hold/restore matrix remains required.

- Next contribution checkpoint: themes are declarative manifest data, available
  without activating author code. Validate namespaced ids, known appearance
  tokens and bounded literal colors at install, then resolve them through the
  existing appearance picker/application path. A dedicated `extension-theme:`
  selection cannot collide with built-ins or user-saved themes. Preserve that
  selection while its bundle is absent; render the built-in fallback and restore
  the theme on reinstall/catalog arrival. Updates replace colors without copying
  them into user-owned saved themes. The phone receives a resolved presentation
  payload, never an unresolved extension id or an extension registry of its own.
  Verify install rejection, catalog/update/removal/reinstall, selected theme
  persistence, first-party theme ownership, live CSS and SDK author artifacts.

- Native input is committed/pushed at `ed597fb2` with 57 focused checks, final
  typecheck and the complete Electron journey passing. GitHub has not scheduled
  checks for this head yet; main has advanced to `c87448ab`, which will be
  reconciled after the current theme checkpoint is committed.
- Declarative themes now pass 90 focused manifest/appearance/install checks,
  SDK 0.5.0 author type/build tests, generated-dist verification and the full
  real Electron journey. The latter installs the SDK-built contribution, selects
  it through the actual appearance picker without activating code, delivers its
  colors before view mount, updates it, preserves the prior palette after an
  invalid URL-bearing update, falls back on uninstall and restores on reinstall.
  A regression reproduced missing API colors when an inline palette preceded
  stylesheet discovery; the frame API now seeds the canonical 81-color
  vocabulary. Final app typecheck passes. Scoped service capabilities and the
  remaining acceptance matrix are still open.

- Integrated current main `c87448ab`. Its Goal/TLDR hold route and customized
  binding precedence overlap the extension native-input router; the resolution
  retains both, with extension declarations joining shipped defaults before
  one shared user-override pass. The merged focused run passes 190 tests across
  manifest/install/theme/keyboard/Goal contracts, and merged app typecheck
  passes. Full Electron did not need repeating for a conflict limited to binding
  ordering; the prior theme/native journey exercised the production router.

- Integrated current main `69d3022a`. Its performance collector startup landed at
  the same composition point as extension scheme/runtime initialization; both now
  start before any application window, preserving complete startup observations and
  preventing an early extension frame from racing registration or install cleanup.
  The incoming collector/coordinator/probe tests and combined app typecheck pass.

- The first scoped service capability, `fs.read`, is complete for API v2 runtimes
  and views. Every read names a live session; main derives its spawn cwd, applies
  the editor's traversal/symlink protections, accepts only UTF-8 files and caps the
  result at 96 KiB. Consent is verified against installed bytes once per immutable
  generation and publication revokes the cached authority without cancelling an
  unrelated extension. The manifest rejects this capability for frozen API v1.
  Sixty-two focused manifest/schema/broker/filesystem checks and app typecheck pass.
  Both real Electron journeys pass: the managed-runtime fixture covers consent and
  traversal/binary/size/target denial through the production preload, while the
  full journey calls the SDK-built API from both its runtime and sandboxed view.
  SDK 0.6.0 is pinned at `aa2084b`, with generated output and author contracts.

- The accumulated implementation history was rebuilt into one reviewable foundation
  commit, `e13a9910`, on current main; its tree differs only by the intentionally newer
  SDK gitlink. Exact pre-cleanup backup branches retain both original histories. PR #577's
  three obsolete July status dumps were removed after confirming there were no review
  comments, and both root CI gates pass on the cleaned head. The SDK was likewise rebuilt
  as one foundation commit before later service work, with its authoring CI green.

- Scoped project writes now use an explicit `fs.write` grant and API v2 only. A write
  names a live session and relative project path, accepts UTF-8 text up to 64 KiB, denies
  traversal and symlinks, and publishes atomically through the editor's serialized file
  mutation path. Creation requires `expectedVersion: null`; replacement requires the
  opaque version returned by `readText`, so concurrent editor/agent/extension changes
  reject instead of being overwritten. Consent distinguishes mutating access and editor
  caches are invalidated after publication. Seventy-four focused schema, manifest,
  permission, broker and real-filesystem checks pass, including concurrent compare-and-
  swap, stale versions, binary text, oversized data and containment failures. Typecheck,
  the production-preload runtime journey and the full SDK-built Electron journey pass.
  SDK 0.7.0 commit `9c30b919` supplies matching types, docs and runtime/view author tests.

- The Mini Games 0.8.0 migration now builds an empty managed runtime plus one shared view
  module behind four declarative modal ids. Command and view ids intentionally match so
  a cold game command opens the requested route without background DOM or an extra
  message protocol. Its 22 deterministic engine checks, API v2 manifest/artifact contract,
  typecheck/build, and Chromium interaction suite pass. The host's reusable external-
  bundle Electron path installs the actual source bundle, mounts all four routes through
  the production custom scheme and Dialog shell, closes each surface, and verifies a
  reopen gets a fresh sandbox document while the complete host lifecycle/security/theme
  journey remains green. Companion commit `5385992` is published for review in Mini
  Games PR #9; its CI and the host/SDK dependency chain must remain green before merge.

- Background status notifications ship as API v2 `notifications.show` (commit `29c4ae2f`).
  A runtime or view posts a trimmed message of at most 200 characters; main verifies
  consent against the installed generation and broadcasts one event that every window
  renders as a toast attributed to the extension's catalog name. API v1 rejects the
  capability. Schema, manifest, consent, renderer broker and toast attribution tests pass,
  and the SDK-built managed fixture posts a runtime notification in the full Electron
  journey. SDK 0.8.0 commit `96acc89` supplies types, contexts, docs and author fixtures.
  Safety is intentionally proportional (maintainer direction, 2026-09-12): declared
  permission, bounded text and host attribution, no rate limiting or notification center.

- Timer 0.4.0 moves to an API v2 runtime (companion commit `65519c5`). One engine owns
  timing, commands, reminders and wall-clock persistence; the panel subscribes to published
  state; completion and reminders use `notifications.show`. The external-bundle Electron
  path now runs a command with no view mounted, reads the view, closes it, waits and
  requires the countdown to have advanced on reopen. The first run failed before that
  check: the host refused `onView:timer.main` because Timer declares only
  `onStartupFinished` and the harness installs it before startup activation is enabled.
  The same refusal strands any startup extension after a crash, command deadline or failed
  activation until app restart. `onStartupFinished` now grants `*` eligibility (commit
  `4ff23df3`); lazy extensions keep exact matching, and the runtime journey covers a cold
  command on an installed-but-stopped startup extension without a duplicate activation.

- Integrated current main `173a5702` in merge `d810f130`; no extension files overlapped.
  On the merged tree, the notification schema/manifest/consent/broker/toast files pass
  (71 tests across 5 files) and app typecheck passes. The managed-runtime Electron journey
  passes, including the new cold startup reactivation check. The full production Electron
  journey passes with the committed Timer bundle: install, panel mount/close/reopen into a
  fresh sandbox document, and a viewless `timer.start` whose countdown advanced while the
  view was closed. Timer migration is published for review in
  https://github.com/Juliusolsson05/agent-code-timer/pull/2 and depends on SDK PR #1 and
  this PR. Transcript, Git, prompt and network services remain unimplemented for this
  release; manifests requesting them fail validation instead of receiving partial access.
