# Remote Control v2 — ground-up shell rebuild

**Date:** 2026-09-17
**Status:** Approved design (user-approved in session; tracking issue to follow)
**Scope:** `src/remote-client/`, `src/main/remote/`, shared feed components, OpenCode provider alignment

---

## 1. Problem

The phone remote is a v1 companion wearing the desktop's clothes. The transcript
Feed is the real desktop pipeline, but everything around it was hand-rolled for a
single-session LAN demo, and the shared components were never audited for a
375px viewport. The result, verified against source:

- **`UserBand` breaks the viewport.** `primitives.tsx:20` renders
  `bg-user-bg -mx-8 px-8 py-3`, mirroring the *historical* desktop 32px gutter
  with a negative margin. The feed column is container-query responsive since
  the 2026-07-08 rewrite (`Feed.tsx:1155`: `px-3` below 480px), so every user
  turn now starts 20px outside the scroller on each side and the whole feed
  scrolls horizontally. This is the single largest "no real padding" defect.
- **The phone `CodeBlock` stub lost the desktop's size discipline.** Desktop
  `CodeBlock.tsx:78-125,429-497` pages content at 16KB and collapses oversized
  output; the stub (`stubs/CodeBlock.tsx:44-61`) highlights and mounts the whole
  string. Expanding a large Read can freeze the phone. The stub's class list
  also dropped `px-3 py-2 text-code-ink`, so code slabs render unpadded in the
  wrong ink.
- **Condition surfaces are desktop Radix modals.** `DialogContent`
  (`components/ui/dialog.tsx:47-67`) has no max-height or scroll and is portaled
  to `document.body`; a long permission command clips off both ends of a phone
  screen. Desktop-only copy ("Press enter…") survives on touch.
- **No keyboard/viewport handling.** No `visualViewport` listener, no `dvh`, no
  `interactive-widget` meta: the iOS keyboard covers the composer and condition
  band while typing.
- **Touch ergonomics are hover-era.** 11px text-link affordances, 32px buttons,
  no pressed states; the in-feed pagination controls are the worst.
- **Silent failures.** No `GlobalToastProvider` is mounted, so AskUserQuestion
  answer failures (`AskUserQuestionRow.tsx:346-357`) no-op invisibly.
- **Emojis in chrome** (`🎤`, `⏺`, `…` mic states) instead of the canonical
  bundled-SVG icon pipeline; doubled working indicators (in-feed
  `WorkIndicator` + a shell `.working` strip); 12px vs 14px gutter mismatch
  between feed and shell.
- **`bootstrapping` is never passed**, so initial-history backfill replays with
  per-append auto-scroll and the full IntersectionObserver cascade — jank the
  prop exists to suppress.
- **The feature surface is empty.** The wire carries prompt/submit/interrupt/
  permission-reply/get-history and nothing else: no title, no agent names, no
  TLDR/Goal, no sub-agents (channel reserved but dead), no project grouping, no
  usage, no reader mode. The owner wants a *full native experience* — monitoring
  and driving as equal peers.
- **OpenCode is structurally degraded**, on desktop and phone alike:
  opencode-headless publishes block events keyed by `blockId`
  (`channels/types.ts:83-147`) while the shared fold requires numeric
  `blockIndex` (`foldEvent.ts:465-466`…), so live tool blocks and thinking never
  fold; structured-runtime interrupt is a silent no-op (`opencodeSession.ts:469`
  permanent no-op write, yet `manager.write` returns true); `jsonl-error` rides
  the wire but no phone consumer exists; a failed history backfill renders a
  *completely blank screen* because the screenText fallback can never exist for
  OpenCode; the phone cannot tell the two OpenCode runtimes apart.

## 2. Goals

1. **One rendering pipeline.** The phone keeps mounting the real ledger→Feed
   stack (`useLedgerFeedItems` seam). No second phone implementation of
   conversation rendering.
2. **Ground-up shell rebuild.** Replace the v1 chrome (`App`, `SessionList`,
   `PairScreen`, `SessionView` chrome, shell `styles.css` chrome sections) with
   a mobile-first Agent Code surface: Fleet home with glanceable TLDR/Goal,
   project-grouped agents, session view, reader mode, honest status.
3. **Full aesthetic contract.** Theme tokens, four radius tiers, mono-only type,
   ❯/⎿ marker language, square structure, canonical icons (bundled
   vscode-icons SVG pipeline), zero emojis in chrome.
4. **Fix the shared components for narrow viewports** (UserBand, CodeBlock stub,
   condition surfaces, touch targets, keyboard handling, toasts, bootstrapping).
5. **Wire widening, outbound-only:** workspace projection keystone (title, agent
   name, tab, pin, tldr identity), TLDR/Goal channels, sub-agents activation,
   usage snapshot, OpenCode runtime awareness.
6. **OpenCode parity work:** block-vocabulary alignment so live blocks fold,
   honest interrupt, error surfacing, pre-transcript status surface.
7. **Old phones keep working.** Every wire change is additive with tolerant
   readers; unknown channels are dropped safely by old bundles.

## 3. Non-goals (this rebuild)

- **Inbound capability widening.** Provider switching, fleet close/pin,
  rewind/duplicate, spawn, terminal/tmux panes, file/editor access, settings
  write-back remain unrepresentable. Each is a future deliberate
  scope-widening PR with `scope.test.ts` updated in the same diff
  (`protocol/messages.ts:4-19` policy).
- Slash-command picker over the wire (plain-text `/cmd` passthrough already
  works through `deliverPrompt`).
- Ghost/optimistic planes on the phone (stays a committed+semantic renderer).
- Any change to auth/pairing mechanics (they are sound and reviewed).

## 4. Design

### 4.1 Principles

- **One pipeline:** phone chrome is new code; conversation rendering is shared
  code. Anything the phone renders that the desktop also renders must come from
  the same component or the same pure projection.
- **The contract travels:** the aesthetic contract in `@renderer/styles.css`
  (radius=detachment, mono, tokens, markers, no bubbles/cards) applies verbatim
  to new chrome. The phone shell has nothing detached → square at every Corners
  tier; the one sanctioned circle class remains dots.
- **Mobile-first chrome, desktop-grade discipline:** new phone components are
  written for touch (≥44px targets, pressed states, safe areas, keyboard-aware
  anchoring) but composed from shared primitives (`button`, `MarkerRow`, tokens)
  wherever they fit.
- **Evidence before rendering:** every new rendered shape gets a fixture before
  the component claims it (same discipline as `docs/rendering/`).

### 4.2 Information architecture

Four surfaces, a phone-native back stack (History API), safe-area and
`visualViewport` aware scaffolding:

1. **Pairing** — same mechanics (QR hash auto-redeem, manual code, revoke).
   Restyled to contract. No behavior change.
2. **Fleet home** (new heart; monitoring as an equal peer):
   - Header: connection state, desktop host name, usage indicator (when a
     snapshot exists).
   - Agents grouped by **project tab** (from the workspace projection), pinned
     sessions first within their group, exited agents in a sunk section.
   - Row: agent name (spoken registry name) or title, provider badge (glyph +
     shortLabel — never a raw `opencode` string), working pulse + status text,
     TLDR one-line clamp when TLDR is enabled, relative recency.
   - **Long-press = peek:** the desktop TLDR/Goal overlay contract (`TldrOverlay`
     + `TldrFreshness`) as a phone overlay — opaque canvas, centered text,
     footer `Last active` / `Note written` (TLDR) or `Goal set` (Goal), a chip
     toggling TLDR↔Goal, release/latch semantics adapted to touch
     (press-and-hold to peek, release to dismiss, toggle chip to latch).
3. **Session view**:
   - Header: back, provider badge, agent name/title (projection), status-lit
     strip, peek button (same TLDR/Goal overlay).
   - The real `Feed` with all §4.3 fixes, reader-mode entry point.
   - Conditions: inline band for inline-shaped conditions; genuinely modal
     provider views render in a phone **bottom sheet** (scrollable,
     `rounded-float`, scrim, action rows ≥44px) — never an unclipped centered
     desktop dialog. Desktop-only copy suppressed on phone hosts.
   - Composer: real `ComposerInput` + phone action row (mic/stop/send) with
     canonical icons, 16px iOS zoom floor, keyboard-aware anchoring.
   - Working state integrated in-feed (shell `.working` strip removed);
     `historyError` and delivery errors unified into one status surface.
4. **Reader mode**: `readerMessagesFromFeedItems` projection (pure, already
   shared) with a phone pager — Older/Newer controls, swipe navigation,
   per-message pagination identical to desktop semantics.

### 4.3 Shared-code rendering fixes (M0)

| Fix | File | Change |
| --- | --- | --- |
| UserBand viewport break | `features/feed/ui/rows/primitives.tsx:20` | Replace the hardcoded `-mx-8 px-8` mirror with container-relative insets: `mx-[calc(var(--feed-gutter)*-1)] px-[var(--feed-gutter)]` where `--feed-gutter` is set by the feed column at each container step (12/20/32px), so the band always tracks the real gutter. Desktop ≥768px renders identically (32px). |
| CodeBlock stub parity | `src/remote-client/src/stubs/CodeBlock.tsx` | Port the desktop's `exceedsInlineTextBudget` + 16KB paging + collapse contract; restore `px-3 py-2 text-code-ink`; keep static hljs. |
| Condition surfaces on phone | phone shell | Bottom-sheet host for modal condition views; inline band stays inline. `max-height` + scroll mandatory. |
| Touch targets | shared rows + phone chrome | ≥44px hit areas via padding/`min-h`, pressed states via `:active`, keep visual density (hit area ≠ font size). |
| Keyboard/viewport | phone scaffold | `visualViewport` listener resizing the app column; `100dvh`; `interactive-widget=resizes-content` in the viewport meta. |
| Toasts | phone shell | Mount a phone `GlobalToastProvider` equivalent over the WS feed. |
| Bootstrapping | `SessionView` → Feed | Pass `bootstrapping` during initial backfill. |
| Gutters | phone shell | One 12px gutter token everywhere in shell chrome. |
| Icons | phone chrome | Bundled SVG icon pipeline (vscode-icons bodies, CSP-safe `img-src 'self'`); replace 🎤/⏺/… and text arrows. |
| AUQ input zoom | phone css | 16px floor for the in-feed AskUserQuestion custom-answer input, mirroring the composer rule. |

### 4.4 Wire widening (M1) — additive, outbound only

**Keystone: the workspace projection.** `src/main/storage/workspaceProjection.ts`
already reads `workspace.json` defensively into SessionPlacement (title,
agentNameId, tab). v2 builds a small cached read model in the remote subsystem:
`sessionId → { title, agentName, tabId, tabTitle, pinned, tldrIdentity }`,
refreshed on workspace save (the WorkspaceFileStore already broadcasts), joined
with the `AgentNameRegistry` for display names. One module, most features hang
off it.

Frame changes (all optional-field/tolerant-reader, old bundles unaffected):

- `session-list` summaries grow: `title?`, `agentName?`, `tabTitle?`,
  `pinned?`, `providerRuntime?` (`'structured' | 'terminal'` for opencode,
  absent for others), `subAgentCount?`.
- New outbound `tldr-updated` / `goal-updated` frames: server-joined by
  sessionId, payload `{ sessionId, text, updatedAt, revision }`; sent on
  `TldrStore.changed` and included in the reconnect bootstrap for the current
  list. The server owns the identity join; the phone never sees
  `tldrIdentity`.
- `sub-agents` channel activation: SessionFeedSource subscribes to the
  SubAgentWatcherManager feed (channel + phone listeners already exist); a
  last-snapshot cache joins the reconnect replay.
- Usage: outbound `usage-snapshot` (throttled to the 30–60s cache cadence),
  payload the normalized snapshot rows. Read-only.
- `jsonl-error` phone consumption (see §4.5) rides the existing channel.

Scope invariants: `scope.test.ts` and the inbound union are **untouched**. The
security posture is unchanged — a fully-authenticated phone still cannot do
anything the v1 phone could not, except know more.

### 4.5 OpenCode alignment (M3, parallelizable)

1. **Block vocabulary alignment** — map `blockId`→stable numeric `blockIndex`
   at the app provider boundary (`src/providers/opencode/runtime/` adapter),
   plus field-shape alignment (`tool_input_delta.partialJson/inputJsonSoFar`
   vs the package's `inputDelta/fullInput`; `tool_input_finalized.input`
   object vs `inputJson` string). Live tool rows, thinking, and live tool
   input begin folding on **both** surfaces. Done in the app repo, not the
   package submodule, to keep this rebuild one-PR-stream.
2. **Honest interrupt** — route `interrupt` for structured opencode to
   `OpencodeHeadless.abort()`; until wired, `manager.write` must return an
   honest failure instead of `true` for a no-op write.
3. **`jsonl-error` consumed** — phone store subscribes; `provider_session_switched`
   and channel failures render as a status banner, not silence.
4. **Pre-transcript status surface** — for providers with no `screen` channel
   (both opencode runtimes), replace the impossible screenText fallback with an
   input-readiness/diagnostic status surface; a failed backfill must never
   render a blank screen.
5. **Runtime honesty** — `providerRuntime` on summaries; terminal-runtime
   sessions labeled ("TUI on desktop — committed turns here"); Stop button
   reflects actual interruptibility.
6. **Cosmetics** — `OPENCODE_IDENTITY.shortLabel`/glyph in list/header;
   opencode entry in root `support/upstream-versions.json`.

### 4.6 Testing strategy

- Every shared-code fix gets a regression test at the narrowest layer
  (UserBand: container-query fixture asserting the band tracks `--feed-gutter`;
  stub: budget/paging unit tests mirroring the desktop's).
- Wire additions get RemoteServer integration coverage incl. the
  old-client-compat property (unknown channels dropped, unknown fields
  ignored) and reconnect replay ordering.
- New chrome components get renderer tests under the phone vitest project with
  fixtures-first shape claims (peek overlay, fleet row, bottom sheet).
- Per-PR gate: `npm run typecheck`, `npm run client:build`, targeted vitest
  projects, `npm run test:contract` where wire contracts change.

## 5. Milestones

- **M0 — stop the bleeding** (shared fixes, §4.3): shippable independently.
- **M1 — the data keystone** (projection + frames, §4.4): shippable
  independently; phone still on v1 chrome but titles/TLDR data begin arriving.
- **M2 — the shell rebuild** (§4.2): new Fleet home, session view, reader,
  pairing restyle; the love.
- **M3 — OpenCode alignment** (§4.5): parallel with M0–M2; independent of M2.

Each milestone is its own PR (M2 likely 2–3 stacked PRs) against this branch's
tracking issue.

## 6. Acceptance criteria

1. No horizontal overflow anywhere on a 375px viewport across
   claude/codex/opencode fixture corpora (per-tick replay + manual).
2. Every touch target ≥44px in new chrome; no emoji glyphs in chrome.
3. Fleet home shows per-agent: name-or-title, provider badge, working status,
   TLDR line (when enabled), project grouping; long-press peek shows
   TLDR/Goal with the freshness footer.
4. Session view: conditions render fully readable on-phone (bottom sheet /
   inline band), keyboard never covers the composer, no doubled working
   indicators, backfill without jank (`bootstrapping`).
5. OpenCode: live tool/thinking blocks fold during a structured turn; Stop
   either aborts honestly or shows its failure; session-switched notices
   visible; failed backfill shows a status surface, never blank.
6. An old (v1) phone bundle connected to the new server keeps working; a new
   bundle against an old server degrades loudly, never silently.
7. Full gate green: `typecheck`, `client:build`, vitest suites, contract
   checks; inbound scope union byte-identical to main.
