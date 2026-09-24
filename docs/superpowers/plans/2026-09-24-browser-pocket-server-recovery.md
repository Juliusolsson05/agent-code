# Browser Pocket: ask the agent to restart a local server

Issue: [#1163](https://github.com/Juliusolsson05/agent-code/issues/1163)
Branch: `feat/browser-pocket-server-recovery`
Base: `origin/main` at `7feda94767c6c921c05aa75169c55c9a5728bf38`
Status: implemented; this file was the branch's first commit. Local verification is complete; the implementation PR will record full CI results.

## Outcome and scope

When a local development page cannot connect, the user can click **Try to restart** to ask the agent owning that browser pocket to restore the server. The request contains enough trusted application context to identify the project and local endpoint. The agent chooses the actual start command from its conversation and the project.

The first implementation is a complete request-and-feedback flow: send once, preserve drafts, handle provider refusal/queue/uncertainty, and provide Reload page / View agent. It does not promise to monitor task completion. Automatic reconnect and managed start-command replay are future changes, not prerequisites hidden inside this button.

This narrows the earlier conceptual proposal deliberately. Requiring historical PID records or a new health service would make recovery depend on discovery, precisely when a dead server has disappeared. The pocket owner, effective worktree, and local origin are sufficient to ask the right agent. A current matching PID may enrich the request but is never required or used as a kill target.

## Source investigation and resulting decisions

Read the repository README, AGENTS.md, the browser decomposition/design material, the later usability plan, current browser host/state/URL/port code, workspace delivery capabilities, provider delivery results, session wake and replacement behavior, and adjacent regression tests. The original decomposition still describes several superseded decisions (raw CDP, conditional leaf wrapping); current code and the merged usability changes are the implementation authority.

| Existing code | Verified behavior | Consequence for this change |
| --- | --- | --- |
| `src/renderer/src/features/browser-pocket/ui/BrowserPocketHost.tsx` | `did-fail-load` captures main-frame failures except ERR_ABORTED. `GuestOverlays` displays Retry. Retry bumps the guest generation; destruction awaits debugger unregister. | Integrate at the existing failure overlay. Preserve teardown sequencing; sending a prompt must not remount the guest. |
| `src/renderer/src/features/browser-pocket/state/pocketLiveStore.ts` | Transient state is keyed by pocketId, not SessionId, and is not autosaved. | Keep request UI state here or in a sibling pocket-scoped transient store, outside SessionMeta. |
| `src/shared/browserPocket/url.ts` | Shared HTTP(S) loopback classification already exists, including IPv6 loopback and `.localhost`. | Reuse it instead of matching `localhost` substrings. |
| `src/renderer/src/workspace/control/agents.ts` | `agents.prompt` wakes the exact session, rechecks it, then calls `window.api.deliverPrompt` without modifying the composer. | Follow this application delivery path directly; no MCP connection/configuration is required. |
| `src/shared/types/providerConfig.ts` | Prompt acceptance is user, queue, or transport; failures report retrySafe, disposition and write evidence. | A sent request is not a running/completed restart. Preserve uncertainty and never automatically replay. |
| `src/main/sessionManager.ts` | Delivery reserves a session while in flight and rejects overlap. Its operation ID is not a durable deduplication key. | Add synchronous pocket/request admission in the renderer too. Do not claim exactly-once execution across app restarts. |
| `src/renderer/src/features/session-text-delivery/deliverTextToSession.ts` | This helper edits a draft or pastes without Enter. | Do not use it for the restart button: the requested behavior is an explicit submitted agent task. |
| `src/renderer/src/features/browser-pocket/state/watchPlan.ts` | Terminal attribution is based on project and directory containment, not an explicit terminal owner relation. | Do not invent a single owning terminal or claim exclusive process ownership. |
| `src/main/browserPocket/LanePortWatcher.ts`, `lanePortsIo.ts`, `core/lanePorts.ts` | macOS discovery returns PID/port/URL/kind; disappearance removes entries. HTTP classification is cached by PID/port, and 5xx listeners are excluded. | Discovery is optional context, never a recovery eligibility/readiness gate. No scanner changes in this slice. |

## User experience

Eligible local connection failure:

> Can't connect to localhost:5173
>
> Ask this agent to start or restart the local server.
>
> **Try to restart** · Reload page

Clicking is the explicit request; no extra confirmation dialog or setup wizard. Maintain the browser view and current focus. **View agent** is an explicit navigation action using the existing Spotlight/agent navigation behavior, especially useful when the narrow layout currently hides the agent.

Feedback is based on delivery evidence:

| Result | Display and available actions |
| --- | --- |
| Wake/send in progress | `Sending request…`; disable duplicate sends; Reload page remains available. |
| `acceptance.kind === 'queue'` | `Queued for agent`; View agent and Reload page. This describes receipt, not a continuously tracked queue position. |
| `user` or `transport` acceptance | `Request sent`; View agent and Reload page. Do not display “Restarted” or infer execution started. |
| Proven no-write failure permitting same-session retry | Show the reason and a deliberate retry action; never retry in an effect/timer. |
| Refusal needing resolution or unusable session | Show the reason and View agent. The user resolves provider input, login, permission, or lifecycle state through existing UI. |
| Uncertain delivery or thrown IPC error after invocation | `Could not confirm delivery. Check the agent before sending again.` No automatic resend or ordinary retry button. |

After acceptance/uncertainty, retain the send guard for this failed target even if Reload page produces another failure. A page retry must never resubmit the prompt. Successful main-frame navigation or an explicit change to another URL ends this failure episode. In the first version, another restart request for the same unresolved episode is made through the agent conversation rather than an ambiguous resend button.

Ordinary remote-page errors retain Reload page. Browser renderer crashes retain their existing crash recovery controls. HTTP 4xx/5xx documents are not connection failures and are not newly intercepted. A server dying while an already-loaded page remains on screen is outside this trigger; its next failed navigation/reload exposes the action.

## Eligibility and context

Create a pure policy function that accepts structured failure and current application metadata:

- Browser Pocket is enabled and the pocket belongs to an existing agent session.
- The current failed main-frame URL is HTTP(S) loopback under `isLoopbackUrl`.
- The error represents a connection failure: initially ERR_CONNECTION_REFUSED, ERR_CONNECTION_RESET, ERR_CONNECTION_CLOSED, ERR_CONNECTION_FAILED, ERR_CONNECTION_TIMED_OUT, or ERR_TIMED_OUT. Verify numeric mappings against the installed Chromium/Electron definitions while implementing; store the explicit allowlist with a WHY comment and behavioral tests.
- Exclude ERR_ABORTED, DNS/name resolution errors, certificate/SSL errors, policy blocks, and renderer crashes. They do not establish that restarting the app server is appropriate.
- Do not require a live listener, known launch command, or browser MCP domain. Unsupported prompt delivery is handled through the existing provider contract, never by typing raw terminal bytes as a fallback.

Resolve context from the latest workspace, using the same effective worktree precedence as watchPlan: runtime workContext.worktreePath, then runtime projectDir, then session cwd. Use the failed URL, not merely the previously committed page URL. Normalize the URL, remove credentials/query/fragment from prompt context, and send origin/port; the raw destination remains local browser state for Reload page. Do not include page titles, HTML, terminal output, environment variables, or cookies in the generated request.

An optional PID comes only from a current port record for this exact session and matching endpoint, labeled as an observation. If matching is ambiguous, omit it. There is no new history database or OS command-line collection.

## Prompt contract

Generate a short fixed task plus a clearly labeled, JSON-encoded context block. Context strings are data, not commands. Example wording:

> The user clicked “Try to restart” for this agent's local browser page. Try to start or restart the development server for the project/worktree and local origin below. Use the launch instructions or command already established in this conversation or project. Check whether the correct server is already running before starting a duplicate. Verify any process belongs to this project before stopping it; an observed PID is only a hint. Keep the requested port if possible. This request is to restore the server without editing application source, project configuration, or dependencies. If recovery requires such changes or you cannot determine the correct command, explain what is needed. Verify the endpoint responds and report the result; if the port must change, report the new URL. Use browser tools to reopen it only if those tools are already available and permit the action.

The prompt must work without browser tools. It asks the existing agent to perform the task through its normal tool and permission system; it does not change provider settings, force-stop the current turn, create a new agent, or grant permission to operate on unrelated servers.

## Delivery and lifecycle design

Implement a feature-local `requestServerRestart` operation rather than expanding the workspace hook or adding main-process restart IPC. It uses the existing `ensureSessionLive` and `window.api.deliverPrompt` APIs and records a typed UI outcome in the transient recovery store.

1. Synchronously reserve the request for pocketId + failed target/episode before the first await. Store an operation token so mirrored surfaces and rapid clicks share one pending operation. Main's in-flight reservation is a second boundary, not the entire deduplication design.
2. Capture exact sessionId, pocketId, provider kind/runtime, project/worktree context and failure/URL identity. Resolve from pocket ownership, never lane index or focus. Use current state readers, not a captured Workspace snapshot across awaits.
3. Wake only that agent with a dedicated `browser-pocket.restart-request` WakeCaller, added to `src/shared/lifecycle/events.ts`. Do not change input-ready waits, interrupt the agent, or clear its native draft.
4. After wake, revalidate the exact captured target, effective worktree, pocket association, feature flag, operation token, and failed destination. If the session was remapped/replaced or the user navigated/recovered/detached before delivery, stop before writing. Do not follow the pocket into a successor agent mid-request. A subsequent user click can use its new owner.
5. Call `deliverPrompt` once. Preserve PromptDeliveryResult's acceptance and failure detail. Never call composer submit/setDraftInput/sendInput; never use an app-level watchdog timeout to treat a still-running delivery as retry-safe. A deliveryId may aid diagnostics but is not an idempotency guarantee.
6. A page change after bytes have been sent cannot retract the agent task. Stop displaying stale progress without resending or claiming cancellation. Late results may update only the surviving matching operation; they must not recreate forgotten pocket state.
7. Keep state across lane/Spotlight layout changes and guest-only remounts. Clear on successful navigation/new destination/detach/feature disable as appropriate, while pending operation tokens still prevent late writes. Do not persist/replay pending requests across app restart. Re-enable/remount must not trigger delivery.

For the first slice, use per-window pocket request admission consistent with existing renderer-owned pocket state. Simultaneous gestures in different app windows are not an exactly-once guarantee; do not expand this into a new durable job system. If later multi-window UX requires shared completed-request deduplication, it belongs with application operations, not provider keyboard emulation.

## Implementation sequence

1. **Policy and prompt construction.** Add `src/renderer/src/features/browser-pocket/recovery/policy.ts` and `prompt.ts`, with focused unit tests for eligible errors, URL handling, missing discovery and scoped context. Keep important choices as WHY comments in code.
2. **Delivery operation and transient state.** Add a small recovery store and `requestServerRestart.ts` under the same feature. Wire the WakeCaller and existing provider API. Test draft preservation, exact target and all delivery outcomes before adding UI.
3. **Failure UI integration.** Extract the failure portion of GuestOverlays into `PocketLoadFailure.tsx` if needed to keep the host focused on guest lifecycle. Supply current ownership/context through HostedPocket. Add Try to restart, Reload page, result feedback and View agent. Keep crash overlays and detach-before-remount behavior intact.
4. **Lifecycle integration.** Connect navigation, detach/feature disable and guest retirement to recovery cleanup. Preserve the failed destination through Reload page: the current Retry remount starts from `pocket.url`, which can still name the prior committed URL after an uncommitted navigation failure. Test that recovery reloads the attempted destination through the existing host path, not a stale page.
5. **Validation and implementation PR.** Run focused policy/store/renderer suites, browser host lifecycle tests and existing `workspace/control/agents.renderer.test.ts` contracts; then repository test-contract/type/build checks and full CI. Open a fully implemented conventional PR with `Fixes #1163`, update this plan if decisions change, review the final diff, and resolve findings. The earlier authorization to merge #1155 does not authorize merging this new feature.

## Behavioral verification

- A localhost connection refusal shows Try to restart; remote errors, aborted navigation, certificates and guest crashes do not. Cover IPv6 loopback and `.localhost`, and reject lookalike domains.
- A stopped/never-discovered server and an agent without browser MCP still receive a useful request. No dependency on a macOS-only scanner result.
- Exactly one delivery for double-clicks/mirrored UI in the same window; pending, accepted and uncertain state survive failure-overlay or guest remounts. Reload page never sends another request.
- Existing composer text, images and provider-native drafts are not edited by this feature. Provider refusal is surfaced rather than bypassed.
- Queue/user/transport acceptance are distinct from completion. Test retrySafe plus disposition together, and thrown delivery IPC as uncertain.
- Deferred wake followed by session replacement, changed worktree, navigation, successful recovery, detach or disable produces no write. After-send changes cannot cause late state resurrection or a second delivery.
- Failed navigation from page A to local page B requests/reloads B. Successful navigation clears the episode; stale guest events cannot mark a replacement pocket's request complete.
- Lane/Spotlight changes preserve state, and View agent selects the captured pocket owner rather than whichever lane is currently focused.
- The existing unregister-before-webview-destruction invariant remains tested for Reload page, feature-off and retirement.

Use existing renderer fixtures with deferred promises and explicit provider/guest event doubles. They verify our delivery and state contracts, not that an LLM will successfully diagnose every server. Do not add synthetic tests that merely snapshot the exact prompt prose.

No Electron launch/restart or `npm run dev` during local agent verification. Native webview failure rendering and actual provider task delivery require an explicit interactive smoke check in an app build already running this implementation. That check should cover an idle agent, a busy/queued agent, and a connection failure in a narrow pane. Report this boundary honestly; the isolated renderer preview does not execute a real restart request.

## Implementation decisions and local verification

- Reload page uses the host's existing native `loadURL` navigation path with the failed URL. It preserves the guest and cookies instead of bumping its generation, and avoids retrying a previously committed URL. Remount/retirement tests still verify unregister-before-destruction.
- Delivery revalidates ownership directly against the authoritative app store. Even a latest-rendered Workspace ref can lag a completed wake; the regression test changes state before the prop rerenders. A ref supplies only the current workspace operation method.
- Chromium error-document navigation (`httpResponseCode === -1`) preserves the connection failure and receipt. A real main-frame response ends that episode. Same-URL failed reloads keep the duplicate-send guard.
- The 15 focused browser, shared URL and agent-control suites pass: 179 tests. Test-contract validation, repository typecheck and the distributable-output build pass.
- The actual failure component was checked in an isolated browser preview at 240px and 340px widths, including ready, queued and uncertain feedback. Simulated submission transitioned to queued and removed the resend button. No Electron or actual agent task was launched.

## Follow-ups deliberately separate

- Automatic reconnect: use bounded fresh evidence for the original endpoint, preserve route/cookies and cancel on navigation or human takeover. Existing cached port classification is not sufficient, and a queued prompt does not provide a start-time signal. Decide monitoring lifetime and changed-port behavior before adding it.
- Manual restart while a page still loads, or application-level 500 handling: distinct trigger/product semantics from a failed connection.
- Managed servers: record exact launch command/cwd/environment reference at launch if direct deterministic stop/start is later wanted. Do not reconstruct replayable shell commands from lsof names or stale PIDs.
