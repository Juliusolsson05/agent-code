# Session Header Color Flag Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A color-flagged agent shows that color as a chunk on the right end of its pane's session header, overlapping the status strip, so a flagged agent is spottable in the grid and not only in the Dispatch list.

**Architecture:** The flag state already exists — `Settings.dispatchColorFlags` (sessionId → palette id), shipped in #603/#605. This adds a second *reader* of that state. The per-session lookup that `DispatchColorFlagStrip` performs inline is extracted into a `useColorFlag(sessionId)` hook so both surfaces resolve a flag identically; each surface keeps its own geometry, because a 10px alignment column and a 25% header chunk are different visual contracts. `PaneHeader` gains a `sessionId` prop and renders `PaneHeaderColorFlag` as a trailing flex child of its status row.

**Tech Stack:** React 18, Zustand (`useAppStore`), Tailwind 4, Vitest + Testing Library (happy-dom `renderer` project).

## Global Constraints

- **Do not rename `Settings.dispatchColorFlags`.** It is a persisted settings key; renaming needs a `PERSIST_VERSION` migration for a purely cosmetic gain.
- **Do not rename the command id `dispatch.color-flag.set`.** Command ids key `Settings.commandVisibilityOverrides`; renaming silently drops a user's saved overrides.
- **Do not change the palette** (`DISPATCH_COLOR_FLAGS`) — ids, labels, and hex values stay exactly as they are. Persisted values are these ids.
- **No new test files.** Extend `src/renderer/src/workspace/dispatch/DispatchColorFlags.renderer.test.tsx`, which already owns this feature's coverage.
- **No absolute positioning, no negative margins, no painting over padding** for the chunk. `docs/plans_and_ideas/2026-07-23-color-flag-layout-follow-up.md` established that flags participate in flex layout; this plan follows the same rule.
- **Thick WHY comments** per `CLAUDE.md`, especially wherever this deviates from the Dispatch strip's contract.
- Renderer tests run with `NODE_ENV=test`. A leaked `NODE_ENV=production` loads prod React and breaks `act()`.

---

## File Structure

**Create:**
- `src/renderer/src/app-state/settings/useColorFlag.ts` — the one place that turns a `sessionId` into a `ColorFlag | undefined`. No geometry, no JSX.
- `src/renderer/src/workspace/tile-tree/TileLeaf/PaneHeaderColorFlag.tsx` — the header chunk: geometry + the unflagged-renders-nothing decision.

**Modify:**
- `src/renderer/src/workspace/dispatch/DispatchColorFlagStrip.tsx` — consume the shared hook instead of selecting inline.
- `src/renderer/src/workspace/tile-tree/TileLeaf/PaneHeader.tsx` — `sessionId` prop, padding move, trailing chunk.
- `src/renderer/src/workspace/tile-tree/TileLeaf.tsx:620` — pass `sessionId`.
- `src/renderer/src/features/workspace/commands/dispatchColorFlagCommands.ts` — command description now names both surfaces.
- `src/renderer/src/app-state/settings/dispatchColorFlags.ts` — module header comment now names both surfaces.
- `src/renderer/src/workspace/dispatch/DispatchColorFlags.renderer.test.tsx` — new `describe` block for the header.

**Why one shared hook and two components:** the *state* question ("is this session flagged, and in what color?") is identical everywhere and must never fork. The *layout* question is genuinely different per surface. Sharing the first and splitting the second is what keeps a future third surface from copy-pasting a store selector.

---

### Task 1: Extract the shared flag lookup

Pure refactor. Behavior identical; the existing three color-flag tests are the regression net and must stay green without modification.

**Files:**
- Create: `src/renderer/src/app-state/settings/useColorFlag.ts`
- Modify: `src/renderer/src/workspace/dispatch/DispatchColorFlagStrip.tsx`
- Test: `src/renderer/src/workspace/dispatch/DispatchColorFlags.renderer.test.tsx` (existing cases, unchanged)

**Interfaces:**
- Consumes: `colorFlagById(id: string | undefined): ColorFlag | undefined` and `type ColorFlag` from `@renderer/app-state/settings/dispatchColorFlags`; `useAppStore` from `@renderer/app-state/hooks`.
- Produces: `useColorFlag(sessionId: SessionId): ColorFlag | undefined` — consumed by Task 2.

- [ ] **Step 1: Create the hook**

```tsx
// src/renderer/src/app-state/settings/useColorFlag.ts
import { useAppStore } from '@renderer/app-state/hooks'
import { colorFlagById, type ColorFlag } from '@renderer/app-state/settings/dispatchColorFlags'
import type { SessionId } from '@renderer/workspace/types'

/**
 * Resolve a session's color flag, or `undefined` when it has none.
 *
 * WHY this is a hook and not each surface selecting inline: color flags now
 * have more than one reader (the Dispatch trailing column and the pane header
 * chunk), and the thing that must NEVER fork between them is the state
 * question — which settings key is read, and how an unknown/stale persisted id
 * degrades. Geometry deliberately stays with each surface, because a 10px
 * alignment column and a 25% header chunk are different visual contracts that
 * should be free to diverge.
 *
 * Returning the resolved `ColorFlag` rather than the raw id means every caller
 * gets the same "unknown id → no flag" degradation for free: a palette entry
 * deleted in a future version stops rendering everywhere at once instead of
 * throwing at one call site and rendering `undefined` at another.
 */
export function useColorFlag(sessionId: SessionId): ColorFlag | undefined {
  return useAppStore(state => colorFlagById(state.settings.dispatchColorFlags[sessionId]))
}
```

- [ ] **Step 2: Point the Dispatch strip at the hook**

Replace the body of `DispatchColorFlagStrip.tsx` (keep the existing WHY comment block above the component verbatim — it documents the always-mounted-column decision, which is unchanged):

```tsx
import { memo } from 'react'

import { useColorFlag } from '@renderer/app-state/settings/useColorFlag'
import type { SessionId } from '@renderer/workspace/types'

// WHY this is a real, always-mounted flex child rather than conditional
// absolute decoration:
//
// Color flags are an index column. Rows must reserve the same trailing 10px
// whether they are flagged or not so titles and compact labels align while the
// user scans vertically. The first implementation painted over right padding,
// which made the rich list look correct in isolation but gave Tiled Dispatch no
// reusable width contract at all. Keeping the settings lookup and the geometry
// in one component makes every Dispatch selector opt into the same invariant.
//
// The settings lookup itself now lives in `useColorFlag` because the pane
// header reads the same state with different geometry; only the geometry below
// is Dispatch-specific.
export const DispatchColorFlagStrip = memo(function DispatchColorFlagStrip({
  sessionId,
}: {
  sessionId: SessionId
}) {
  const colorFlag = useColorFlag(sessionId)

  return (
    <span
      aria-hidden="true"
      data-dispatch-color-flag={colorFlag?.id ?? 'none'}
      className="pointer-events-none w-[10px] flex-none self-stretch"
      style={colorFlag ? { backgroundColor: colorFlag.color } : undefined}
    />
  )
})
```

- [ ] **Step 3: Run the existing color-flag tests — they must still pass unmodified**

Run: `NODE_ENV=test npx vitest run --project renderer src/renderer/src/workspace/dispatch/DispatchColorFlags.renderer.test.tsx`
Expected: PASS, 3/3. If any fail, the refactor changed behavior — fix the refactor, not the tests.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/app-state/settings/useColorFlag.ts src/renderer/src/workspace/dispatch/DispatchColorFlagStrip.tsx
git commit -m "refactor(color-flags): extract the per-session flag lookup into useColorFlag"
```

---

### Task 2: The header chunk

**Files:**
- Create: `src/renderer/src/workspace/tile-tree/TileLeaf/PaneHeaderColorFlag.tsx`
- Modify: `src/renderer/src/workspace/tile-tree/TileLeaf/PaneHeader.tsx`
- Modify: `src/renderer/src/workspace/tile-tree/TileLeaf.tsx:620-630`
- Test: `src/renderer/src/workspace/dispatch/DispatchColorFlags.renderer.test.tsx`

**Interfaces:**
- Consumes: `useColorFlag(sessionId)` from Task 1.
- Produces: `PaneHeaderColorFlag({ sessionId }: { sessionId: SessionId })`; `PaneHeader` gains a required `sessionId: SessionId` prop. DOM contract for tests: the chunk carries `data-pane-color-flag="<flagId>"` and is absent entirely when unflagged.

- [ ] **Step 1: Write the failing tests**

Append this block to `DispatchColorFlags.renderer.test.tsx`, after the existing `describe`. The file's existing `vi.mock('@renderer/app-state/hooks', …)` and `setColorFlags` helper cover this block too — `useColorFlag` reads through that same mocked boundary.

```tsx
// WHY the pane-header cases live in this file rather than a new one: this file
// is the color-flag feature's coverage, not the Dispatch list's. The flag is
// one piece of state with several renderers, and keeping every renderer's
// contract in one place is what caught the tiled-lane gap that #605 had to fix.
describe('Session header color flag', () => {
  function renderHeader(sessionId: string, statusMode: boolean) {
    return render(
      <PaneHeader
        sessionId={sessionId}
        paneLabel="A2"
        projectDir="/Users/dev/agent-code"
        statusMode={statusMode}
        isSessionLive
      />,
    )
  }

  it('paints a trailing chunk of the flag color over the status strip', () => {
    setColorFlags({ [FLAGGED_SESSION_ID]: 'red' })
    const { container } = renderHeader(FLAGGED_SESSION_ID, true)

    const chunk = container.querySelector<HTMLElement>('[data-pane-color-flag]')
    expect(chunk).toHaveAttribute('data-pane-color-flag', 'red')
    expect(chunk).toHaveClass('w-1/4', 'flex-none', 'self-stretch')
    expect(chunk).not.toHaveClass('absolute')
    expect(chunk).toHaveStyle({ backgroundColor: '#ef4444' })
  })

  it('renders no chunk at all for an unflagged session', () => {
    setColorFlags({ [FLAGGED_SESSION_ID]: 'red' })
    const { container } = renderHeader(UNFLAGGED_SESSION_ID, true)

    // WHY absence rather than a transparent placeholder — the deliberate
    // difference from the Dispatch column. Nothing sits to the right of this
    // chunk, so there is no cross-row alignment to preserve, and reserving a
    // quarter of every header would permanently squeeze the project dir for a
    // signal that is switched off.
    expect(container.querySelector('[data-pane-color-flag]')).toBeNull()
  })

  it('keeps the row padding on the label group so the chunk can bleed to the pane edge', () => {
    setColorFlags({ [FLAGGED_SESSION_ID]: 'purple' })
    const { container } = renderHeader(FLAGGED_SESSION_ID, false)

    const row = container.querySelector<HTMLElement>('[data-pane-header-row="true"]')
    expect(row).toHaveClass('pl-3')
    expect(row).not.toHaveClass('px-3')
    expect(row).not.toHaveClass('py-1')
    // The vertical padding still exists — it moved one level down, so the
    // header's rendered height is unchanged while the chunk stretches full-bleed.
    expect(row?.firstElementChild).toHaveClass('py-1')
  })
})
```

Add `PaneHeader` to the file's imports:

```tsx
import { PaneHeader } from '@renderer/workspace/tile-tree/TileLeaf/PaneHeader'
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `NODE_ENV=test npx vitest run --project renderer src/renderer/src/workspace/dispatch/DispatchColorFlags.renderer.test.tsx`
Expected: FAIL — TypeScript/runtime error that `PaneHeader` has no `sessionId` prop, and no element matches `[data-pane-color-flag]`.

- [ ] **Step 3: Create the chunk component**

```tsx
// src/renderer/src/workspace/tile-tree/TileLeaf/PaneHeaderColorFlag.tsx
import { memo } from 'react'

import { useColorFlag } from '@renderer/app-state/settings/useColorFlag'
import type { SessionId } from '@renderer/workspace/types'

// The session-header half of the color-flag feature: a flagged agent paints a
// chunk of its pane header in the flag color, so it is spottable while scanning
// the grid and not only while scanning the Dispatch list.
//
// WHY 25% of the header width rather than a fixed pixel chunk: panes in a tiled
// grid vary enormously in width, and a fixed chunk reads as a huge slab in a
// narrow lane and a rounding error in a wide one. A proportional chunk keeps
// the same visual weight in every pane, which is the whole point of a signal
// meant to be recognized peripherally.
//
// WHY nothing is rendered when unflagged — and why that DIFFERS from
// DispatchColorFlagStrip, which always mounts a transparent 10px column:
// that column exists to hold Dispatch labels in vertical alignment across rows.
// Nothing sits to the right of this chunk, so there is no alignment invariant
// to protect here, and permanently reserving a quarter of the header would
// squeeze the project-dir text for a signal that is switched off. If a future
// header ever grows content to the RIGHT of this chunk, that reasoning
// inverts — mount it always and make it transparent, like the Dispatch column.
//
// `self-stretch` (not a fixed height) is what makes it overlap the status
// strip: in Status Mode the header row collapses to ~5px, and the chunk paints
// over the right quarter of the accent fill. `flex-none` keeps it at exactly
// 25% instead of letting the truncating label group push it around.
export const PaneHeaderColorFlag = memo(function PaneHeaderColorFlag({
  sessionId,
}: {
  sessionId: SessionId
}) {
  const colorFlag = useColorFlag(sessionId)
  if (!colorFlag) return null

  return (
    <span
      aria-hidden="true"
      data-pane-color-flag={colorFlag.id}
      className="pointer-events-none w-1/4 flex-none self-stretch"
      style={{ backgroundColor: colorFlag.color }}
    />
  )
})
```

- [ ] **Step 4: Wire it into `PaneHeader`**

In `PaneHeader.tsx`: add the imports, add `sessionId` to the props type and destructuring, move the row's vertical padding down onto the label group, and render the chunk as the row's trailing child.

Imports to add:

```tsx
import { PaneHeaderColorFlag } from '@renderer/workspace/tile-tree/TileLeaf/PaneHeaderColorFlag'
import type { SessionId } from '@renderer/workspace/types'
```

Props — add as the first entry in both the destructuring and the type:

```tsx
  sessionId,
```

```tsx
  sessionId: SessionId
```

Replace the status row (the `<div>` at `PaneHeader.tsx:36-55`) with:

```tsx
      <div
        data-pane-header-row="true"
        className={`flex items-center justify-between pl-3 text-[10px] ${
          statusMode
            ? isSessionLive
              ? 'bg-accent text-accent-fg'
              : 'bg-surface text-muted'
            : 'bg-surface text-muted'
        } ${statusMode ? 'min-h-[5px]' : ''}`}
      >
        {/* WHY the vertical padding sits on this group instead of on the row:
            the color-flag chunk uses `self-stretch`, which fills the row's
            CONTENT box — with `py-1` on the row the chunk would float with a
            4px gap above and below and read as a floating pill rather than a
            slice of the header. Pushing the padding one level down keeps the
            header's rendered height byte-for-byte identical (the same 4px still
            exists, just inside this child) while letting the chunk bleed from
            the top edge of the header to the bottom. The row also drops its
            right padding — `px-3` became `pl-3` — so the chunk reaches the pane
            edge without an absolute overlay or a negative margin, per the
            layout contract in
            docs/plans_and_ideas/2026-07-23-color-flag-layout-follow-up.md. */}
        <div className={`flex items-center gap-2 min-w-0 ${statusMode ? 'py-0' : 'py-1'}`}>
          {paneLabel && (
            <span className="flex-shrink-0 rounded-[3px] border border-current/30 px-1 leading-[14px] text-[9px] font-semibold tabular-nums">
              {paneLabel}
            </span>
          )}
          <span className="truncate" title={projectDir ?? 'no project dir'}>
            {shortenCwd(projectDir)}
          </span>
        </div>
        <PaneHeaderColorFlag sessionId={sessionId} />
      </div>
```

Also extend the component's existing header comment — it currently describes only the accent/absence status signal, and a second color source in the same strip is exactly the kind of thing that confuses a future reader:

```tsx
// Pane header: compact status strip.
//
// In status mode, working panes paint with the theme accent;
// idle/exited panes get no fill — the absence of color is the
// signal, so a glance across the grid highlights only the
// panes that still want attention. Previous design used
// green/red, but red read as "error" for merely idle panes.
//
// The right quarter of the strip is owned by the session's color flag when one
// is set (PaneHeaderColorFlag). The two signals are deliberately allowed to
// overlap: liveness is automatic and transient, the flag is manual and sticky,
// so a user who flagged a pane red wants that red regardless of whether the
// agent happens to be running right now. The flag always wins its slice.
```

- [ ] **Step 5: Pass `sessionId` from `TileLeaf`**

At `TileLeaf.tsx:620`, add the prop to the existing `<PaneHeader … />` call:

```tsx
      <PaneHeader
        sessionId={sessionId}
        paneLabel={paneLabel}
        projectDir={runtime.projectDir}
        statusMode={showStatusMode}
        isSessionLive={isSessionLive}
        relatedAgentTabs={relatedAgentTabs}
        selectedRelatedSessionId={selectedRelatedSessionId ?? sessionId}
        runtimes={workspace.runtimes}
        ownerSessionId={ownerSessionId ?? sessionId}
        onSelectRelatedSession={onSelectRelatedSession}
      />
```

All three providers share this `TileLeaf` (`src/providers/registry.renderer.ts` maps Claude, Codex, and OpenCode to the same component), so this single call site covers every provider, the classic grid, and tiled Dispatch lanes.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `NODE_ENV=test npx vitest run --project renderer src/renderer/src/workspace/dispatch/DispatchColorFlags.renderer.test.tsx`
Expected: PASS, 6/6 (3 pre-existing Dispatch cases + 3 new header cases).

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/workspace/tile-tree/TileLeaf/PaneHeaderColorFlag.tsx \
        src/renderer/src/workspace/tile-tree/TileLeaf/PaneHeader.tsx \
        src/renderer/src/workspace/tile-tree/TileLeaf.tsx \
        src/renderer/src/workspace/dispatch/DispatchColorFlags.renderer.test.tsx
git commit -m "feat(color-flags): paint the flag color into the session header"
```

---

### Task 3: Retire the Dispatch-only copy

The command description and the palette module both tell the user this feature marks a Dispatch row. That is now half the truth, and stale user-facing copy is worse than none.

**Files:**
- Modify: `src/renderer/src/features/workspace/commands/dispatchColorFlagCommands.ts`
- Modify: `src/renderer/src/app-state/settings/dispatchColorFlags.ts`

- [ ] **Step 1: Update the command description**

In `dispatchColorFlagCommands.ts`, replace the `description` field and extend the comment above the export:

```ts
    description:
      '**What it does:** Marks the focused agent with a color — a chunk of its ' +
      '**session header** in the grid, and a strip on the right edge of its ' +
      '**Dispatch row**.\n\n' +
      '**Use when:** You are juggling several agents and want to flag one ' +
      '(e.g. red) to find it fast.',
```

Add to the comment block above `dispatchColorFlagCommands`:

```ts
// The export, the command id, and the settings key all still say "dispatch"
// even though the flag now renders in the pane header too. Both names are
// persisted identifiers, not descriptions: the command id keys
// `Settings.commandVisibilityOverrides` and the settings key holds the flags
// themselves, so renaming either costs a migration and can silently drop a
// user's saved command-visibility choices. The name is historical — the
// feature was born in Dispatch. Treat "dispatch color flag" as the concept's
// proper noun, not as a claim about where it renders.
```

- [ ] **Step 2: Update the palette module header**

In `dispatchColorFlags.ts`, replace the first paragraph of the module comment (the sentence describing where the flag paints) with:

```ts
// Dispatch color flags — the fixed swatch palette + coercion.
//
// A "color flag" is a per-agent marker the user sets from the "Set color flag"
// command. It renders in two places: a thick strip on the right edge of that
// agent's Dispatch row, and a chunk of the right end of its pane's session
// header in the grid. See docs/plans_and_ideas/2026-07-23-dispatch-color-flags.md
// for the original feature and docs/superpowers/plans/2026-07-26-session-header-color-flag.md
// for the header surface.
```

- [ ] **Step 3: Verify nothing else claims Dispatch-only**

Run: `grep -rn "Dispatch row" src/renderer/src --include='*.ts' --include='*.tsx'`
Expected: only matches that are genuinely about Dispatch rows. Any remaining color-flag copy claiming the flag renders *only* in Dispatch should be corrected in this task.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/features/workspace/commands/dispatchColorFlagCommands.ts \
        src/renderer/src/app-state/settings/dispatchColorFlags.ts
git commit -m "docs(color-flags): copy now describes both flag surfaces"
```

---

### Task 4: Full verification

**Files:** none — this task only runs gates.

- [ ] **Step 1: Type-check both projects**

Run: `npm run typecheck`
Expected: exit 0, no output. This is the real gate — `electron-vite build` and Vitest do not type-check.

- [ ] **Step 2: Run the renderer project**

Run: `NODE_ENV=test npx vitest run --project renderer`
Expected: all pass, including the 6 color-flag cases.

- [ ] **Step 3: Run the full suite**

Run: `NODE_ENV=test npx vitest run`
Expected: all pass. One known environment flake exists outside this change: `packages/claude-code-headless` `JsonlTailer.test.ts` "second tailer survives first closing" (fs.watch timing). If only that fails, it is pre-existing — note it, do not chase it.

- [ ] **Step 4: Manual check**

Run: `npm run dev`. Then:
1. Command palette → **Set color flag** → red, on a focused grid agent.
2. Confirm the right quarter of that pane's header is red, flush to the pane's right edge and the full height of the header strip.
3. Toggle Status Mode off and confirm the chunk still fills the taller header edge-to-edge, and the header did not change height.
4. Confirm the flagged agent's Dispatch row strip still renders (Task 1 must not have regressed it).
5. **Clear flag** → the header chunk disappears with no leftover gap.
6. Restart the app → the flag is still there (it is persisted settings).

---

## Self-Review

**Spec coverage:** placement inside the existing header row (Task 2 Step 4), right end (`justify-between` + trailing child), overlapping the status strip (`self-stretch` + the flag-wins comment), proportional 25% width (Task 2 Step 3), shared lookup (Task 1), `sessionId` plumbing (Task 2 Step 5), stale copy (Task 3). All covered.

**Placeholders:** none — every code step carries the literal code.

**Type consistency:** `useColorFlag(sessionId: SessionId): ColorFlag | undefined` is defined in Task 1 and consumed with that exact signature in Task 2. `SessionId` is `string` (`src/renderer/src/workspace/types.ts:27`), so the existing tests' plain string session ids type-check against the new `PaneHeader` prop. The DOM hooks `data-pane-color-flag` and `data-pane-header-row` are asserted in Task 2 Step 1 and emitted in Steps 3-4 under the same names.
