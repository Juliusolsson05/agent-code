import { mkdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'

import { STATE_DIR } from '@main/storage/paths.js'
import type { SetupToolId } from '@shared/types/setup.js'

const SETUP_STATE_FILE = join(STATE_DIR, 'setup.json')

export type PersistedSetupState = {
  version: 1
  toolPaths: Partial<Record<SetupToolId, string>>
  skippedOptionalTools: Partial<Record<SetupToolId, boolean>>
  updatedAt: number
}

const DEFAULT_SETUP_STATE: PersistedSetupState = {
  version: 1,
  toolPaths: {},
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
      await writeFile(SETUP_STATE_FILE, JSON.stringify(snapshot, null, 2), 'utf8')
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
