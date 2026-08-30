// The on-disk shape of `~/.config/agent-code/workspace.json`.
//
// WHY main now understands this file at all, after years of deliberately not:
//
// `workspace:save` used to take opaque bytes, and its comment said so — "the
// renderer is the source of truth for the tile tree. Main just reads / writes
// bytes." That refusal cannot survive multi-window, and the reason is physical
// rather than stylistic: window 1 cannot serialize window 2's slice, because it
// has never seen it. Something has to compose one file from N independent
// authors, and main is the only party that can see all of them.
//
// So the refusal narrows rather than disappears. Main learns exactly one new
// thing — which window an opaque blob belongs to — and `workspace` below stays
// `unknown`, stored and returned verbatim. Nothing in main interprets tabs,
// panes, ownership, or any other renderer concept. If you find yourself adding
// a field access into that blob, stop: the pruning/ownership logic in
// `sessionOwnership.ts` is the renderer's, and duplicating a second opinion
// about it in main is how the two get to disagree.
//
// WHY one file instead of `workspace.<windowId>.json` per window:
//
// Closing a window merges its slice into a survivor's, and quitting writes
// every window at once. With separate files each of those becomes an N-file
// transaction with no barrier, and every retired window id leaves an orphan
// file behind. One file keeps the existing atomic temp+rename (and the
// admission-ordered save queue that already reasons about read/write ordering)
// as the single commit point.

export type WindowBounds = {
  x: number
  y: number
  width: number
  height: number
}

export type PersistedWindow = {
  windowId: string
  /** Null until the window has been saved at least once. */
  bounds: WindowBounds | null
  /**
   * Electron display id the window was last on. Advisory: display ids are not
   * stable across reboots or cable swaps, so restore treats this as a hint and
   * always validates the bounds against the currently attached displays.
   */
  displayId: number | null
  fullScreen: boolean
  /** The renderer's `PersistedWorkspace`. Opaque here — see the header. */
  workspace: unknown
}

export type WorkspaceFile = {
  version: typeof WORKSPACE_FILE_VERSION
  windows: PersistedWindow[]
}

export const WORKSPACE_FILE_VERSION = 2

export type ParsedWorkspaceFile =
  | { kind: 'ok'; file: WorkspaceFile; migratedFromV1: boolean }
  /**
   * The file exists but this build cannot represent it — a NEWER version
   * written by a future build.
   *
   * WHY this is a distinct outcome rather than a throw or a silent reset: both
   * of the obvious behaviors destroy something. Throwing at startup makes the
   * app unlaunchable because of a file the user cannot easily repair; resetting
   * to an empty workspace silently discards every tab, agent, and pin they had.
   * Returning "unreadable" lets the caller run with a fresh in-memory workspace
   * while REFUSING to write, so downgrading to an older build and launching it
   * is a survivable mistake instead of a data-loss event.
   */
  | { kind: 'unreadable'; reason: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function coerceBounds(value: unknown): WindowBounds | null {
  if (!isRecord(value)) return null
  const { x, y, width, height } = value
  if (
    typeof x !== 'number' || !Number.isFinite(x) ||
    typeof y !== 'number' || !Number.isFinite(y) ||
    typeof width !== 'number' || !Number.isFinite(width) || width <= 0 ||
    typeof height !== 'number' || !Number.isFinite(height) || height <= 0
  ) return null
  return { x, y, width, height }
}

function coerceWindow(value: unknown, mintWindowId: () => string): PersistedWindow | null {
  if (!isRecord(value)) return null
  // A record with no usable workspace payload is not worth restoring: it would
  // produce an empty window the user never asked for on every launch.
  if (!isRecord(value.workspace)) return null
  const windowId = typeof value.windowId === 'string' && value.windowId.length > 0
    ? value.windowId
    : mintWindowId()
  return {
    windowId,
    bounds: coerceBounds(value.bounds),
    displayId: typeof value.displayId === 'number' && Number.isFinite(value.displayId)
      ? value.displayId
      : null,
    fullScreen: value.fullScreen === true,
    workspace: value.workspace,
  }
}

export function emptyWorkspaceFile(): WorkspaceFile {
  return { version: WORKSPACE_FILE_VERSION, windows: [] }
}

/**
 * Parse the file, migrating the single-window v1 shape (`{ workspace: … }`).
 *
 * `mintWindowId` is injected rather than imported so the migration is a pure
 * function under test: a fixture-driven migration assertion cannot be written
 * against `randomUUID()`.
 */
export function parseWorkspaceFile(
  text: string,
  mintWindowId: () => string,
): ParsedWorkspaceFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    // Unparseable is treated the same as newer-than-us for the same reason:
    // whatever is in there, overwriting it destroys the only copy. A truncated
    // file is far more likely to be recoverable by hand than to be worth
    // clobbering automatically.
    return {
      kind: 'unreadable',
      reason: `workspace.json is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    }
  }

  if (!isRecord(parsed)) {
    return { kind: 'unreadable', reason: 'workspace.json is not a JSON object' }
  }

  // v1: one workspace, no version marker, no window dimension.
  if (parsed.version === undefined && isRecord(parsed.workspace)) {
    return {
      kind: 'ok',
      migratedFromV1: true,
      file: {
        version: WORKSPACE_FILE_VERSION,
        windows: [{
          windowId: mintWindowId(),
          bounds: null,
          displayId: null,
          fullScreen: false,
          workspace: parsed.workspace,
        }],
      },
    }
  }

  if (parsed.version !== WORKSPACE_FILE_VERSION) {
    return {
      kind: 'unreadable',
      reason: `workspace.json is version ${String(parsed.version)}; this build understands ${WORKSPACE_FILE_VERSION}`,
    }
  }

  const rawWindows = Array.isArray(parsed.windows) ? parsed.windows : []
  const windows: PersistedWindow[] = []
  const seen = new Set<string>()
  for (const raw of rawWindows) {
    const window = coerceWindow(raw, mintWindowId)
    if (!window) continue
    // Duplicate ids would make `withWindowSlice` ambiguous and could let one
    // window's save land in another's slot. Hand-edited files are an explicit
    // threat model throughout this codebase; keep the first, drop the rest.
    if (seen.has(window.windowId)) continue
    seen.add(window.windowId)
    windows.push(window)
  }

  return { kind: 'ok', migratedFromV1: false, file: { version: WORKSPACE_FILE_VERSION, windows } }
}

export function serializeWorkspaceFile(file: WorkspaceFile): string {
  return JSON.stringify(file, null, 2)
}

/**
 * The bytes a renderer expects from `workspace:load`.
 *
 * Deliberately re-wrapped in `{ workspace }`: that is the envelope the renderer
 * has always written and always read, and keeping it means `rehydrate.ts` —
 * 874 lines of restore logic — never learns that windows exist.
 */
export function readWindowWorkspaceJson(
  file: WorkspaceFile,
  windowId: string,
): string | null {
  const record = file.windows.find(entry => entry.windowId === windowId)
  if (!record) return null
  return JSON.stringify({ workspace: record.workspace })
}

export function withWindowSlice(
  file: WorkspaceFile,
  windowId: string,
  workspace: unknown,
  geometry: { bounds: WindowBounds | null; displayId: number | null; fullScreen: boolean },
): WorkspaceFile {
  const existingIndex = file.windows.findIndex(entry => entry.windowId === windowId)
  const record: PersistedWindow = {
    windowId,
    bounds: geometry.bounds,
    displayId: geometry.displayId,
    fullScreen: geometry.fullScreen,
    workspace,
  }
  // Every OTHER window's slice is carried across by reference, untouched. This
  // is the whole point of the per-window format: window 1's save can never
  // rewrite — and therefore never prune — window 2's sessions.
  const windows = existingIndex === -1
    ? [...file.windows, record]
    : file.windows.map((entry, index) => (index === existingIndex ? record : entry))
  return { version: WORKSPACE_FILE_VERSION, windows }
}

export function withoutWindow(file: WorkspaceFile, windowId: string): WorkspaceFile {
  return {
    version: WORKSPACE_FILE_VERSION,
    windows: file.windows.filter(entry => entry.windowId !== windowId),
  }
}

/**
 * Every local session id any window has committed.
 *
 * WHY the union rather than one window's set: this feeds
 * `SessionManager.acknowledgePersistedSessionOwnership`, which answers the
 * process-wide question "which local ids has SOME renderer made durable". A
 * per-window answer would tell the manager that another window's live,
 * persisted sessions are unclaimed.
 */
export function collectSessionIds(file: WorkspaceFile): Set<string> {
  const ids = new Set<string>()
  for (const record of file.windows) {
    if (!isRecord(record.workspace)) continue
    const sessions = record.workspace.sessions
    if (!isRecord(sessions)) continue
    for (const id of Object.keys(sessions)) ids.add(id)
  }
  return ids
}
