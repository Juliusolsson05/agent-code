# Remote Control v2 Ground-Up Rebuild Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the phone remote as a full-native-experience Agent Code surface — Fleet home with TLDR/Goal glance, fixed shared rendering, outbound-only wire widening, OpenCode alignment — on the kept mechanics (WS transport, TranscriptStore, ledger Feed mount).

**Architecture:** Four milestones: M0 fixes shared components for narrow viewports (UserBand gutter tracking, CodeBlock stub budgets, touch/keyboard/toasts); M1 adds the workspace-projection read model + additive outbound frames (title/agentName/tab/pin, tldr/goal updates, sub-agents activation, usage snapshot); M2 replaces the v1 phone chrome with a mobile-first shell (Fleet home, peek overlay, session view, reader); M3 aligns OpenCode (blockIndex mapping at the adapter, honest interrupt, error surfacing, runtime labels). Inbound scope union and `scope.test.ts` are untouched by the entire plan.

**Tech Stack:** Electron main + React renderer (existing), Vite phone build (`src/remote-client/vite.config.ts`), zod wire schemas, Tailwind v4 tokens, vitest (unit/system/renderer projects), Refs #996.

**Spec:** `docs/superpowers/specs/2026-09-17-remote-v2-ground-up-rebuild-design.md`

**Per-PR gate:** `npx tsc --noEmit -p tsconfig.web.json` (ignore TS6305 noise) · `npm run client:build` · targeted `NODE_ENV=test npx vitest run --project <unit|system|renderer>` for touched areas · `npm run test:contract` when wire contracts change. Conventional commits with `Refs #996` footer.

---

## M0 — Shared rendering fixes

### Task 1: UserBand tracks the feed gutter (viewport breaker)

**Files:**
- Modify: `src/renderer/src/features/feed/ui/rows/primitives.tsx`
- Modify: `src/renderer/src/features/feed/ui/Feed.tsx:1155` (column div)
- Modify: `src/renderer/src/styles.css` (gutter tracker rules)
- Test: `src/renderer/src/features/feed/ui/rows/primitives.test.tsx` (create)

- [x] **Step 1: Write the failing test** — asserts UserBand no longer hardcodes `-mx-8 px-8` and the column carries the tracker class:

```tsx
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { UserBand } from './primitives'

// WHY a class-contract test instead of pixel math: the bug was a hardcoded
// 32px negative margin (-mx-8) mirroring a gutter that is container-relative
// since the mobile-feed-rewrite. The contract is "the band tracks
// --feed-gutter", asserted by class presence; the CSS contract (var steps at
// 480/768px matching px-3/px-5/px-8) is pinned by the styles.css rules and
// covered by the grep-style contract check below.
describe('UserBand', () => {
  it('derives its bleed from --feed-gutter instead of a hardcoded 32px mirror', () => {
    const { container } = render(<UserBand>hi</UserBand>)
    const band = container.firstElementChild as HTMLElement
    expect(band.className).toContain('bg-user-bg')
    expect(band.className).not.toContain('-mx-8')
    expect(band.className).not.toContain('px-8')
    expect(band.className).toMatch(/-m[xy]-\[var\(--feed-gutter/)
    expect(band.className).toMatch(/p[xy]-\[var\(--feed-gutter/)
  })
})
```

- [x] **Step 2: Run it** — `NODE_ENV=test npx vitest run --project renderer src/renderer/src/features/feed/ui/rows/primitives.test.tsx` — expect FAIL (current classes are `-mx-8 px-8`).
- [x] **Step 3: Implement.** `primitives.tsx` UserBand becomes:

```tsx
export function UserBand({ children }: { children: ReactNode }) {
  return (
    // WHY var-tracked bleed: the band must extend to the scroller edges on
    // every container width, but the column gutter is container-relative
    // (12px under 480px, 20px to 768px, 32px above). The historical
    // hardcoded -mx-8/px-8 mirror overflowed the viewport by 20px/side at
    // phone widths and made the whole feed horizontally scrollable. The var
    // is set on the feed column (.feed-column in styles.css) at the same
    // breakpoints the Tailwind px-* steps use, so ≥768px output is
    // pixel-identical to the old classes (2rem == px-8). Fallback 0px: a
    // band rendered outside a feed column loses its bleed instead of
    // overflowing — the safe direction.
    <div className="bg-user-bg py-3 -mx-[var(--feed-gutter,0px)] px-[var(--feed-gutter,0px)]">
      {children}
    </div>
  )
}
```

In `Feed.tsx:1155` add `feed-column` to the column div's className (keep every existing class). In `styles.css` (near the feed density rules):

```css
/* Feed column gutter tracker — the single source of truth UserBand's
 * edge-to-edge bleed follows. The px values mirror Feed.tsx's container
 * steps (px-3 / px-5 / px-8) exactly; if a step changes there, change it
 * here in the same diff. Raw @container (not Tailwind) because the var
 * VALUE differs per step, which utility classes cannot express. */
.feed-column { --feed-gutter: 12px; }
@container (min-width: 480px) { .feed-column { --feed-gutter: 20px; } }
@container (min-width: 768px) { .feed-column { --feed-gutter: 32px; } }
```

- [x] **Step 4: Test passes** — rerun Step 2 command; expect PASS. Also `npx tsc --noEmit -p tsconfig.web.json`.
- [x] **Step 5: Commit** — `fix(feed): track UserBand bleed to the container gutter (fixes phone viewport overflow). Refs #996`

### Task 2: CodeBlock stub gains the desktop size discipline

**Files:**
- Modify: `src/remote-client/src/stubs/CodeBlock.tsx`
- Test: `src/remote-client/src/stubs/CodeBlock.test.tsx` (create)

- [x] **Step 1:** Read the desktop's budget contract in `src/renderer/src/lib/code/CodeBlock.tsx` (`exceedsInlineTextBudget`, page size 16KB, collapsed-preview path, static classes `m-0 px-3 py-2 text-code-ink`).
- [x] **Step 2: Write failing tests:** (a) content over budget renders collapsed with a "view paged content" disclosure, not the full mount; (b) paged view renders exactly the first 16KB page; (c) under-budget renders inline with `px-3 py-2 text-code-ink` classes present; (d) `highlight={false}` stays a raw text node.
- [x] **Step 3: Implement** — port `exceedsInlineTextBudget` + page slicing + collapsed disclosure (11px `text-muted` → becomes touch-sized in Task 4) into the stub; add the desktop static classes to the `<pre>`; keep autodetect's 20k guard.
- [x] **Step 4:** `NODE_ENV=test npx vitest run --project unit src/remote-client/src/stubs/CodeBlock.test.tsx` → PASS; `npm run client:build`.
- [x] **Step 5: Commit** — `fix(remote): port CodeBlock size budget and markup contract to the phone stub. Refs #996`

### Task 3: Phone toast provider (silent failures)

**Files:**
- Create: `src/remote-client/src/ui/ToastHost.tsx` (phone-compatible `GlobalToast` context: same public API the feed rows call — `useGlobalToast().showToast({title, description, variant})` — rendered as an in-app bottom toast strip, no window.api)
- Modify: `src/remote-client/vite.config.ts` (alias `@renderer/ui/GlobalToast` → the phone host, BEFORE `@renderer` general mapping)
- Modify: `src/remote-client/src/ui/SessionView.tsx` (mount `<ToastHostProvider>` inside SessionFeedProvider)
- Test: `src/remote-client/src/ui/ToastHost.test.tsx`

- [x] **Step 1: Failing test** — a row calling `showToast` surfaces a visible toast node (`role="status"`).
- [x] **Step 2: Implement** the provider/host; wire the alias; mount in SessionView.
- [x] **Step 3:** Tests + `npm run client:build` → PASS.
- [x] **Step 4: Commit** — `fix(remote): mount a phone toast host so row-level failures are visible. Refs #996`

### Task 4: Touch-sized affordances in shared rows

**Files:**
- Modify: `src/renderer/src/features/feed/ui/rows/TruncatedOutputRow.tsx`, `PagedTextViewer.tsx` (under `features/feed/ui/`), `src/renderer/src/lib/text/OutputWell.tsx`, `src/renderer/src/lib/code/CodeBlock.tsx` (disclosure controls only)

- [x] **Step 1:** Add a shared `feedDisclosureClass` (in `primitives.tsx`): `inline-flex items-center min-h-[44px] px-1 -mx-1 text-[11px] text-muted hover:text-ink cursor-pointer select-none active:text-ink` — hit area grows, typography unchanged; desktop visuals unchanged (padding is invisible on text).
- [x] **Step 2:** Apply to every "… more output" / "previous/next" / "view paged content" / "collapse" / "copy" control.
- [x] **Step 3:** `npx tsc --noEmit -p tsconfig.web.json` + renderer project tests for feed rows.
- [x] **Step 4: Commit** — `fix(feed): give inline disclosures 44px touch hit areas. Refs #996`

### Task 5: Keyboard/viewport-aware phone scaffold

**Files:**
- Create: `src/remote-client/src/ui/Scaffold.tsx` (the app column: `100dvh` height, `visualViewport` resize listener setting `--app-visible-height`, safe-area insets all sides)
- Modify: `src/remote-client/index.html` (viewport meta: add `interactive-widget=resizes-content`)
- Modify: `src/remote-client/src/styles.css` (`.app { height: 100dvh }` + `height: var(--app-visible-height, 100dvh)` fallback chain)
- Test: `src/remote-client/src/ui/Scaffold.test.tsx`

- [x] **Step 1: Failing test** — Scaffold sets `--app-visible-height` from a mocked `visualViewport`.
- [x] **Step 2: Implement** (listener with rAF throttle, cleanup, `resize`+`scroll` events).
- [x] **Step 3:** Tests + client build → PASS.
- [x] **Step 4: Commit** — `fix(remote): keyboard- and safe-area-aware app scaffold. Refs #996`

### Task 6: `bootstrapping` + status unification in SessionView

**Files:**
- Modify: `src/remote-client/src/transcript/store.ts` (expose `isBackfilling(sessionId)`)
- Modify: `src/remote-client/src/ui/SessionView.tsx` (pass `bootstrapping`; remove the duplicated `.working` strip — in-feed `WorkIndicator` owns phase display; keep one error/status line)

- [x] **Step 1:** Wire `bootstrapping={transcript.bootstrapping}` from a new store flag set during `loadInitialHistory`/`loadOlderHistory`.
- [x] **Step 2:** Renderer test: view renders without the `.working` strip while `workingStatus` is set (in-feed indicator owns it).
- [x] **Step 3:** Tests → PASS. Commit — `fix(remote): suppress backfill jank and doubled working indicators. Refs #996`

### Task 7: Canonical icon pipeline for phone chrome

**Files:**
- Create: `src/remote-client/src/ui/icons.tsx` (bundled SVG bodies via `@iconify-json/vscode-icons` mirroring `features/editor/lib/fileIcon.tsx`'s CSP-safe pattern; mic, mic-recording, stop, send, back, chevron, dot glyph set — all 16px `aria-hidden`)
- Modify: `SessionView.tsx`, `SessionList.tsx` (replace 🎤/⏺/…/‹)

- [x] **Step 1:** Implement icons module (build-time pinned bodies, `dangerouslySetInnerHTML`, no CDN).
- [x] **Step 2:** Replace glyph usages; add renderer test asserting no emoji codepoints in chrome (scan rendered strings for `[\u{1F300}-\u{1FAFF}\u2B00-\u2BFF]`).
- [x] **Step 3:** Client build + test → PASS. Commit — `feat(remote): bundled SVG icon pipeline replaces chrome emojis. Refs #996`

---

## M1 — Wire widening (outbound, additive)

### Task 8: Workspace projection read model

**Files:**
- Create: `src/main/remote/workspaceProjection.ts` — `RemoteWorkspaceProjection` class: cached `sessionId → { title, agentName, tabId, tabTitle, pinned, tldrIdentity, cwd }`, rebuilt from `WorkspaceFileStore` reads + `AgentNameRegistry` name resolution, invalidated on the workspace-save event the store already emits; defensive parsing (missing/corrupt file → empty map, never throws).
- Test: `src/main/remote/workspaceProjection.test.ts` (fixtures: titled sessions, agent-name resolution, pinned flag, tab grouping, corrupt file)

- [x] **Step 1: Failing tests** over fixture `workspace.json` payloads.
- [x] **Step 2: Implement** (reuse `src/main/storage/workspaceProjection.ts` parsing; add the registry join; eviction of dead sessionIds on rebuild).
- [x] **Step 3:** `NODE_ENV=test npx vitest run --project unit src/main/remote/workspaceProjection.test.ts` → PASS.
- [x] **Step 4: Commit** — `feat(remote): workspace projection read model for titles, names, tabs, pins. Refs #996`

### Task 9: session-list summary growth

**Files:**
- Modify: `src/main/remote/protocol/messages.ts` (`OutboundSessionSummary` += `title?: string | null`, `agentName?: string | null`, `tabTitle?: string | null`, `pinned?: boolean`, `providerRuntime?: 'structured' | 'terminal' | null`, `subAgentCount?: number`)
- Modify: `src/main/remote/SessionFeedSource.ts` (join projection + runtime discriminator + sub-agent counts at list time)
- Modify: `src/main/remote/RemoteServer.ts` (resend session-list on projection invalidation)
- Test: extend `src/main/remote/RemoteServer.integration.test.ts`

- [x] **Step 1: Failing integration test** — connect with a fixture workspace; assert summary carries title/agentName/tabTitle/pinned/providerRuntime.
- [x] **Step 2: Implement** all optional fields; old-client tolerance is structural (unknown fields ignored).
- [x] **Step 3:** `NODE_ENV=test npx vitest run --project system src/main/remote/RemoteServer.integration.test.ts` → PASS; `npm run test:contract`.
- [x] **Step 4: Commit** — `feat(remote): project title, agent name, tab, pin, runtime onto session summaries. Refs #996`

### Task 10: TLDR/Goal frames with server-side identity join

**Files:**
- Modify: `src/main/remote/protocol/messages.ts` (outbound `tldr-updated` / `goal-updated`: `{ type, sessionId, text, updatedAt, revision } | { type, sessionId, cleared: true }`)
- Modify: `src/main/remote/RemoteServer.ts` (subscribe both `TldrStore.changed` emitters; join via projection; replay current values in the reconnect bootstrap)
- Modify: `src/remote-client/src/wire.ts` + `WebSocketSessionFeed.ts` (frame types, `onTldrUpdated`/`onGoalUpdated` listeners, initial-state getters)
- Test: extend server integration test + `WebSocketSessionFeed.integration.test.ts`

- [x] **Step 1: Failing tests** both sides (server emits on store change with correct sessionId join; client parses).
- [x] **Step 2: Implement**; unknown-frame safety for old bundles confirmed by the existing tolerant-reader tests.
- [x] **Step 3:** System + unit suites → PASS. Commit — `feat(remote): TLDR and Goal records over the wire with server-side identity join. Refs #996`

### Task 11: sub-agents channel activation

**Files:**
- Modify: `src/main/remote/SessionFeedSource.ts` (subscribe the SubAgentWatcherManager feed; extend its `FeedChannel` union; late-joiner snapshot cache in RemoteServer)
- Modify: `src/remote-client/src/WebSocketSessionFeed.ts` (register the existing empty listener set)
- Test: extend `SessionFeedSource.test.ts` + server integration

- [x] **Step 1: Failing test** — a spawned sub-agent state map reaches a connected client as `session-event { channel: 'sub-agents' }`.
- [x] **Step 2: Implement**; wire `relatedAgentTabs` in SessionView from the store (replaces the hardcoded `[]`).
- [x] **Step 3:** Tests → PASS. Commit — `feat(remote): activate the reserved sub-agents channel end to end. Refs #996`

### Task 12: usage snapshot + jsonl-error consumption

**Files:**
- Modify: `src/main/remote/RemoteServer.ts` (outbound `usage-snapshot` throttled to the usage service cache cadence; send on change + bootstrap)
- Modify: `src/remote-client/src/transcript/store.ts` (subscribe `jsonl-error` → per-session `statusError` state; expose getter)
- Modify: `src/remote-client/src/ui/SessionView.tsx` (render `statusError` banner; merge with historyError into one status surface)
- Test: extend server integration + store tests

- [x] **Step 1: Failing tests** (snapshot frame on connect; store surfaces a `provider_session_switched` payload).
- [x] **Step 2: Implement.** Commit — `feat(remote): usage snapshot frame and visible jsonl-error status. Refs #996`

---

## M2 — Shell rebuild

### Task 13: Phone chrome foundation

**Files:**
- Create: `src/remote-client/src/ui/v2/` — `nav.ts` (History-API back stack: `pushScreen`/`back`/`useScreen`), ` FleetRow.tsx`, `FleetHome.tsx`, `SessionScreen.tsx`, `PeekOverlay.tsx`, `ReaderScreen.tsx`, `StatusSurface.tsx`, `SheetHost.tsx`
- Modify: `src/remote-client/src/App.tsx` (re-route Pairing → FleetHome → SessionScreen → Reader through the nav), `styles.css` (new shell sections; delete dead v1 selectors)

- [x] **Step 1: nav + Scaffold integration** with tests (back stack behavior, deep-link-safe).
- [x] **Step 2: FleetHome** — project-grouped sections (tabTitle, pinned first), `FleetRow` (agent name/title, provider badge glyph + shortLabel via provider identity map, working pulse animation reusing `cc-pulse`, TLDR one-line clamp from the Task 10 store, recency). Long-press handler (pointerdown + 350ms timer, movement-cancel) → PeekOverlay.
- [x] **Step 3: PeekOverlay** — the TldrOverlay contract on phone: opaque `bg-canvas` overlay, centered `whitespace-pre-wrap` text, `TldrFreshness`-equivalent footer (`Last active <relative>` / `Note written <relative>` | `Goal set <relative>`), TLDR↔Goal toggle chip, release-to-dismiss + latch on chip.
- [x] **Step 4: SessionScreen** — header (back icon, provider badge, agent name/title, status-lit strip, peek button), real Feed, `SheetHost` bottom sheet for modal condition views (scrollable, `rounded-float`, scrim, 44px action rows) with the inline band kept for inline-shaped conditions, composer action row using Task 7 icons, `StatusSurface` (historyError + statusError + delivery errors, one component).
- [x] **Step 5: ReaderScreen** — reuse `readerMessagesFromFeedItems` + `readerMessages`/`readerSelection` pure modules over the phone's existing ledger plan; Older/Newer buttons + swipe (pointer events), page indicator.
- [x] **Step 6: Pairing restyle** to contract (no behavior change).
- [x] **Step 7:** Full phone suite + client build; manual smoke via `npm run client:dev`.
- [x] **Step 8: Commit(s)** — `feat(remote): v2 shell — fleet home, peek overlay, session screen, reader` (+ follow-ups split as needed). `Refs #996`

Renderer tests per screen: FleetRow renders projection fields; PeekOverlay shows footers with both records; SheetHost clamps height and scrolls; ReaderScreen pages through a fixture projection. No emoji scan passes (Task 7 test extended to v2 chrome).

---

## M3 — OpenCode alignment

### Task 13: blockId→blockIndex mapping at the adapter boundary

**Files:**
- Modify: `src/providers/opencode/runtime/opencodeSession.ts` (map semantic events before emit: stable per-block index from an insertion-ordered `blockId` map, reset per turn; field renames `inputDelta`→`partialJson`, `fullInput`→`inputJsonSoFar`, `input` object→`inputJson` string)
- Test: `src/providers/opencode/runtime/opencodeSemanticMapping.test.ts` (fixtures from recorded opencode SSE shapes)

- [x] **Step 1: Failing fold test** — a fixture turn with tool blocks folds to live tool rows via `foldSemanticEvent`.
- [x] **Step 2: Implement mapping.** **Step 3:** unit + renderer suites. **Step 4: Commit** — `fix(opencode): map block events onto the fold's index/input vocabulary so live blocks render. Refs #996`

### Task 14: Honest interrupt + runtime honesty

**Files:**
- Modify: `src/providers/opencode/runtime/opencodeSession.ts` (interrupt → `OpencodeHeadless.abort()`; `write()` returns honest `false`)
- Modify: `src/main/sessionManager.ts` (interrupt routing per provider capability — only where needed)
- Modify: `src/remote-client/src/ui/SessionScreen.tsx` (Stop disabled with visible reason when the runtime can't interrupt; terminal-runtime label)

- [x] **Step 1:** unit test: interrupt on structured opencode calls abort and surfaces failure honestly.
- [x] **Step 2:** Implement; label cosmetics (`shortLabel`/glyph). **Step 3:** suites. **Step 4: Commit** — `fix(opencode): honest abort-backed interrupt and runtime labeling. Refs #996`

### Task 15: Pre-transcript status surface + upstream watch

**Files:**
- Modify: `SessionScreen.tsx`/`StatusSurface.tsx` (no-screen providers: input-readiness + diagnostics instead of impossible screenText; failed backfill never blank)
- Modify: `support/upstream-versions.json` (opencode entry pinned to the package's accepted 1.18.30)

- [x] **Step 1:** renderer test: opencode session with failed backfill renders the status surface, not blank.
- [x] **Step 2:** Implement. **Step 3:** suites + `npm run upstream:check`. **Step 4: Commit** — `fix(remote): status surface replaces the impossible screenText fallback. Refs #996`

---

## Final gate

- [ ] `npm run typecheck`
- [ ] `npm run client:build`
- [ ] `NODE_ENV=test npx vitest run` (full)
- [ ] `npm run test:contract`
- [ ] `git diff main -- src/main/remote/protocol/scope.ts src/main/remote/protocol/scope.test.ts` — byte-identical (the security proof)
- [ ] Open PR `feat(remote): ground-up remote control v2 rebuild` → base `main`, `Refs #996`, full description per conventions
