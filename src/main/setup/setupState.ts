import { mkdir, readFile, rename, rm, writeFile } from 'fs/promises'
import { join } from 'path'

import { STATE_DIR } from '@main/storage/paths.js'
import type { SetupToolId } from '@shared/types/setup.js'

const SETUP_STATE_FILE = join(STATE_DIR, 'setup.json')

export type PersistedSetupState = {
  version: 1
  toolPaths: Partial<Record<SetupToolId, string>>
  // WHY a second map instead of a flag on toolPaths entries: toolPaths is
  // the *effective* resolution cache — checkPrerequisites and
  // revalidateToolchain overwrite it freely with whatever the probes find,
  // and that churn is correct for auto-resolved paths (a new volta shim
  // SHOULD replace a stale /usr/local copy). A manual override from
  // setup:set-tool-path is different in kind: it is the user's explicit
  // word, and codex review of #504 caught that storing it only in the
  // shared map let the very next auto-probe silently erase it (user's
  // ~/bin/claude-wrapper replaced by PATH's /usr/local/bin/claude).
  // Keeping user intent in its own map means the auto writers can stay
  // dumb — they never have to know which toolPaths entries are sacred —
  // while the two auto-resolution entry points (checkPrerequisites,
  // revalidateToolchain) consult this map first and skip the auto layers
  // for a still-valid override. Absent from setup.json files written
  // before this field existed; loadSetupState defaults it to {} so no
  // version bump / migration is needed.
  manualToolPaths: Partial<Record<SetupToolId, string>>
  skippedOptionalTools: Partial<Record<SetupToolId, boolean>>
  updatedAt: number
}

const DEFAULT_SETUP_STATE: PersistedSetupState = {
  version: 1,
  toolPaths: {},
  manualToolPaths: {},
  skippedOptionalTools: {},
  updatedAt: 0,
}

let cache: PersistedSetupState | null = null
let writeQueue: Promise<void> = Promise.resolve()

export async function loadSetupState(): Promise<PersistedSetupState> {
  if (cache) return cache
  try {
    const raw = await readFile(SETUP_STATE_FILE, 'utf8')
    const parsed = JSON.parse(raw) as Partial<PersistedSetupState>
    cache = {
      version: 1,
      toolPaths: parsed.toolPaths ?? {},
      manualToolPaths: parsed.manualToolPaths ?? {},
      skippedOptionalTools: parsed.skippedOptionalTools ?? {},
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
    }
  } catch {
    cache = DEFAULT_SETUP_STATE
  }
  return cache
}

export async function saveSetupState(
  next: PersistedSetupState,
): Promise<PersistedSetupState> {
  cache = { ...next, version: 1, updatedAt: Date.now() }
  const snapshot = cache
  writeQueue = writeQueue
    .catch(() => {})
    .then(async () => {
      await mkdir(STATE_DIR, { recursive: true })
      // WHY setup state uses the same temp+rename discipline as workspace
      // state even though the single-process lock should prevent concurrent
      // app mains:
      //
      // Setup paths are user-visible configuration. A failed write should not
      // leave `setup.json` truncated and force the user through tool discovery
      // again. Temp+rename gives atomic visibility to readers; it is not a full
      // fsync durability protocol for power-loss recovery, which would be a
      // separate requirement.
      const tmp = `${SETUP_STATE_FILE}.${process.pid}.${Date.now()}.${Math.random()
        .toString(36)
        .slice(2)}.tmp`
      try {
        await writeFile(tmp, JSON.stringify(snapshot, null, 2), 'utf8')
        await rename(tmp, SETUP_STATE_FILE)
      } catch (err) {
        await rm(tmp, { force: true }).catch(() => undefined)
        throw err
      }
    })
  await writeQueue
  return cache
}

export async function updateToolPaths(
  paths: Partial<Record<SetupToolId, string | null>>,
): Promise<PersistedSetupState> {
  const state = await loadSetupState()
  const toolPaths = { ...state.toolPaths }
  for (const [tool, path] of Object.entries(paths) as Array<[SetupToolId, string | null]>) {
    if (path) toolPaths[tool] = path
    else delete toolPaths[tool]
  }
  return await saveSetupState({ ...state, toolPaths })
}

// Records a user-supplied override from setup:set-tool-path. Writes BOTH
// maps: manualToolPaths is the durable record of user intent (what makes
// the override win over future auto-probes — see the type comment above),
// and toolPaths is the effective cache that refreshToolchainFromState /
// applyToolEnv consume immediately, so the override takes effect in the
// same round-trip instead of waiting for the next checkPrerequisites
// write-back. Callers are expected to have validated the path (executable
// regular file) BEFORE calling — this module stays pure bookkeeping.
export async function setManualToolPath(
  tool: SetupToolId,
  path: string,
): Promise<PersistedSetupState> {
  const state = await loadSetupState()
  return await saveSetupState({
    ...state,
    manualToolPaths: { ...state.manualToolPaths, [tool]: path },
    toolPaths: { ...state.toolPaths, [tool]: path },
  })
}

export async function markOptionalSkipped(
  tool: SetupToolId,
  skipped: boolean,
): Promise<PersistedSetupState> {
  const state = await loadSetupState()
  return await saveSetupState({
    ...state,
    skippedOptionalTools: {
      ...state.skippedOptionalTools,
      [tool]: skipped,
    },
  })
}
