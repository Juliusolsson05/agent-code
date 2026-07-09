# Remote Mobile Feed Parity Rewrite — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the remote mobile client a properly-padded 1:1 match of the desktop feed by making the shared `<Feed>` container width-responsive and replacing the hand-rolled `SessionView` chrome with the real desktop components, then add voice dictation to the mobile composer.

**Architecture:** The phone already mounts the real desktop `<Feed>` via `@renderer` Vite aliases; this plan (A) makes the shared feed container responsive with CSS container queries, (B) swaps the hand-rolled composer/approval-bar/title in `SessionView.tsx` for the real `ComposerInput` shell, generic `ConditionOutlet`, and `PaneHeader`, and (C) adds a token-gated `POST /dictate` route that reuses the desktop Deepgram batch transcriber while the phone captures audio with `MediaRecorder`.

**Tech Stack:** TypeScript, React 18, Vite (phone build), Tailwind v4 (container queries), Electron main (`RemoteServer` HTTP/WS), `packages/agent-voice-dictation` (`browserRecorder`), Deepgram batch STT.

## Global Constraints

- **Design source of truth:** `docs/superpowers/specs/2026-07-08-remote-mobile-feed-rewrite-design.md`. Every task traces to a section there.
- **Work happens on the worktree** `feat/remote-mobile-feed-rewrite` (`.worktrees/remote-mobile-feed-rewrite`). Main checkout stays on `main`.
- **NO new committed test files, and do not wire new `test:*` scripts** (repo convention). The per-task cycle is **implement → typecheck/build gate → manual verification → commit** — NOT test-first. Temporary throwaway verification (a curl, a scratch device check) is fine but is never committed.
- **Verification gate commands** (run from the worktree root unless noted):
  - Web/renderer changes (`Feed.tsx`, anything under `src/renderer`, `src/remote-client`): `npx tsc --noEmit -p tsconfig.web.json` (ignore any `TS6305` "output not built" noise).
  - Main-process changes (`src/main/**`): `npx tsc -b tsconfig.node.json`.
  - Phone bundle: `npm run client:build` (Vite build of `src/remote-client`).
- **Desktop-regression invariant (Part A):** the shared `Feed.tsx` container's WIDE breakpoint MUST equal its current classes exactly (`max-w-[880px] mx-auto px-8 pt-6 pb-8`). Container queries are ADDITIVE for narrow widths only. Verify a normal desktop pane looks byte-identical before/after.
- **Dictation security:** the Deepgram API key (`process.env.DEEPGRAM_API_KEY`) NEVER leaves the desktop. `/dictate` is token-gated with the exact same verification the `/ws` upgrade uses. Audio is transcribe-and-discard — never written to any debug root.
- **Dictation scope:** English-only, `nova-3`, batch (one-shot blob) — matches desktop product decisions. No slash-command picker, no image paste (both deferred — need wire-protocol widening).
- **Commits:** merge-style workflow; end commit messages with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

## File Structure (created / modified)

- `src/renderer/src/features/feed/ui/Feed.tsx` — **modify** container node (`:987-997`) for container queries. *Shared with desktop — regression-gated.*
- `src/remote-client/src/stubs/CodeBlock.tsx` — **modify** for responsive wrap at narrow container widths.
- `src/remote-client/src/ui/SessionView.tsx` — **major modify**: replace approval bar (Task 2), title strip (Task 3), and composer (Task 4); keep `<Feed>` + `screenText` fallback.
- `src/remote-client/src/composer/useMobileComposer.ts` — **create** (Task 4): phone draft state + key handling + history + auto-grow wiring.
- `src/remote-client/src/dictation/mobileDictation.ts` — **create** (Task 6): `MediaRecorder` capture + `POST /dictate` + a `ComposerDictationController` implementation.
- `src/main/remote/RemoteServer.ts` — **modify** (Task 5): add `POST /dictate` route + `handleDictate`.
- `src/main/remote/RemoteController.ts` (or wherever `RemoteServer` is constructed) — **modify** (Task 5): inject a `transcribeAudio` dependency.
- `src/remote-client/src/ui/{App,SessionList,PairScreen}.tsx`, `src/remote-client/src/styles.css` — **modify** (Task 7): polish + prune dead selectors + fix radius leaks.

---

## Task 1: Responsive shared `<Feed>` container (Part A)

**Files:**
- Modify: `src/renderer/src/features/feed/ui/Feed.tsx:987-997`
- Modify: `src/remote-client/src/stubs/CodeBlock.tsx` (the `whitespace-pre overflow-auto max-h-[360px]` node, ~line 64)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: a width-responsive feed container all later phone tasks render inside. No new exported symbols.

- [ ] **Step 1: Mark the feed scroller as a query container and make the inner container width-responsive**

In `Feed.tsx`, the scroller is the `ref={scrollerRef}` div (`:987-996`, `className="h-full overflow-auto"`) and the inner content column is `:997`. Add container context to the scroller and rewrite the inner column so the desktop classes live at the widest breakpoint while narrow widths get real padding. Using Tailwind v4 container-query syntax (`@container` marks the container; `@min-[Wpx]:` / `@max-[Wpx]:` variants respond to the container's inline size):

```tsx
      <div
        ref={scrollerRef}
        className="h-full overflow-auto @container"   // <-- add @container
        onWheel={() => { onUserEngagement?.() }}
        onPointerDown={() => { onUserEngagement?.() }}
      >
        {/*
          Container-query responsive (mobile-feed-rewrite Part A). The WIDEST
          step MUST equal the historical desktop classes verbatim
          (max-w-[880px] mx-auto px-8 pt-6 pb-8) — the desktop feed and narrow
          tiled panes share this node, so wide output must not change. Narrow
          widths (phone, skinny tiles) drop the max-w cap and shrink padding.
        */}
        <div className="min-h-full flex flex-col gap-4 mx-auto
                        px-3 pt-3 pb-6
                        @min-[480px]:px-5 @min-[480px]:pt-5
                        @min-[768px]:max-w-[880px] @min-[768px]:px-8 @min-[768px]:pt-6 @min-[768px]:pb-8">
          {renderItems.map(renderFeedItem)}
          <div ref={endRef} />
        </div>
      </div>
```

Note: if Tailwind v4's `@container`/`@min-[..]` utilities are not already enabled in this project's Tailwind config, use an equivalent `[container-type:inline-size]` on the scroller and `@container (min-width: …)` rules in `src/renderer/src/styles.css` keyed to a class on the inner column. Confirm which mechanism the codebase already uses by grepping `@container` in `src/renderer/src/styles.css` before editing; follow the existing pattern.

- [ ] **Step 2: Make the phone code block wrap instead of forcing horizontal page scroll**

In `src/remote-client/src/stubs/CodeBlock.tsx`, the code node (~`:64`) uses `whitespace-pre overflow-auto max-h-[360px]`. Keep horizontal scroll *contained* to the block (it already is via `overflow-auto`), but ensure the block itself never forces the page wider than the viewport by constraining its width to the container and allowing the pre to scroll internally:

```tsx
// before: className="… whitespace-pre overflow-auto max-h-[360px] …"
// after: constrain to container width so long lines scroll INSIDE the block,
// never widening the phone page; relax the fixed max height on small screens.
className="… whitespace-pre overflow-x-auto max-w-full max-h-[360px] @container:[max-h:none] …"
```

Keep it minimal: the essential fix is `max-w-full` so the block can't push the page horizontally. Do not change desktop code-block behavior beyond adding `max-w-full` (which is a no-op inside the 880px column).

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.web.json`
Expected: PASS (ignore `TS6305`). Fix any class-name typos or Tailwind arbitrary-value syntax errors.

- [ ] **Step 4: Build the phone bundle**

Run: `npm run client:build`
Expected: Vite build succeeds, emits `out/remote-client`.

- [ ] **Step 5: Manual verification**

- Desktop: open a normal-width agent pane — the feed must look **identical** to before (880px centered, 32px gutters). This is the regression gate.
- Narrow: shrink a tiled desktop pane to ~380px (or load the phone bundle on a device / a 375px-wide browser window pointed at the dev server) — the feed now has ~12px gutters, no horizontal page scroll, code blocks contained.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/features/feed/ui/Feed.tsx src/remote-client/src/stubs/CodeBlock.tsx
git commit -m "feat(remote): container-query responsive feed container

Feed.tsx:997 was hardcoded max-w-[880px] px-8 for desktop; a phone got 64px
of wasted side padding and no breakpoints. Mark the scroller @container and
make padding/width step with container width — wide step equals the old
desktop classes verbatim (no desktop regression), narrow widths get sane
gutters. Also cap the phone CodeBlock at max-w-full so long lines scroll
inside the block instead of widening the page. Bonus: fixes cramped narrow
desktop tiles too.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Real approval/condition outlet (Part B1)

**Files:**
- Modify: `src/remote-client/src/ui/SessionView.tsx` (replace the `tapConditions` bar `:241-259` and adapt `runAction` `:170-185`)

**Interfaces:**
- Consumes: `feed.replyWithPtyAction(sessionId, action)` and `feed.resolveCondition(sessionId, action)` — already on `WebSocketSessionFeed`.
- Produces: nothing new exported; `SessionView` now renders the generic outlet.

- [ ] **Step 1: Confirm the registry accessor and snapshot type**

Read `src/providers/shared/renderer/conditions/ProviderConditionOutlet.tsx` to see exactly how it derives (a) the `registry` (the per-provider `conditionViews`) and (b) the `snapshot` it passes to the generic core. Confirm the accessor name on `getRendererProviderCapabilities(provider)` (expected: `.conditionViews`) and whether `transcript.conditions` (`ProviderConditionSnapshot`) is passed directly as the core's `ConditionSnapshot` or adapted. Mirror that derivation — but replace its `dispatch`/`makeDispatchFromOnSend` with the structured phone dispatch below.

- [ ] **Step 2: Import the generic outlet + provider registry, add a phone dispatch**

In `SessionView.tsx`, add imports and replace `runAction` with a `dispatch` that returns `Promise<void>` (the shape `ConditionOutlet` expects) and routes structured actions:

```tsx
import { ConditionOutlet } from '@shared/conditions-core/ConditionOutlet'
import type { ConditionAction as CoreConditionAction } from '@shared/conditions-core/contract'
import { getRendererProviderCapabilities } from '@providers/registry.renderer.capabilities'

// …inside SessionView, replacing runAction:
const dispatch = useCallback(
  async (action: CoreConditionAction): Promise<void> => {
    setError(null)
    try {
      const r = action.kind === 'pty'
        ? await feed.replyWithPtyAction(sessionId, action)   // structured — keeps id/label/data
        : await feed.resolveCondition(sessionId, action)     // custom
      if (!r.ok) setError(('error' in r && r.error) || ('failedAtStep' in r && r.failedAtStep) || 'Action failed — it may have expired.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed.')
    }
  },
  [feed, sessionId],
)
```

Note: `CoreConditionAction` is the conditions-core action type. If its `kind`/field names differ from the local `ConditionAction` (`:39-46`), align to the core type — that local type can be deleted once the outlet drives resolution. Confirm `replyWithPtyAction`/`resolveCondition` accept the core action shape (they take `{id,label,data}` / `{id,label,name,payload}` per `WebSocketSessionFeed.ts`).

- [ ] **Step 3: Replace the hand-rolled tap-bar JSX with the generic outlet**

Delete the `tapConditions`-driven block (`:241-259`) and the `tapConditions`/`titleFor` machinery (`:134-145`, `:284-297`), replacing with:

```tsx
{transcript.conditions && (
  <div className="conditions">
    <ConditionOutlet
      snapshot={transcript.conditions}
      registry={getRendererProviderCapabilities(provider).conditionViews}
      dispatch={dispatch}
    />
  </div>
)}
```

This renders the real Claude/Codex permission/trust/approval/AskUserQuestion views. It also satisfies the "guaranteed fallback" concern the old inline comment (`:124-133`) documented: the outlet is snapshot-driven, so even if the inline feed AUQ row is mid-stream/malformed, the outlet still shows real, server-verified action buttons. Keep the `askUserQuestionState` memo (`:113-122`) — the feed's inline `AskUserQuestionRow` still consumes it via context.

- [ ] **Step 4: Typecheck + build**

Run: `npx tsc --noEmit -p tsconfig.web.json` (ignore `TS6305`), then `npm run client:build`.
Expected: PASS + build succeeds. Resolve any type mismatch between the local and core action shapes here.

- [ ] **Step 5: Manual verification**

On a phone/narrow browser paired to a live desktop: trigger (a) a Claude permission prompt, (b) an AskUserQuestion, (c) a Codex approval. Each must render via the real desktop condition view (not a plain label+button row) and resolve when tapped (agent proceeds).

- [ ] **Step 6: Commit**

```bash
git add src/remote-client/src/ui/SessionView.tsx
git commit -m "feat(remote): render approvals via the real ConditionOutlet

Replace SessionView's hand-rolled label+button tap-bar with the generic
conditions-core ConditionOutlet + the provider conditionViews registry,
driven by a structured phone dispatch (pty -> replyWithPtyAction, custom ->
resolveCondition). Snapshot, registry, and both resolution paths already
existed on the phone, so no wire changes. Approvals now render identically
to desktop. Skips the ProviderConditionOutlet wrapper on purpose — its
makeDispatchFromOnSend collapses the action to raw bytes the wire rejects.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Real title strip via `PaneHeader` (Part B3)

**Files:**
- Modify: `src/remote-client/src/ui/SessionView.tsx` (topbar `:191-196`)
- Modify: `src/remote-client/src/ui/App.tsx` (thread the selected session's `cwd`/label into `SessionView`)

**Interfaces:**
- Consumes: the selected session summary's `cwd` (from `OutboundSessionSummary` via `feed.onSessionList`, already used by `SessionList`).
- Produces: `SessionView` gains a `cwd?: string` prop.

- [ ] **Step 1: Confirm PaneHeader's minimal prop set**

Read `src/renderer/src/workspace/tile-tree/PaneHeader.tsx`. Confirm the prop names for the title-strip-only use: the pane label, the project dir (cwd), `statusMode`, `relatedAgentTabs`, and a live flag. Note which are required.

- [ ] **Step 2: Thread `cwd` from App into SessionView**

In `App.tsx`, where `<SessionView … />` is rendered for the selected session, pass the summary's `cwd` (the same field `SessionList` renders). Add `cwd?: string` to `SessionView`'s props (`:48-60`).

- [ ] **Step 3: Replace the `sessionId.slice(0,8)` title with PaneHeader**

Keep the phone's `‹ Back` button and `conn-dot` (no desktop analog), and mount `PaneHeader` for the label/cwd portion:

```tsx
import { PaneHeader } from '@renderer/workspace/tile-tree/PaneHeader'

// in the topbar:
<div className="topbar">
  <button onClick={onBack}>‹ Back</button>
  <span className={`conn-dot ${connection}`} />
  <PaneHeader
    paneLabel={/* provider/workspace label — mirror desktop's derivation */ provider}
    projectDir={cwd ?? ''}
    statusMode={false}
    relatedAgentTabs={[]}
    isSessionLive={Boolean(transcript.workingStatus) || !transcript.exited}
    /* pass any remaining required props per Step 1; related-agent chips stay
       empty — no sub-agent data over the v1 wire */
  />
</div>
```

Match the exact prop names/required set found in Step 1. If `PaneHeader`'s required props include desktop-only handlers, pass no-ops; if it hard-requires a `runtimes` map for chips, pass `{}` and `relatedAgentTabs={[]}` so the chip row renders nothing.

- [ ] **Step 4: Typecheck + build**

Run: `npx tsc --noEmit -p tsconfig.web.json` (ignore `TS6305`), then `npm run client:build`. Expected: PASS + build.

- [ ] **Step 5: Manual verification**

Phone: the title strip now shows the real pane label + shortened cwd (like desktop), not an 8-char id. No related-agent chips appear. Back button + connection dot still work.

- [ ] **Step 6: Commit**

```bash
git add src/remote-client/src/ui/SessionView.tsx src/remote-client/src/ui/App.tsx
git commit -m "feat(remote): real PaneHeader title strip

Replace sessionId.slice(0,8) with the desktop PaneHeader (label + shortened
cwd), threading the selected session's cwd from App. statusMode=false and
related-agent chips empty (no sub-agent data over the v1 wire).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Real composer shell + mobile controller (Part B2)

**Files:**
- Create: `src/remote-client/src/composer/useMobileComposer.ts`
- Modify: `src/remote-client/src/ui/SessionView.tsx` (replace the `<textarea>` composer `:263-278`)

**Interfaces:**
- Consumes: `feed.deliverPrompt(sessionId, text)`, `feed.sendInput(sessionId, '\x1b')`, `transcript.entries` (for history), `transcript.exited`, `transcript.workingStatus`.
- Produces: `useMobileComposer(...)` returning `{ inputRef, draft, setDraft, onKeyDown, historyIndex, history, setInputText, endHistoryCycle }` and a disabled `ComposerDictationController` (`dictationDisabled`) for the shell's `dictation` prop until Task 6 replaces it.

- [ ] **Step 1: Confirm the `ComposerDictationController` interface**

Read `src/renderer/src/workspace/tile-tree/TileLeaf/useComposerDictation.ts` for the exported `ComposerDictationController` type. The `ComposerInput` shell requires it (`dictation: ComposerDictationController`, prop `:69`). Note every field (expected: `enabled: boolean`, `busy: boolean`, activity `levels`, and start/stop/toggle handlers). Task 6 implements a real one; Task 4 needs a **disabled** instance.

- [ ] **Step 2: Write the mobile composer controller**

Create `src/remote-client/src/composer/useMobileComposer.ts`. Reuse the desktop `useComposerAutoGrow` (pure DOM) and `usePromptHistory` (derives from entries). Implement phone key handling: Enter → send, Shift+Enter → newline, Esc → interrupt.

```ts
import { useCallback, useRef, useState } from 'react'
import { useComposerAutoGrow } from '@renderer/workspace/tile-tree/TileLeaf/useComposerAutoGrow'
import { usePromptHistory } from '@renderer/workspace/tile-tree/TileLeaf/usePromptHistory'
import type { Entry } from '@shared/types/transcript'
import type { ComposerDictationController } from '@renderer/workspace/tile-tree/TileLeaf/useComposerDictation'

// A ComposerDictationController that reports "off" so the real desktop
// ComposerInput shell mounts without a mic affordance. Task 6 replaces this
// with a working mobile controller. Field set MUST match the interface
// confirmed in Step 1 — fill every required field with an inert value.
export const dictationDisabled: ComposerDictationController = {
  enabled: false,
  busy: false,
  levels: [0, 0, 0, 0, 0, 0, 0],
  // add the remaining required no-op handlers per Step 1 (e.g. start/stop/
  // toggle as async no-ops). Keep it a module constant — a fresh object each
  // render would defeat the shell's memoization.
} as ComposerDictationController

export function useMobileComposer(params: {
  entries: readonly Entry[]
  disabled: boolean
  onSend: (text: string) => Promise<void>
  onInterrupt: () => void
}) {
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const [draft, setDraft] = useState('')
  useComposerAutoGrow(inputRef, draft)

  const { historyIndex, history, setInputText, endHistoryCycle } = usePromptHistory({
    entries: params.entries,
    input: draft,
    setInput: setDraft,
  }) // match usePromptHistory's real signature (confirm in its file)

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        const text = draft.trim()
        if (text && !params.disabled) void params.onSend(text).then(() => setDraft(''))
        return
      }
      if (e.key === 'Escape') { e.preventDefault(); params.onInterrupt(); return }
      // Shift+Enter: fall through — textarea inserts the newline natively.
    },
    [draft, params],
  )

  return { inputRef, draft, setDraft, onKeyDown, historyIndex, history, setInputText, endHistoryCycle }
}
```

Confirm `usePromptHistory`'s real parameter/return names against its source and adjust; do not invent fields.

- [ ] **Step 3: Mount the real `ComposerInput` shell in SessionView**

Replace the `<textarea>` block (`:263-278`) with the real shell. Keep `sendPrompt`/`interrupt`. Feed the disabled dictation controller for now:

```tsx
import { ComposerInput } from '@renderer/workspace/tile-tree/TileLeaf/ComposerInput'
import { useMobileComposer, dictationDisabled } from '../composer/useMobileComposer'

// replace the local `draft`/`setDraft`/`sendPrompt` textarea wiring with:
const composer = useMobileComposer({
  entries: transcript.entries,
  disabled: sending || transcript.exited,
  onSend: async (text) => {
    setSending(true); setError(null)
    try {
      const r = await feed.deliverPrompt(sessionId, text)
      if (!r.ok) setError(r.message)
    } finally { setSending(false) }
  },
  onInterrupt: interrupt,
})

// …in JSX, replacing the <div className="composer"> textarea block:
<div className="composer">
  <ComposerInput
    inputRef={composer.inputRef}
    input={composer.draft}
    focused={true}
    slashMode={false}
    provider={provider}
    draftImages={[]}
    pickerState={null}
    historyIndex={composer.historyIndex}
    history={composer.history}
    setInputText={composer.setInputText}
    endHistoryCycle={composer.endHistoryCycle}
    onKeyDown={composer.onKeyDown}
    onPaste={() => {}}
    onFocusRequest={() => {}}
    onUserEngagement={() => {}}
    onHoverChange={() => {}}
    removeDraftImage={() => {}}
    dictation={dictationDisabled}
    promptSuggestion={null}
    onApplySuggestion={() => {}}
    onDismissSuggestion={() => {}}
  />
</div>
```

The shell renders `SlashCommandPicker` with `pickerState={null}` → it no-ops (`state={{visible:false,items:[]}}`), and the draft-images strip is gated off by `draftImages={[]}`. Result: the real desktop composer visuals, no slash/image behavior.

- [ ] **Step 4: Typecheck + build**

Run: `npx tsc --noEmit -p tsconfig.web.json` (ignore `TS6305`), then `npm run client:build`. Expected: PASS. Fix any prop-type mismatches against the confirmed `ComposerInput`/`ComposerDictationController` signatures.

- [ ] **Step 5: Manual verification**

Phone: composer looks like desktop (`❯` chevron, border, auto-grow). Enter sends; Shift+Enter adds a newline; Esc interrupts a running turn; ArrowUp/Down cycles prompt history. No slash picker, no image strip.

- [ ] **Step 6: Commit**

```bash
git add src/remote-client/src/composer/useMobileComposer.ts src/remote-client/src/ui/SessionView.tsx
git commit -m "feat(remote): mount the real desktop ComposerInput shell

Replace the hand-rolled phone textarea with the desktop ComposerInput
component driven by a thin mobile controller (draft useState, Enter->send,
Shift+Enter->newline, Esc->interrupt, reused useComposerAutoGrow +
usePromptHistory). Slash picker and image strip disabled via props; a
disabled ComposerDictationController stands in until dictation lands.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Server `POST /dictate` route (Part C1)

**Files:**
- Modify: `src/main/remote/RemoteServer.ts` (route in `handleHttp` `:228-244`, new `handleDictate`)
- Modify: the `RemoteServer` construction site (search for `new RemoteServer(` — likely `src/main/remote/RemoteController.ts`) to inject a `transcribeAudio` dep.

**Interfaces:**
- Consumes: the existing token verifier used by `handleUpgrade` (read `RemoteServer.ts:363-388` to find the exact `this.deps.pairing.verifyToken(...)` call and its result shape), and the desktop batch transcriber `transcribeBatch` (`src/main/dictation/controller.ts:51`) + `readDeepgramApiKey()` (`src/main/ipc/dictation.ts:441`).
- Produces: `POST /dictate` → `{ ok: true, text }` or `{ ok:false, error }` with `401` on auth failure, `503` when no key.

- [ ] **Step 1: Confirm the transcriber signature and the token-verify call**

Read `src/main/dictation/controller.ts:51` for `transcribeBatch`'s exact parameters/return, `src/main/ipc/dictation.ts:441` for `readDeepgramApiKey()`, and `RemoteServer.ts:363-388` (`handleUpgrade`) for how it extracts + verifies the `?token=`/header token and what a verified result looks like. The `/dictate` handler mirrors that verification exactly.

- [ ] **Step 2: Add a `transcribeAudio` dependency to RemoteServer**

Add to `RemoteServer`'s deps type: `transcribeAudio: (audio: Buffer) => Promise<{ ok: true; text: string } | { ok: false; error: string }>`. At the construction site, wire it to call `transcribeBatch({ provider: 'deepgram', apiKey: readDeepgramApiKey(), audio })` + `wrapWithSttTag`, returning `{ ok:false, error:'no-key' }` when `readDeepgramApiKey()` is empty. (Match `transcribeBatch`'s real argument shape from Step 1.)

- [ ] **Step 3: Route + handler**

In `handleHttp`, add before the `GET` fallback (`:239`):

```ts
if (req.method === 'POST' && url.pathname === '/dictate') {
  await this.handleDictate(req, res)
  return
}
```

Add `handleDictate`, mirroring `handlePair`'s body-read + `handleUpgrade`'s token check:

```ts
private async handleDictate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Auth FIRST — same verification as the /ws upgrade (Step 1). Extract the
  // token from the same place the upgrade does (Authorization header or
  // ?token=), verify signature + revocation, 401 on any failure.
  const token = /* extract per Step 1 */ ''
  const verified = this.deps.pairing.verifyToken(token)   // match real API/return
  if (!verified.ok) { res.writeHead(401, { 'content-type': 'application/json' })
    .end(JSON.stringify({ ok: false, error: 'unauthorized' })); return }

  // Audio blob — cap generously but bounded (transcribe-and-discard, never persisted).
  const DICTATE_BODY_LIMIT_BYTES = 8 * 1024 * 1024
  const body = await readBodyCappedBinary(req, DICTATE_BODY_LIMIT_BYTES) // Buffer; add a binary
  // variant of readBodyCapped, or reuse it if it already returns raw bytes.

  const result = await this.deps.transcribeAudio(body)
  if (!result.ok) {
    const code = result.error === 'no-key' ? 503 : 502
    res.writeHead(code, { 'content-type': 'application/json' })
      .end(JSON.stringify({ ok: false, error: result.error })); return
  }
  res.writeHead(200, { 'content-type': 'application/json' })
    .end(JSON.stringify({ ok: true, text: result.text }))
}
```

If `readBodyCapped` (used by `handlePair`) returns a string, add a `readBodyCappedBinary` returning a `Buffer` (audio must not go through UTF-8). Keep the journal `record` calls consistent with `handlePair` (log `remote_dictate.ok/rejected`, no audio bytes).

- [ ] **Step 4: Typecheck (main)**

Run: `npx tsc -b tsconfig.node.json`
Expected: PASS. Fix dep-type/signature mismatches.

- [ ] **Step 5: Manual verification**

With the desktop app running and a valid device token (grab one from a paired device / the registry), from the same LAN:
```bash
# valid token + a small webm/opus sample → {"ok":true,"text":"…"}
curl -s -X POST "http://<lan-ip>:<port>/dictate" -H "Authorization: Bearer <token>" \
  --data-binary @sample.webm
# missing/garbage token → HTTP 401
curl -s -o /dev/null -w '%{http_code}\n' -X POST "http://<lan-ip>:<port>/dictate" --data-binary @sample.webm
```
Expect transcript text for the first, `401` for the second. If `DEEPGRAM_API_KEY` is unset, expect `503 no-key`.

- [ ] **Step 6: Commit**

```bash
git add src/main/remote/RemoteServer.ts src/main/remote/RemoteController.ts
git commit -m "feat(remote): token-gated POST /dictate reusing desktop STT

Add a /dictate route that verifies the device token exactly like the /ws
upgrade, reads the audio blob (bounded, transcribe-and-discard), and runs
the existing Deepgram batch transcriber via an injected transcribeAudio dep.
The API key stays in the main process; the phone never sees it. 401 on bad
token, 503 when no key configured.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Client dictation capture + wire into composer (Part C2)

**Files:**
- Create: `src/remote-client/src/dictation/mobileDictation.ts`
- Modify: `src/remote-client/src/composer/useMobileComposer.ts` (accept a dictation controller)
- Modify: `src/remote-client/src/ui/SessionView.tsx` (use the real controller, append transcript to draft)

**Interfaces:**
- Consumes: `packages/agent-voice-dictation` `browserRecorder` (capture), the device token (held in `App`/`pairing.ts`), `POST /dictate`.
- Produces: `useMobileDictation({ token, onTranscript })` returning a `ComposerDictationController` (the interface confirmed in Task 4 Step 1) with a real `busy` state and a start/stop/toggle that records → POSTs → yields text.

- [ ] **Step 1: Confirm the recorder API**

Read `packages/agent-voice-dictation/src/recorder/browserRecorder.ts` for its exported capture API (start/stop → `Blob`) and the produced mime type. Confirm it's importable in the phone Vite build (pure browser, no Node deps).

- [ ] **Step 2: Implement the mobile dictation controller**

Create `src/remote-client/src/dictation/mobileDictation.ts`. Tap-to-toggle: first tap starts `MediaRecorder`, second stops → POST blob to `/dictate` with the token → append returned text. Implement the full `ComposerDictationController` interface (from Task 4 Step 1) so it drops into the `ComposerInput` `dictation` prop.

```ts
import { useCallback, useRef, useState } from 'react'
import { createBrowserRecorder } from '@agent-code/voice-dictation' // match real export/path from Step 1
import type { ComposerDictationController } from '@renderer/workspace/tile-tree/TileLeaf/useComposerDictation'

export function useMobileDictation(params: {
  token: string
  onTranscript: (text: string) => void
}): ComposerDictationController {
  const [busy, setBusy] = useState(false)
  const [recording, setRecording] = useState(false)
  const recorderRef = useRef<ReturnType<typeof createBrowserRecorder> | null>(null)

  const toggle = useCallback(async () => {
    if (!recording) {
      recorderRef.current = createBrowserRecorder() // per Step 1 API
      await recorderRef.current.start()
      setRecording(true)
      return
    }
    setRecording(false)
    setBusy(true)
    try {
      const blob = await recorderRef.current!.stop()
      const res = await fetch('/dictate', {
        method: 'POST',
        headers: { Authorization: `Bearer ${params.token}` }, // match server extraction (Task 5)
        body: blob,
      })
      if (res.ok) { const { text } = await res.json(); if (text) params.onTranscript(text) }
    } finally { setBusy(false) }
  }, [recording, params])

  // Fill EVERY field of the confirmed ComposerDictationController interface.
  return {
    enabled: true,
    busy,
    levels: [0, 0, 0, 0, 0, 0, 0], // static; live meter is optional polish
    // start/stop/toggle mapped to `toggle` (and no-ops for any desktop-only
    // handlers) per the interface confirmed in Task 4 Step 1.
  } as ComposerDictationController
}
```

Handle mic-permission denial (catch `getUserMedia` rejection → `enabled` stays true but surface a one-time error; do not crash). Match the recorder + controller shapes exactly to Steps 1 and Task 4 Step 1.

- [ ] **Step 3: Wire the real controller through the composer**

In `useMobileComposer`, accept an optional `dictation?: ComposerDictationController` param and return it (defaulting to `dictationDisabled`). In `SessionView`, build the real controller and pass it, and feed its transcript into the draft:

```tsx
const dictation = useMobileDictation({
  token: /* the active device token from App/pairing */,
  onTranscript: (text) => composer.setDraft((d) => (d ? d + ' ' : '') + text),
})
// pass `dictation` into useMobileComposer(...) and then into <ComposerInput dictation={dictation} />
```

Thread the token from `App` into `SessionView` if not already available (it holds the `WebSocketSessionFeed`, which was constructed with the token — expose it or pass the token as a prop).

- [ ] **Step 4: Typecheck + build**

Run: `npx tsc --noEmit -p tsconfig.web.json` (ignore `TS6305`), then `npm run client:build`. Expected: PASS + build. Confirm `@agent-code/voice-dictation` (or the real package specifier) resolves in the phone Vite config; if not, add its alias/dep.

- [ ] **Step 5: Manual verification (real device)**

On a real phone paired to the desktop: tap the mic in the composer → grant permission → speak → tap again → transcript text appends to the draft. In the browser network inspector confirm the `POST /dictate` carries only audio + token (no API key). Revoke the device on the desktop → the next `/dictate` returns `401` and dictation stops working (feature correctly tied to the token).

- [ ] **Step 6: Commit**

```bash
git add src/remote-client/src/dictation/mobileDictation.ts src/remote-client/src/composer/useMobileComposer.ts src/remote-client/src/ui/SessionView.tsx
git commit -m "feat(remote): voice dictation in the mobile composer

Tap-to-toggle mic in the real ComposerInput dictation slot: capture with the
voice-dictation package's browserRecorder, POST the blob to the token-gated
/dictate route, append the returned transcript to the draft. Reuses the
desktop Deepgram engine; the key never reaches the phone. No push-to-hold
(no Fn key on a phone), batch-only (desktop's authoritative path).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Native shell polish + dead-CSS prune (Part B4)

**Files:**
- Modify: `src/remote-client/src/styles.css` (prune `.composer`/`.conditions` selectors now rendered via Tailwind; keep `.app/.topbar/.feed-host/.screen/.session-row/.pair`)
- Modify: `src/remote-client/src/ui/PairScreen.tsx` (remove inline `borderRadius:8` `:52-56` — violates the no-radius contract)
- Modify: `src/remote-client/src/ui/SessionList.tsx`, `src/remote-client/src/ui/App.tsx` (token-alignment polish only)

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing new.

- [ ] **Step 1: Prune dead composer/condition CSS**

In `styles.css`, remove the `.composer …` and `.conditions …` rules that styled the old hand-rolled controls (the composer and approval bar now render via Tailwind from the desktop components). Keep the container selectors still used by the native shell: `.app`, `.topbar`, `.feed-host`, `.screen`, `.terminal`, `.session-row`, `.pair`, `.conn-dot`, `.empty`, `.working`, `.section-label`. Grep the `src/remote-client/src` tree for each class you intend to delete to confirm it has no remaining JSX consumer before removing.

- [ ] **Step 2: Fix the radius contract leak in PairScreen**

Remove the inline `borderRadius: 8` (and any sibling inline styles) at `PairScreen.tsx:52-56`; rely on the shell's token classes (the contract is "no border-radius anywhere" — `styles.css:5-9`).

- [ ] **Step 3: Align SessionList/App to theme tokens**

Ensure `SessionList` rows and `App` connection states use the `--theme-*`-mapped chrome variables (already defined at the top of `styles.css`), removing any remaining hardcoded colors. Cosmetic only — no behavior change.

- [ ] **Step 4: Typecheck + build**

Run: `npx tsc --noEmit -p tsconfig.web.json` (ignore `TS6305`), then `npm run client:build`. Expected: PASS + build.

- [ ] **Step 5: Manual verification**

Phone: pairing screen, session list, and connection states look consistent with the desktop token system (no stray rounded corners, no off-theme colors). No visual regressions in the composer/approval regions (now Tailwind-driven).

- [ ] **Step 6: Commit**

```bash
git add src/remote-client/src/styles.css src/remote-client/src/ui/PairScreen.tsx src/remote-client/src/ui/SessionList.tsx src/remote-client/src/ui/App.tsx
git commit -m "chore(remote): prune dead chrome CSS + fix radius leak

Remove the .composer/.conditions selectors now rendered via the reused
desktop components; keep the load-bearing native-shell selectors. Drop the
inline borderRadius in PairScreen (violates the no-radius contract) and
align SessionList/App to the theme tokens.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Part A (responsive Feed) → Task 1. ✓
- Part B1 (condition outlet) → Task 2. ✓
- Part B2 (composer shell) → Task 4. ✓
- Part B3 (PaneHeader) → Task 3. ✓
- Part B4 (shell polish/prune) → Task 7. ✓
- Part B5 (`screenText` fallback preserved) → untouched by all tasks (explicitly kept in Tasks 2/4). ✓
- Part C1 (`/dictate` route) → Task 5. ✓
- Part C2 (client capture + insert) → Task 6. ✓
- Non-goals (slash, image, chips, terminals, native dictation) → not implemented; chips explicitly empty (Task 3), slash/image props disabled (Task 4). ✓
- Security (token-gated `/dictate`, key server-side, transcribe-and-discard) → Task 5. ✓

**Placeholder scan:** Code steps carry real code. Where an exact upstream signature must come from a file (the `ComposerDictationController` fields, `transcribeBatch` args, `PaneHeader`/`usePromptHistory` prop names, the token-verify call, the `browserRecorder` API), the step names the exact file+line to read and shows the integration code around it — these are deliberate "confirm-then-mirror" steps for reused desktop internals, not vague TODOs. No "add error handling"/"write tests"/"similar to Task N" placeholders.

**Type consistency:** `ComposerDictationController` is introduced in Task 4 (disabled stub) and implemented in Task 6 (real) — same type. `dispatch(action)` in Task 2 matches the `ConditionOutlet` `dispatch: (action) => Promise<void>` prop. `transcribeAudio` dep shape defined in Task 5 Step 2 matches its use in Step 3. `useMobileComposer`'s returned fields (Task 4) match the `ComposerInput` props they feed.

**Ordering note:** Task 4 must precede Task 6 (dictation replaces the disabled controller). Tasks 1/2/3/5 are mutually independent and may run in any order; Task 7 should run last (it prunes CSS the earlier tasks make dead).
