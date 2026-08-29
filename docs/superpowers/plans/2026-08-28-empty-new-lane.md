# New Lane inserts an empty lane

> Fixes #673

## Outcome

**New Lane** stops claiming an agent. The inserted lane arrives empty with
placeholder copy that names the state and the way out of it, and keyboard
navigation from that lane behaves as though it had been sitting at the top of
the index — the first ⌥↓ or ⌥↑ selects the top row, the second moves on
normally. ("Top of the index", not `a1`: pinned rows sort first and are labelled
★1. See §6.)

## The problem

`new-tiled-lane` (`layoutCommands.ts:66`) calls `insertTiledLaneRight`, which
delegates to `insertLaneRightIntoTiled` (`tiledDispatchSelectors.ts:208`). That
helper asks `buildAutoLanes` for one more lane than currently exists and splices
the computed tail lane into the requested position:

```ts
const expanded = buildAutoLanes(state, tiled.lanes.length + 1, tiled.lanes)
const insertedLane = expanded[tiled.lanes.length] ?? {}
```

`buildAutoLanes` fills any unpreserved lane with the first visible Dispatch row
not already claimed by another lane:

```ts
const next = rows.find(row => !claimed.has(row.sessionId))
```

So the new lane arrives pre-filled with an agent the user did not pick. Because
`claimed` only contains agents *currently shown in lanes*, the first unclaimed
row in index order is very often `a1` — which means the common case of "give me
another view" silently duplicates the top of the index into the slot beside the
one you were commanding.

### Why the current behaviour exists, and why it is still wrong here

The auto-fill itself is right for the operation it was written for. Entering
Tiled Dispatch at N tiles means "I want to see N agents", and landing the user
on N empty pickers would be busywork — `buildAutoLanes`' own comment says
exactly this. The mistake is that **New Lane inherited that contract by reusing
the helper**, and New Lane is a different request. Growing the tile count is a
statement about how many agents you want visible; inserting a lane beside the
one you are commanding is a statement about *space*. Space does not imply a
particular occupant.

The existing comment on `insertLaneRightIntoTiled` argues the opposite —
that routing through `buildAutoLanes` "lets insertion and ordinary count growth
stay in lockstep as pinned rows, terminals, and future row kinds evolve". That
was a reasonable call when the two operations were assumed to want the same
thing. This change is the discovery that they do not, so that comment is
rewritten rather than left asserting a coupling we deliberately broke.

## What this does NOT change

- **Tile-count growth still auto-fills.** `buildAutoLanes` is untouched.
  Entering Tiled Dispatch at N, and raising the count from N to N+1, both keep
  pre-filling. Only the spatial insertion path changes.
- **Lane removal, ratios, and focus** are untouched.
- **Duplicates stay legal.** Nothing here makes "the same agent in two lanes"
  invalid; the user can still put it there deliberately.

## Design

### 1. Insert an empty lane

`insertLaneRightIntoTiled` stops calling `buildAutoLanes` and splices `{}`.

This removes the only reason that function needed `state`, so the parameter
goes with it. That is a real simplification rather than churn: the helper's
remaining job is purely structural — splice a slot, shift focus, re-weight
ratios — and none of it depends on which sessions exist. Dropping the argument
makes the "no session lifecycle happens here" invariant true by signature
instead of by comment.

### 2. Placeholder copy

An empty lane already renders `<DispatchEmpty message="select an agent" />`
(`TiledDispatchLayout.tsx:280`). Two things are wrong with that string for a
lane the user has *just deliberately created*:

- It is an instruction with no subject. It does not say the lane is empty, and
  it does not say how to select.
- It is the same string used for the pre-existing exhaustion case, where the
  user did not ask for anything.

`DispatchEmpty` grows an optional `hint` so the placeholder can state the
condition and then the affordance, in that order:

```
Empty lane
Pick an agent from the strip, or press ⌥↓
```

Per `docs/command-style.md` the copy names what the user controls and stays in
sentence case. It cites `⌥↓` specifically because that is now a guaranteed
one-press route to the top row (design point 3), so the hint is a promise the
code keeps
rather than a general gesture at the UI.

The hint is rendered only where it is true. The index lane (`laneIndex === 0`)
has no mini-strip, so its empty state keeps the plain message.

### 3. Arrow navigation from an empty lane

Already correct, and this plan's job is to pin it.

`moveTiledLaneSelection` (`useKeybinds.ts:981`) resolves the lane's current row
index, which is `-1` when nothing is selected, and asks:

```ts
nextTiledRowIndex(currentIndex, delta, rows.length)
// if (currentIndex < 0) return delta < 0 ? length - 1 : 0
```

So ⌥↓ from an empty lane already landed on index 0 (the top row) — but ⌥↑ landed on
the **last row**, which this plan originally recorded incorrectly as also being
the top row. Reading the branch closed that: the direction of the very first keystroke
decided whether a fresh lane opened at the top or the bottom of the index.

That was defensible while an empty lane was a rare exhaustion state nobody asked
for. It is wrong now that New Lane deliberately creates one every time, and it
would make the lane's own placeholder copy conditional on which arrow the user
happened to reach for. The branch now returns `0` in **both** directions:

```ts
if (currentIndex < 0) return 0
```

The model is that an empty lane behaves as though it were already sitting at
the top row. The first press in either direction COMMITS that position; every
press after it navigates normally. So ⌥↓ ⌥↓ gives row 1 then row 2, and ⌥↓ ⌥↑
gives row 1 then a wrap to the last row.

The alternative reading — treat the virtual cursor as *being* the top row so the
first press steps off it to row 2 — was considered and rejected: it makes the
top row unreachable by arrow from a fresh lane, and it means the first keypress
can scroll past the thing the user most likely wanted.

This is a small production change plus the coverage that was missing: no test
asserted the empty-lane branch's *sequence*, so a regression that made it sticky
(always returning 0) would strand the user on the top row and still pass a single-call
assertion.

### 4. Command description

The command's own `description` currently promises the behaviour being removed
("The new lane shows the first visible agent not already represented, or an
empty selector when every agent already has a lane"). It is rewritten. A stale
description is worse than none because the palette is where users learn what a
command does.

### 5 — The healer (found in review; the reason the first attempt was a no-op)

The design above is necessary and was not sufficient. `TiledDispatchLayout` runs
an unconditional auto-fill effect:

```ts
for (let i = 0; i < laneResolutions.length; i++) {
  if (laneResolutions[i]) continue
  const next = available[cursor]; if (next === undefined) break
  workspace.setTiledLaneSession(i, next)   // fills the brand-new empty lane
}
```

Inserting a lane produces a new `lanes` array, which produces a new
`laneResolutions` memo, which fires the effect on the very next render. It hands
the new lane the first unclaimed agent — the same one `buildAutoLanes` would
have chosen. **The first implementation of this plan was therefore a behavioural
no-op**: identical final state, one extra render frame of the placeholder, one
extra store write. It survived only in the pre-existing exhaustion case, where
`available` is empty and the old code also produced `{}`.

The codebase said so in three comments the first attempt did not read
(`types.ts`, and twice in `tiledDispatchSelectors.ts`): empty was modelled as a
**transient** state that always heals.

#### Why a flag, and not a smarter healer

The close path depends on healing. When an agent exits, `clearTiledLaneSessions`
blanks its lane *precisely so* the healer re-homes another agent into the hole.
So "empty because the user asked" and "empty because the agent died" are the
same shape (`selectedSessionId === undefined`) and must behave differently. The
distinction has to be recorded, not inferred.

Rejected alternative: "only heal lanes that previously resolved." That reads
history the reducer does not keep, and it breaks the close-heal contract for any
lane whose agent dies before it ever resolved.

`DispatchLane.userEmptied?: true` is set only by insertion and cleared by any
explicit selection — once the user puts an agent in the lane it is an ordinary
lane and must heal like one. It survives autosave and rehydrate by spread, which
is intended: a lane deliberately left empty should still be empty after a
restart.

### 6 — Two other review corrections

**The hint pointed at the wrong lane.** New Lane deliberately keeps focus on the
*source* lane, and ⌥↓ acts on `tiled.focusedLane`. Rendering the hint in every
unfocused empty lane told the user to press a key that would yank the agent they
were working with, leaving the new lane untouched. The hint is now gated on
`focused`.

**"a1" was inaccurate.** `nextTiledRowIndex` returns row 0 of
`buildVisibleDispatchRows`, which puts pinned rows first — labelled ★1, not a1.
True of the downward press before this change too, but the placeholder now makes
a promise about the key, so the copy and the comments say "top of the index".

## Testing

Following the repository's rule that a test must defend a contract with a
plausible failure mode, not restate the implementation:

1. **`insertLaneRightIntoTiled` inserts an empty lane** even when unclaimed
   agents exist. This is the regression: the old code pulled one in, and the
   failure mode is silent (a duplicated agent looks plausible).
2. **Tile-count growth still auto-fills.** The obvious wrong fix for #673 is to
   change `buildAutoLanes`, which would break entering Tiled Dispatch at N. This
   test is the guard on that blast radius, and it is the reason the two paths
   are worth separate coverage.
3. **⌥↓ from an empty lane selects the top row, and a second press advances.**
   Asserted as a SEQUENCE through `nextTiledRowIndex`, not a single call: a
   regression making the empty branch sticky would strand the user on row 0 and
   still satisfy a one-call assertion. (`moveTiledLaneSelection` is not exported
   and should not be exported merely to be tested; it re-derives the index via
   `rows.findIndex` on the written session id, which is equivalent to the
   sequence here as long as row order is stable between presses.)
4. **⌥↑ from an empty lane selects the top row, and a second press wraps to the last
   row.** Same reasoning; also pins the mirror case the issue names.

5. **The layout does not refill a `userEmptied` lane, and still refills one
   whose agent went away.** This is the test that had to exist: the pure-splice
   tests all passed while the feature did nothing, because the override happens
   in a `useEffect` no unit test mounts. Verified to fail without the healer
   guard ("expected vi.fn() to not be called at all, but actually been called 1
   times"). Its second case pins the tension — the deliberate hole survives, the
   accidental one still heals — so a future fix for one cannot silently break
   the other.

Existing `tiledLaneInsertion.test.ts` coverage of focus shifting, the lane
ceiling, and ratio weighting must keep passing unchanged — those contracts are
orthogonal and this change must not disturb them.

## Risks

- **A user who relied on the auto-fill loses one keystroke.** Accepted: that is
  the reported bug, and ⌥↓ restores the old result in one press.
- **`DispatchEmpty` is shared.** It is used by classic Dispatch and the index
  lane too, so the hint is optional and defaults off; no existing call site
  changes behaviour.
- **Signature change to `insertLaneRightIntoTiled`.** Internal to the renderer
  with two callers (the action and its test), so the compiler finds them all.
