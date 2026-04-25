import { access } from 'fs/promises'
import { constants as fsConstants } from 'fs'

import type { SetupToolId } from '@shared/types/setup.js'
import { runLoginShell } from '@main/setup/shell.js'

const TOOL_COMMAND: Record<SetupToolId, string> = {
  brew: 'brew',
  claude: 'claude',
  codex: 'codex',
  git: 'git',
  tmux: 'tmux',
  mitmdump: 'mitmdump',
}

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

