import { useGlobalEditorStore } from '@renderer/features/global-editor/store'

// Global Editor persistence: geometry + open-tab PATHS per cwd (#513).
//
// WHY localStorage and not a main-process persistence channel: the
// store's original header documented the risk ("every persistence path
// is a potential leak") specifically about UNSAVED FILE CONTENTS. This
// module never touches contents — it stores relative paths and three
// numbers. localStorage keeps it renderer-local, synchronous at boot (no
// IPC race with first paint), and trivially inspectable from devtools.
//
// WHY paths-only survives correctness review: on rehydrate the shell
// re-opens each path through openFileInGlobalEditor, which reads from
// disk — files that changed while the app was closed load fresh, files
// that were deleted simply fail to open and drop out. There is no
// stale-content class of bug because there is no persisted content.
//
// MODULE-CYCLE NOTE: store.ts imports loadPersistedGlobalEditorState from
// here for initial geometry, and this file imports the store for the
// subscriber. The cycle is benign because neither side touches the other
// at module-evaluation time — the store only CALLS the load function
// (which reads localStorage, not the store), and this file only touches
// useGlobalEditorStore inside startGlobalEditorPersistence, invoked long
// after both modules are initialized. Moving the load function to a third
// file would silence the cycle but hide the coupling this note explains.

export type PersistedGlobalEditorState = {
  version: 1
  splitterRatio: number
  fileTreeWidthPx: number
  fileTreeVisible: boolean
  tabsByCwd: Record<string, { fileOrder: string[]; activeFilePath: string | null }>
}

const KEY = 'agent-code:global-editor:v1'
// LRU-ish cap so a year of visited projects doesn't accrete an unbounded
// blob (localStorage quota is shared with everything else renderer-side).
const MAX_CWDS = 20
// One write per burst of store changes. 500ms trailing debounce: typing
// mutates the store every keystroke, and serializing tabsByCwd per
// keystroke is pure waste — nothing here changes faster than a human
// opens/closes tabs.
const WRITE_DEBOUNCE_MS = 500

export function loadPersistedGlobalEditorState(): PersistedGlobalEditorState | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as PersistedGlobalEditorState
    if (parsed?.version !== 1) return null
    if (typeof parsed.tabsByCwd !== 'object' || parsed.tabsByCwd === null) return null
    return parsed
  } catch {
    // Corrupt JSON / disabled storage — start fresh rather than crash the
    // store module at import time.
    return null
  }
}

/** Subscribe the persistence writer. Returns a stop function; call once
 *  from the shell (an app has exactly one Global Editor). */
export function startGlobalEditorPersistence(): () => void {
  let timer: number | null = null
  const unsub = useGlobalEditorStore.subscribe(() => {
    if (timer !== null) return
    timer = window.setTimeout(() => {
      timer = null
      const s = useGlobalEditorStore.getState()
      // Object key order IS insertion order for string keys, and byCwd
      // only ever gains keys — slice(-MAX_CWDS) keeps the most recently
      // first-visited cwds. Not strictly LRU, but the failure mode is
      // just "a very old project forgets its tabs".
      const cwds = Object.keys(s.byCwd).slice(-MAX_CWDS)
      const tabsByCwd: PersistedGlobalEditorState['tabsByCwd'] = {}
      for (const cwd of cwds) {
        const cwdState = s.byCwd[cwd]
        if (!cwdState || cwdState.fileOrder.length === 0) continue
        tabsByCwd[cwd] = {
          fileOrder: cwdState.fileOrder,
          activeFilePath: cwdState.activeFilePath,
        }
      }
      try {
        localStorage.setItem(
          KEY,
          JSON.stringify({
            version: 1,
            splitterRatio: s.splitterRatio,
            fileTreeWidthPx: s.fileTreeWidthPx,
            fileTreeVisible: s.fileTreeVisible,
            tabsByCwd,
          } satisfies PersistedGlobalEditorState),
        )
      } catch {
        // Quota exceeded — drop silently; persistence is best-effort and
        // the live session is unaffected.
      }
    }, WRITE_DEBOUNCE_MS)
  })
  return () => {
    unsub()
    if (timer !== null) window.clearTimeout(timer)
  }
}
