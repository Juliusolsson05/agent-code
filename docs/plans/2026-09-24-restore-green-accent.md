# Restore the green accent next to the Nord default

Issue: #1173 (refs #973)

## Problem

Shipping Nord + Frost as the default (#973, `b343df3b`) was meant to add Nord
and make it the default. It also deleted the Lime and Sage accents, so the green
look the app used to ship with can no longer be selected.

## Decision

- Restore **Lime** only (`#7dd3a0` dark / `#2f6f46` light, its original values).
  It was the old default green. Sage was a second, muted green. Leaving it out
  keeps the Appearance menu's 4-column accent grid at an even 4 × 2 (8 accents).
- New order: Frost, Lime, Amber, Magenta, Gold, Coral, Lavender, Sky.
  Frost stays first because `ACCENTS[0]` is the fallback in `applyTheme`, and it
  is the default. Sky moves to the end as requested.
- Nord + Frost stay the defaults. Fallback palettes (xterm, Monaco, window
  pre-paint, phone client) stay Nord; they follow the default, not the option list.

## The trap: the Dark + Lime migration

`migrateLegacyDefaultAppearance` (in `persistence.ts`) turns a blob on exactly
Dark + Lime into Nord + Frost. It runs inside `coerceSettings`, and the store's
`merge` calls that on **every** hydration. That was only safe because `'lime'`
stopped existing. Once Lime is selectable again, a user who picks Dark + Lime
would be silently reset to Nord + Frost on every launch.

Fix: run the migration only for blobs persisted before store v11 (the version
#973 bumped to), from the store's `migrate` callback. Zustand calls `migrate`
only when the stored version is older and feeds its output to `merge`, so:

- a v10 blob on Dark + Lime still follows the default to Nord + Frost (#973
  behavior kept);
- a v11+ blob on Dark + Lime is a real choice and is kept.

No version bump: v11 blobs have already been through the migration.

Side effect: pre-v11 blobs with Lime on a non-Dark theme were being moved to
Frost only because Lime failed the membership check. They now keep Lime, which
is the user's own choice. Sage still falls back to Frost.

## Tests

- `store.test.ts`: real `persist.rehydrate()` of a v10 Dark + Lime blob →
  Nord + Frost, and of a v11 Dark + Lime blob → Dark + Lime.
- `persistence.test.ts`: `coerceSettings` keeps Lime (no migration on the
  per-launch path), still sends Sage to Frost, and Frost / Sky sit first / last.

## Verification

`npx tsc -b`, then the settings and store Vitest files, once at the end.
