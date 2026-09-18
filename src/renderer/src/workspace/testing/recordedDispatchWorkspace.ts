import { readFileSync } from 'node:fs'

import type { LegacyDispatchMode } from '@renderer/workspace/persistence'
import type { TiledDispatchState, WorkspaceState } from '@renderer/workspace/types'

// One loader for `dispatch-global-d23.json`, the recorded real workspace that
// eight suites build on (lane resolution, grid layout, row scoping, pane
// labels, grid persistence, and three control-plane suites).
//
// WHY this file exists (#992):
//
// The recording is a v2 workspace. Its lane grid lives at
// `state.dispatchMode.tiled`, inside the envelope that also carried a
// layout-wide scope and a classic single-selection focus. The live
// `WorkspaceState` no longer has that envelope — the grid is a required
// top-level `stage`. Every suite used to `JSON.parse` the file and cast it
// straight to `{ state: WorkspaceState }`, which was honest while the shapes
// matched and would now be a lie the type system cannot see: `state.stage`
// would type-check and be `undefined` at runtime.
//
// WHY the recording is LIFTED here instead of being re-recorded or edited:
//
// A recorded fixture is evidence. Its value is that the product wrote it, so
// rewriting it by hand into the new shape would turn it into exactly the
// "plausible-looking literal" these suites chose a recording to avoid (see the
// header of gridPersistence.test.ts). Lifting in code keeps the bytes on disk
// untouched and makes the one transformation reviewable in one place.
//
// WHY the lift is a plain field move and NOT `migrateWorkspaceToStage`:
//
// The migration normalizes — it splits the legacy `ratios` array, synthesizes
// `rows`, scrubs row metadata and projects lanes field by field. Those are the
// behaviors gridPersistence.test.ts exists to check against this recording, so
// a loader that ran them first would hand that suite an already-migrated stage
// and let it pass while covering nothing. `stage` is therefore the recorded
// `tiled` block verbatim: legacy `ratios` present, `rows` absent. Suites that
// want the normalized grid call `normalizeStage` themselves, as the app does.

const FIXTURE_PATH = 'testing/fixtures/worktree-context/dispatch-global-d23.json'

export type RecordedDispatchObservation = {
  tabCount: number
  visibleRowCount: number
  mismatchCount: number
  /** The session the recording's label claims are about. */
  targetSessionId: string
  /** Its label in the cross-project index — what the user saw ("D23"). */
  targetVisibleLabel: string
  /** Its project-local coordinate, which deliberately differs ("D12"). */
  targetLocalLabel: string
  targetPlacement: string
}

export type RecordedDispatchWorkspace = {
  /** The recording on the live shape: v2 state with `stage` = recorded `tiled`. */
  state: WorkspaceState
  /**
   * The v2 envelope exactly as recorded, for the suites whose subject IS the
   * legacy shape. `tiled` is the same object the lift placed at `state.stage`.
   */
  recordedDispatchMode: LegacyDispatchMode & { tiled: TiledDispatchState }
  observed: RecordedDispatchObservation
}

type RecordedFile = {
  $fixture: { observed: RecordedDispatchObservation }
  state: Omit<WorkspaceState, 'stage'> & {
    dispatchMode: LegacyDispatchMode | null
  }
}

/**
 * Read the recording fresh on every call.
 *
 * Deliberately not memoized: suites mutate the state they are handed (they
 * re-aim lanes, delete sessions, bind rows), and a shared parsed object would
 * leak one test's edits into the next. Parsing a few hundred KB per call is
 * noise next to a jsdom render.
 */
export function loadRecordedDispatchWorkspace(): RecordedDispatchWorkspace {
  const file = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as RecordedFile
  const { dispatchMode, ...rest } = file.state
  const tiled = dispatchMode?.tiled
  if (!tiled || tiled.lanes.length === 0) {
    // Guard on the fixture itself. Every consumer's claims are about a
    // workspace that HAS lanes; if the file is ever re-recorded from a build
    // that stores the grid elsewhere, fail here with the reason rather than
    // in eight suites with `undefined is not iterable`.
    throw new Error(
      `${FIXTURE_PATH} no longer carries state.dispatchMode.tiled.lanes; ` +
        'update recordedDispatchWorkspace.ts for the shape it was re-recorded in',
    )
  }
  return {
    state: { ...rest, stage: tiled },
    recordedDispatchMode: { ...dispatchMode, tiled },
    observed: file.$fixture.observed,
  }
}
