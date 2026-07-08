# Remote Mobile Client — Feed Parity Rewrite + Voice Dictation

**Status:** approved design, ready for implementation planning
**Date:** 2026-07-08
**Branch:** `feat/remote-mobile-feed-rewrite`
**Supersedes/extends:** `docs/superpowers/specs/2026-07-06-remote-mobile-companion-design.md`, `docs/superpowers/specs/2026-07-06-remote-semantic-rendering-design.md`

---

## 1. Problem

The remote mobile client (`src/remote-client/`, a Vite React web app served by the desktop's `RemoteServer` over HTTP+WS) renders the transcript with the **real desktop `<Feed>`** — but it looks bad on a phone and the chrome around the feed is a hand-rolled downgrade of the desktop UI:

- **The feed is not responsive.** `SessionView` mounts the desktop `<Feed>`, whose container is hardcoded for an 880px desktop column (`Feed.tsx:997` → `max-w-[880px] mx-auto px-8 pt-6 pb-8`). On a ~375px phone that is 64px of wasted side padding, no breakpoints, side-scrolling code blocks, and desktop-sized type. There is **no `@media`/container-query layer anywhere** in `src/remote-client/`.
- **The chrome is bespoke, not the real thing.** `SessionView.tsx` hand-rolls (a) a plain-`<textarea>` composer (`:263-278`), (b) a label+button approval "tap-bar" (`:241-259`), and (c) a `sessionId.slice(0,8)` title. These are lossy re-implementations of desktop components that mostly already work on the phone.
- **No voice input.** The desktop composer has dictation; the phone has none. The desktop dictation path is partly macOS-native (an `xcrun swiftc` Fn-key helper), so it cannot be reused wholesale.

The user's directive: the mobile client must be a **1:1 match of the desktop feed with no rendering shortcuts, reusing desktop components as much as possible**, the **entire chrome rebuilt to match the real desktop rendering**, and **voice dictation added to the composer**.

## 2. The insight that shapes the whole design

This is **not a renderer rewrite**. The feed rendering is already shared, transport-agnostic desktop code driven by an injected `SessionFeed` and CSS theme tokens (established by the 2026-07-06 semantic-rendering work). The reasons the phone looks bad are:

1. the shared `<Feed>` container was never made width-aware, and
2. the composer / approval bar / header are hand-rolled inline in `SessionView` instead of mounting the actual desktop components.

Therefore "match the real version" = **make the shared container responsive** + **replace the hand-rolled chrome with the real desktop components**, which the scouts confirmed mostly already have everything they need on the phone. The only desktop composer affordances that genuinely cannot cross the current wire (slash-command picker, image paste) are **explicitly out of scope** (see §9).

## 3. Goals / Non-goals

### Goals
- The transcript on the phone renders **pixel-faithful to desktop, properly padded and legible** at phone widths, using the same `<Feed>` component and ledger pipeline — no divergence, no shortcuts.
- Approvals/permissions/trust/AskUserQuestion render via the **real desktop condition views**, not a hand-rolled tap-bar.
- The composer is the **real desktop `ComposerInput` shell**, visually identical (chevron, borders, auto-grow, placeholder), driven by a thin mobile controller.
- The title strip is the **real desktop `PaneHeader`** (label + shortened cwd).
- **Voice dictation** works in the mobile composer, reusing the desktop's cloud transcription engine with the API key staying server-side.
- Narrow **desktop** tiled panes benefit from the same responsive work (a free correctness win, since they share `Feed.tsx:997`).

### Non-goals (this pass)
- Slash-command picker on mobile (needs raw-byte wire widening — deferred).
- Image paste / attachments on mobile (needs an upload path — deferred).
- Related-agent chips in the header (no sub-agent data over v1 wire).
- Terminal/PTY panes on the phone (the `screenText` `<pre>` fallback is retained for TUI-only states, unchanged).
- Any change to the desktop dictation Fn-hotkey/native path.
- Widening the inbound WS command scope beyond the new dictation route.

## 4. Architecture / enabling facts

- **The `@renderer` alias reuse contract** (`src/remote-client/vite.config.ts:38-70`): the phone build resolves `@renderer`/`@providers`/`@shared` to the real desktop source, substituting exactly 5 Electron-coupled leaf modules with stubs (`CodeBlock`, `app-state/hooks`, `performance/client`, `SafeMarkdownLink`, `SafeInlineCode`). Any desktop component we mount inherits correct Tailwind styling and live `--theme-*` tokens for free (tokens are pushed over the wire via `theme-settings`/`hello`). Fidelity is a data-wiring problem, not a CSS problem.
- **The `SessionFeed` seam** (`src/shared/sessionFeed/SessionFeed.ts`): 9 listeners + 3 commands. The phone's `WebSocketSessionFeed` implements all 12, plus structured extras (`replyWithPtyAction`, `deliverPrompt`). This is the boundary the desktop composer and condition outlet already talk through.
- **The v1 wire protocol is deliberately narrow** (`src/main/remote/protocol/messages.ts`): inbound is a zod union with no raw-byte channel; `sendInput` on the phone accepts only `\r` (submit), `\x1b` (interrupt), and bracketed-paste. This is the single constraint that (a) makes the condition outlet reuse trivial via the *structured* `replyWithPtyAction`, and (b) forces slash-command/image affordances out of scope.

## 5. Part A — Responsive shared `<Feed>` (container queries)

**Mechanism: CSS container queries**, chosen over viewport `@media` (keys off screen, not container — useless for narrow desktop panes) and over a `layout`/`density` prop (threads a new prop through `Feed`, invites the two-path drift the zero-drift design fought). Container queries keep **one shared component** and improve desktop narrow panes as a bonus.

### A1. Make the feed a query container
The feed's scroll host (the element wrapping `Feed.tsx:997`'s inner container — verify exact node in `Feed.tsx`) gets `container-type: inline-size` (Tailwind v4 `@container` / `container-type` utility). This makes the inner container size against the **feed's own width**, which is:
- the full phone viewport on mobile, and
- the tiled pane width on desktop (which can be as narrow as the phone today).

### A2. Rewrite the container padding/width to be width-driven
`Feed.tsx:997`'s `max-w-[880px] mx-auto px-8 pt-6 pb-8` becomes container-query responsive, approximately:
- narrow (`@container` below ~480px): `px-3 pt-3 pb-6`, no `max-w` cap (full width), tighter `gap`.
- mid (~480–768px): `px-5`, `max-w` begins to apply.
- wide (≥ ~768px): the current `max-w-[880px] mx-auto px-8` desktop behavior, unchanged.

Exact breakpoints tuned during implementation against a real device; the invariant is **desktop wide-pane output is byte-identical to today** (regression guard) while narrow widths get sane padding.

### A3. Interior offenders fixed under the same breakpoints
- **Code blocks** — the phone `CodeBlock` stub (`src/remote-client/src/stubs/CodeBlock.tsx:64`) uses `whitespace-pre overflow-auto max-h-[360px]`, forcing horizontal side-scroll. At narrow container widths, allow soft-wrap (or a constrained horizontal scroll region that doesn't blow out the page) and relax the fixed `max-h`. Must not regress desktop rendering.
- **Type scale** — the shell base is 13px; the feed interior uses desktop sizes. Introduce a container-query type step at narrow widths where legibility needs it, without touching desktop sizes.
- **`MarkerRow`** fixed marker column (`❯`/`⏺`/`⎿`) is fine as-is; verify the hanging indent doesn't eat too much width at narrow sizes (tune the marker column width via container query only if needed).

**Regression contract:** because `Feed.tsx` is shared, every change here is gated on "desktop wide output unchanged." The container-query breakpoints are additive — the desktop path is the top breakpoint and must equal current classes.

## 6. Part B — Chrome rebuilt from real desktop components

`SessionView.tsx` is the rebuild target. Today it mounts the real `<Feed>` (keep) and hand-rolls the rest (replace). The `App` / `SessionList` / `PairScreen` phone shell stays native (no desktop analog) but is polished to the same token system.

### B1. Approval / condition bar — **mount the real desktop rendering** (highest value, no wire changes)
Replace the hand-rolled tap-bar (`SessionView.tsx:241-259`) with the generic **`src/shared/conditions-core/ConditionOutlet`** (NOT the `ProviderConditionOutlet` wrapper — its `makeDispatchFromOnSend` collapses the structured action to raw bytes and discards the `id`/`label` the phone's structured pty path needs).

- **Data source:** `transcript.conditions: ProviderConditionSnapshot | null` — already delivered to the phone via `onSessionConditions` and already read for the current tap-bar.
- **Views:** `getRendererProviderCapabilities(snapshot.provider).conditionViews` — the real Claude/Codex permission/trust/approval/AskUserQuestion views, already resolvable on the phone.
- **Dispatch (the seam):**
  ```
  dispatch = (action) => action.kind === 'pty'
    ? feed.replyWithPtyAction(sessionId, action)   // structured, keeps id/label/data
    : feed.resolveCondition(sessionId, action)     // custom
  ```
  This is exactly what `SessionView.runAction` (`:170-185`) already does imperatively — we move it into a `dispatch` and let the real registry render.
- **Result:** approvals render identically to desktop. No `SessionFeed` additions, no protocol changes. Lowest-risk, biggest fidelity jump — implement first.

### B2. Composer — **mount the real `ComposerInput` shell** + thin mobile controller
Mount `src/renderer/src/workspace/tile-tree/TileLeaf/ComposerInput.tsx` (the presentational shell: no `window.api`, no store, 22 injected props) for exact visual fidelity. Drive it with a **phone-native controller** rather than the desktop `useComposerKeybinds` brain (which is welded to `workspaceStore`'s 13 methods, `window.api` paste IPC, and `useAppStore.openUsageModal` absent from the phone stub).

- **Draft state:** phone-local `useState` (or a tiny "workspace-lite" holding `draftInput`), replacing `runtime.draftInput`.
- **Key handling (phone `onKeyDown`):** Enter → `feed.deliverPrompt(sessionId, text)` then clear draft; Shift+Enter → newline; Esc → `feed.sendInput(sessionId, '\x1b')` (interrupt). These are the only shapes the wire allows.
- **Reused hooks:** `useComposerAutoGrow` (pure DOM — verbatim) and `usePromptHistory` (derives from `transcript.entries`, which the phone has — verbatim).
- **Disabled props:** `pickerState={null}` (no slash), `draftImages={[]}` + `caps.supportsImageAttachments` path unused (no images), `promptSuggestion={null}`. `dictation` prop is **wired to the real mobile dictation** (Part C) so the shell's built-in mic affordance lights up — this is how dictation matches desktop visually.
- **Result:** the composer is the real desktop shell, pixel-identical, minus the two deferred affordances.

### B3. Title strip — **mount the real `PaneHeader`** (title only)
Mount `src/renderer/src/workspace/tile-tree/PaneHeader.tsx` (pure, props-driven) for the title/cwd strip, replacing `sessionId.slice(0,8)` (`SessionView.tsx:195`).
- Pass real `paneLabel` + `projectDir` (shortened via `shortenCwd`), `isSessionLive` from `transcript.workingStatus`.
- `statusMode={false}` (a multi-pane-grid affordance, meaningless single-session).
- `relatedAgentTabs={[]}` — **chips deferred** (they need a `runtimes` map + sub-agent data the v1 server does not emit).

### B4. Native shell — **keep + polish**
`App.tsx` (token/nav state machine + `WebSocketSessionFeed`/`TranscriptStore` lifetime), `SessionList.tsx` (session picker — no desktop analog; desktop uses tabs/grid), `PairScreen.tsx` (pairing) stay native. Polish only: align to the desktop `--theme-*` token system, remove the inline-style leaks (e.g. `PairScreen.tsx:52-56` `borderRadius:8` violates the "no radius" contract), and prune `styles.css` selectors that become dead when the composer/approval regions move to Tailwind (`.composer`, `.conditions`). Keep the load-bearing shell selectors (`.app`, `.topbar`, `.feed-host`, `.screen`, `.session-row`, `.pair`).

### B5. `screenText` TUI fallback — **preserve unchanged**
`SessionView.tsx:203-214` renders raw `screenText` in `<pre className="terminal">` when the semantic transcript is empty (trust dialogs, login prompts, crashes). This is the only surface for conditions that never reach jsonl/semantic — keep it verbatim.

## 7. Part C — Voice dictation

Reuse the desktop's cloud transcription engine; add exactly one server route. **The Deepgram API key never leaves the desktop.**

### C1. Server: new authenticated `POST /dictate` on `RemoteServer`
Add alongside `POST /pair` / `GET /healthz` (`RemoteServer.ts:228-235`):
- **Auth:** gate behind the existing device-token check (same `verifyToken` used for `/ws` upgrade and per-message). Reject `401` on missing/invalid/revoked token. Reuse the exact enforcement path so a revoked device loses dictation too.
- **Body:** the WebM/Opus audio bytes (single one-shot blob; batch is already the desktop's authoritative path).
- **Handler:** call the existing `transcribeBatch({ provider: 'deepgram', apiKey: readDeepgramApiKey(), audio })` (`src/main/dictation/controller.ts:51`) → `wrapWithSttTag` → return `{ text }`. Reuses `nova-3`, the "no speech" handling, and the env-only key (`process.env.DEEPGRAM_API_KEY`).
- **Absent key / non-darwin:** if `DEEPGRAM_API_KEY` is unset, return a structured "dictation unavailable" so the phone hides/disables the mic. (No key = feature off, clean.)

### C2. Client: capture + insert
- **Capture:** reuse `packages/agent-voice-dictation/src/recorder/browserRecorder.ts` (pure browser `getUserMedia` + `MediaRecorder`) directly in the phone bundle. Do **not** port the desktop `useComposerDictation` (its mic-forcing + Fn-hotkey + 20+ IPC calls are desktop-specific).
- **UX:** a **tap-to-toggle** mic button (no push-to-hold — there is no Fn key on a phone). Tap → start recording (mic permission prompt on first use); tap again → stop → POST blob → append returned text to the composer draft. Show a recording indicator + a busy state during transcription. The button is the real `ComposerInput` dictation slot (B2), so it matches desktop.
- **Insertion target:** append transcript to the phone composer draft state (same semantics as the desktop `commitTranscript`).

### C3. Settings
Dictation availability on the phone is driven by **server key presence**, not the desktop `dictationEnabled` setting (which governs the desktop Fn flow). Optionally surface `dictationEnabled` over the existing `theme-settings`-style push later; v1 keys off `/dictate` returning available. English-only, `nova-3`, no model/lang settings (matches desktop product decisions).

## 8. Data flow (end to end)

**Transcript (unchanged):** desktop `SessionFeedSource` taps `SessionManager` → WS `session-event` frames → phone `WebSocketSessionFeed` → `TranscriptStore` (desktop reducers) → `useLedgerFeedItems` → real `<Feed>` (now responsive).

**Prompt:** phone `ComposerInput` (real shell) → controller `deliverPrompt` → WS `send-prompt` → desktop provider prompt delivery.

**Approval:** desktop condition snapshot → WS `conditions` → phone `transcript.conditions` → real `ConditionOutlet` + `conditionViews` → `dispatch` → `replyWithPtyAction`/`resolveCondition` → WS `permission-reply` → desktop resolver.

**Dictation:** phone mic → `MediaRecorder` blob → `POST /dictate` (token-gated) → desktop `transcribeBatch` (Deepgram, server key) → `{text}` → append to draft.

## 9. Out of scope (explicit, with the reason)
- **Slash-command picker** — desktop forwards per-key escapes (`\x1b[A`, `\t`) through `sendInput`; the v1 wire refuses raw bytes. Would require a new inbound message type + scope test. Deferred.
- **Image paste / attachments** — needs an upload path + `caps.supportsImageAttachments` wiring + draft-image store. Deferred.
- **Related-agent chips** — need a `runtimes` map and the `sub-agents` channel the v1 server never emits (`WebSocketSessionFeed.ts:96-99`). Deferred.
- **Terminal/PTY panes** — no raw-PTY tap in `SessionFeedSource`; the `screenText` fallback stays.
- **Streaming dictation preview** — desktop's hybrid live-interim path is server-side Node; batch-only on the phone for v1 (batch is already the desktop's source of truth).

## 10. Security
- `/dictate` reuses the existing three-layer auth (possession at request, token verify, revocation check). Audio is transient (transcribe-and-discard; do not persist to the debug roots). No key on the client.
- No new inbound WS scope; the zod union is unchanged, so the attacker capability surface is unchanged except the token-gated `/dictate` route (which can only spend Deepgram quota, not control sessions).
- The reused desktop components are presentational; they introduce no new IPC or privilege on the phone.

## 11. Risks / accepted costs
- **Container-query regression risk on desktop** — mitigated by making the wide breakpoint equal current classes and eyeballing a tiled desktop pane before/after.
- **`ComposerInput` prop drift** — the desktop shell's 22-prop signature may change under us; the mobile controller must track it. Accepted: it's the price of true fidelity, and a prop change that breaks the phone build is a fast, visible failure.
- **Deepgram quota / latency on mobile networks** — batch upload of a longer clip over cellular can be slow; show the busy state and cap clip length if needed.
- **iOS Safari `MediaRecorder`/mimetype quirks** — `browserRecorder.ts` already handles WebM/Opus; verify the produced blob is accepted by Deepgram batch from iOS (may need a mimetype fallback).
- **Bundle size** — mounting more real desktop components grows the phone bundle (already ~350–450KB gzip per the semantic-rendering doc). Accepted; it's the same tree the desktop ships.

## 12. Blast radius (files)
**Phone client (`src/remote-client/src/`):** `ui/SessionView.tsx` (major rebuild — swap composer + approval bar + header, keep Feed + screenText fallback), `ui/App.tsx`/`SessionList.tsx`/`PairScreen.tsx` (polish), `styles.css` (prune dead selectors, fix radius leak), new `dictation/` module (recorder wiring + `/dictate` client), possibly a small `composer/` controller module, `stubs/CodeBlock.tsx` (responsive).
**Shared feed (`src/renderer/src/features/feed/ui/Feed.tsx`):** container-query responsive container (shared — desktop-regression-gated).
**Server (`src/main/remote/`):** `RemoteServer.ts` (new `POST /dictate` route), reuse `src/main/dictation/controller.ts` transcriber.
**No changes to:** the wire protocol union (`protocol/messages.ts`), `SessionFeedSource`, `WebSocketSessionFeed` command set (uses existing methods), the desktop dictation native path.

## 13. Verification (manual; no new committed test files per repo convention)
- Desktop wide feed pixel-unchanged (before/after a normal pane).
- Narrow desktop tile + phone: correct padding, no horizontal page scroll, code blocks contained, legible type.
- Approvals: trigger a Claude permission + AskUserQuestion + a Codex approval on the phone; confirm they render via the real views and resolve.
- Composer: send prompt (Enter), newline (Shift+Enter), interrupt (Esc); prompt history cycles.
- Dictation: record on a real phone, confirm transcript appends, key never sent to client (inspect network), revoked device gets `401` on `/dictate`.
- Reconnect: token survives, conditions replay, feed re-renders responsively.
