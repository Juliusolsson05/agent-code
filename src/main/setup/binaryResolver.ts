import { access } from 'fs/promises'
import { constants as fsConstants } from 'fs'

import type { SetupToolId } from '@shared/types/setup.js'
import { runLoginShell } from '@main/setup/shell.js'
import { listProviderSetupDescriptors } from '@providers/registry.setup.js'

// Provider commands derive from the setup-descriptor registry
// (#394 phase 2c-3) — registry.setup.ts, NOT registry.main.ts, to
// avoid the binaryResolver → registry.main → claudeSession →
// toolchain → binaryResolver module cycle (see that file's header).
const TOOL_COMMAND: Record<SetupToolId, string> = {
  brew: 'brew',
  git: 'git',
  mitmdump: 'mitmdump',
  ...Object.fromEntries(
    listProviderSetupDescriptors().map(([kind, d]) => [kind, d.binaryName]),
  ),
} as Record<SetupToolId, string>

export async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

export async function resolveToolPath(tool: SetupToolId): Promise<string | null> {
  const command = TOOL_COMMAND[tool]
  try {
    const result = await runLoginShell(`command -v ${command}`, {
      timeoutMs: 10_000,
      maxBuffer: 64 * 1024,
    })
    const path = result.stdout.trim().split('\n')[0]?.trim()
    return path && await isExecutable(path) ? path : null
  } catch {
    return null
  }
}

