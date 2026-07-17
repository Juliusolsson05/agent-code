import { useGlobalEditorStore } from '@renderer/features/global-editor/store'

// Global Editor persistence: geometry + open-tab PATHS per cwd (#513).
//
// WHY localStorage and not a main-process persistence channel: the
// store's original header documented the risk ("every persistence path
// is a potential leak") specifically about UNSAVED FILE CONTENTS. This
// module never touches contents — it stores absolute workspace roots,
// relative file names, and three numbers. Those paths are still private
// project metadata, so the bounded retention below matters even though source
// text is deliberately excluded. localStorage keeps it renderer-local,
// synchronous at boot (no
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
  version: 2
  splitterRatio: number
  fileTreeWidthPx: number
  fileTreeVisible: boolean
  tabsByCwd: Record<string, { fileOrder: string[]; activeFilePath: string | null }>
  /** Oldest → newest. Object insertion order is not usage order once a cwd
   * survives across process launches, so it cannot implement the promised cap. */
  cwdRecency: string[]
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
// Restoring every remembered tab necessarily reads and retains its source text.
// The editor's per-file limit is 8 MiB, so 100 tabs admitted an ~800 MiB cold
// start. Twenty-four still preserves a generous working set while putting a
// defensible ceiling on automatic recovery; additional live tabs remain open
// for the current session and simply are not promised across restart.
const MAX_TABS_PER_CWD = 24
const MAX_PATH_LENGTH = 4_096

function validRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PATH_LENGTH) {
    return false
  }
  if (value.startsWith('/') || value.startsWith('\\')) return false
  const parts = value.replace(/\\/g, '/').split('/')
  return !parts.some(part => part === '..' || part === '')
}

function sanitizedTabsByCwd(value: unknown): PersistedGlobalEditorState['tabsByCwd'] | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const out: PersistedGlobalEditorState['tabsByCwd'] = {}
  for (const [cwd, raw] of Object.entries(value)) {
    if (!cwd || cwd.length > MAX_PATH_LENGTH || typeof raw !== 'object' || raw === null) {
      continue
    }
    const record = raw as { fileOrder?: unknown; activeFilePath?: unknown }
    if (!Array.isArray(record.fileOrder)) continue
    const fileOrder = [...new Set(record.fileOrder.filter(validRelativePath))].slice(
      0,
      MAX_TABS_PER_CWD,
    )
    if (fileOrder.length === 0) continue
    const activeFilePath =
      validRelativePath(record.activeFilePath) && fileOrder.includes(record.activeFilePath)
        ? record.activeFilePath
        : (fileOrder[fileOrder.length - 1] ?? null)
    out[cwd] = { fileOrder, activeFilePath }
  }
  return out
}

export function mergePersistedCwdRecency(
  knownCwds: readonly string[],
  persistedRecency: readonly string[],
): string[] {
  const known = new Set(knownCwds)
  return [
    ...new Set([
      ...persistedRecency.filter(cwd => known.has(cwd)),
      ...knownCwds,
    ]),
  ]
}

export function loadPersistedGlobalEditorState(): PersistedGlobalEditorState | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    // Omit the v2 literal before adding the migration union. Intersecting
    // `{version?: 2}` with `{version?: 1 | 2}` silently narrows back to 2 and
    // makes the v1 migration branch unreachable to TypeScript even though
    // localStorage can absolutely still contain that legacy payload.
    const parsed = JSON.parse(raw) as Partial<Omit<PersistedGlobalEditorState, 'version'>> & {
      version?: 1 | 2
    }
    if (parsed?.version !== 1 && parsed?.version !== 2) return null
    const tabsByCwd = sanitizedTabsByCwd(parsed.tabsByCwd)
    if (!tabsByCwd) return null
    const known = new Set(Object.keys(tabsByCwd))
    const persistedRecency =
      parsed.version === 2 && Array.isArray(parsed.cwdRecency)
        ? parsed.cwdRecency.filter(
            (cwd): cwd is string => typeof cwd === 'string' && known.has(cwd),
          )
        : []
    // Saved recency is authoritative. Prepending object keys made every known
    // cwd appear before its saved position in Set order, silently reducing the
    // persisted LRU to JSON insertion order.
    const cwdRecency = mergePersistedCwdRecency(Object.keys(tabsByCwd), persistedRecency)
    return {
      version: 2,
      splitterRatio:
        typeof parsed.splitterRatio === 'number' && Number.isFinite(parsed.splitterRatio)
          ? parsed.splitterRatio
          : 0.5,
      fileTreeWidthPx:
        typeof parsed.fileTreeWidthPx === 'number' && Number.isFinite(parsed.fileTreeWidthPx)
          ? parsed.fileTreeWidthPx
          : 260,
      fileTreeVisible: typeof parsed.fileTreeVisible === 'boolean' ? parsed.fileTreeVisible : true,
      tabsByCwd,
      cwdRecency,
    }
  } catch {
    // Corrupt JSON / disabled storage — start fresh rather than crash the
    // store module at import time.
    return null
  }
}

type PersistableStoreState = Pick<
  ReturnType<typeof useGlobalEditorStore.getState>,
  | 'byCwd'
  | 'cwdRecency'
  | 'activeCwd'
  | 'splitterRatio'
  | 'fileTreeWidthPx'
  | 'fileTreeVisible'
>

/** Merge live state into the previous snapshot instead of rebuilding from the
 * lazily hydrated store. Projects never visited during this process must keep
 * their remembered tabs; a live empty cwd is an intentional tombstone. */
export function buildPersistedGlobalEditorState(
  state: PersistableStoreState,
  previous: PersistedGlobalEditorState | null,
): PersistedGlobalEditorState {
  const tabsByCwd = { ...(previous?.tabsByCwd ?? {}) }
  for (const [cwd, cwdState] of Object.entries(state.byCwd)) {
    if (cwdState.fileOrder.length === 0) {
      delete tabsByCwd[cwd]
      continue
    }
    const fileOrder = [...new Set(cwdState.fileOrder.filter(validRelativePath))].slice(
      0,
      MAX_TABS_PER_CWD,
    )
    if (fileOrder.length === 0) {
      delete tabsByCwd[cwd]
      continue
    }
    tabsByCwd[cwd] = {
      fileOrder,
      activeFilePath:
        cwdState.activeFilePath && fileOrder.includes(cwdState.activeFilePath)
          ? cwdState.activeFilePath
          : (fileOrder[fileOrder.length - 1] ?? null),
    }
  }

  const known = new Set(Object.keys(tabsByCwd))
  const prior = state.cwdRecency.filter(cwd => known.has(cwd))
  const discovered = Object.keys(tabsByCwd).filter(cwd => !prior.includes(cwd))
  const active = state.activeCwd && known.has(state.activeCwd) ? state.activeCwd : null
  const cwdRecency = [...prior, ...discovered].filter(cwd => cwd !== active)
  if (active) cwdRecency.push(active)
  const retained = cwdRecency.slice(-MAX_CWDS)
  const retainedSet = new Set(retained)
  for (const cwd of Object.keys(tabsByCwd)) {
    if (!retainedSet.has(cwd)) delete tabsByCwd[cwd]
  }

  return {
    version: 2,
    splitterRatio: state.splitterRatio,
    fileTreeWidthPx: state.fileTreeWidthPx,
    fileTreeVisible: state.fileTreeVisible,
    tabsByCwd,
    cwdRecency: retained,
  }
}

/** Subscribe the persistence writer. Returns a stop function; call once
 *  from the shell (an app has exactly one Global Editor). */
export function startGlobalEditorPersistence(): () => void {
  let timer: number | null = null
  let pending = false
  let previous = loadPersistedGlobalEditorState()
  const flush = () => {
    if (timer !== null) {
      window.clearTimeout(timer)
      timer = null
    }
    if (!pending) return
    pending = false
    const next = buildPersistedGlobalEditorState(useGlobalEditorStore.getState(), previous)
    try {
      localStorage.setItem(KEY, JSON.stringify(next))
      previous = next
    } catch {
      // Quota exceeded — drop silently; persistence is best-effort and the
      // live session is unaffected. Do not retry on every teardown tick.
    }
  }
  const schedule = () => {
    pending = true
    if (timer !== null) return
    timer = window.setTimeout(flush, WRITE_DEBOUNCE_MS)
  }
  const unsub = useGlobalEditorStore.subscribe(schedule)
  // Settings/Reader/Spotlight unmount this shell, while app quit tears down the
  // whole document. Both paths must commit the trailing debounce or a just-
  // closed tab can be resurrected on restart.
  window.addEventListener('beforeunload', flush)
  window.addEventListener('pagehide', flush)
  return () => {
    unsub()
    window.removeEventListener('beforeunload', flush)
    window.removeEventListener('pagehide', flush)
    flush()
  }
}
