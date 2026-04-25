import type { SetupToolId } from '@shared/types/setup.js'
import { loadSetupState } from '@main/setup/setupState.js'
import { dirname } from 'path'

type ToolchainPaths = Partial<Record<SetupToolId, string>>

let cachedPaths: ToolchainPaths = {}

export async function initializeToolchain(): Promise<void> {
  await refreshToolchainFromState()
}

export async function refreshToolchainFromState(): Promise<void> {
  const state = await loadSetupState()
  cachedPaths = { ...state.toolPaths }
  applyToolEnv()
}

function applyToolEnv(): void {
  const pathParts = [
    ...Object.values(cachedPaths)
      .filter((path): path is string => typeof path === 'string' && path.length > 0)
      .map(path => dirname(path)),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    ...(process.env.PATH ?? '').split(':'),
  ]
  const seen = new Set<string>()
  process.env.PATH = pathParts
    .filter(part => {
      if (!part || seen.has(part)) return false
      seen.add(part)
      return true
    })
    .join(':')

  if (cachedPaths.mitmdump) {
    process.env.CC_PROXY_TEST_MITMDUMP = cachedPaths.mitmdump
  } else {
    delete process.env.CC_PROXY_TEST_MITMDUMP
  }
}

export function getToolPath(tool: SetupToolId, fallback: string): string {
  return cachedPaths[tool] ?? fallback
}
