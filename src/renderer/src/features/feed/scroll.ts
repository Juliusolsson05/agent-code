import type { ScrollPosition } from '@renderer/features/feed/types'

// Per-session scroll position memory.
//
// When the user switches tabs, App.tsx unmounts the inactive tab's
// TileTree — and with it, every Feed inside. When they switch back,
// a fresh Feed mounts with a brand-new scroll container at scrollTop=0.
// Without intervention that snaps the viewport to the top (or to a
// weird "just after first paint" position), which the user rightly
// called out as "weird and stupid."
//
// The fix is to persist each Feed's scroll state OUTSIDE the React
// component tree so it survives unmount. A module-level Map keyed by
// sessionId is the simplest possible store: no re-renders, no store
// plumbing, no prop noise. We record (scrollTop + stickyBottom flag)
// on every scroll tick and read them back in a useLayoutEffect on
// mount to restore the viewport BEFORE the browser paints.
//
// Why not put this in SessionRuntime: scroll position is a pure UI
// concern — no IPC, no persistence across app restarts, no other
// consumer. Hoisting it into the runtime state would force Feed to
// take an extra prop (workspace or a setter) and would invalidate
// Feed's React.memo shallow-compare on every scroll tick because the
// runtime object reference would change. Module-level Map sidesteps
// both problems.
//
// The Map is not bounded — if a session is killed, its entry sticks
// around forever. That's fine: each entry is two numbers and a
// boolean, and the Map only grows by the count of sessions EVER
// opened in this browser process lifetime (which typically resets
// on Electron window reload). Adding a cleanup on session kill
// would be a minor optimization if that ever matters.

export const scrollPositions = new Map<string, ScrollPosition>()
