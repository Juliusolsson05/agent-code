import type {
  SetupCheckResult,
  SetupToolId,
  SetupToolStatus,
} from '@shared/types/setup.js'
import { resolveToolPath } from '@main/setup/binaryResolver.js'
import { loadSetupState, updateToolPaths } from '@main/setup/setupState.js'
import { refreshToolchainFromState } from '@main/setup/toolchain.js'

const TOOL_META: Record<SetupToolId, Omit<SetupToolStatus, 'found' | 'path'>> = {
  brew: {
    id: 'brew',
    label: 'Homebrew',
    required: true,
    installable: false,
    detail: 'Required so Code can install helper tools.',
  },
  claude: {
    id: 'claude',
    label: 'Claude Code',
    required: true,
    installable: false,
    detail: 'Install and sign in to Claude Code before using Claude panes.',
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    required: true,
    installable: false,
    detail: 'Install and sign in to Codex before using Codex panes.',
  },
  git: {
    id: 'git',
    label: 'Git',
    required: false,
    installable: false,
    detail: 'Used by Git Bar, worktree badges, and repository metadata.',
  },
  tmux: {
    id: 'tmux',
    label: 'tmux',
    required: false,
    installable: true,
    detail: 'Keeps terminal panes alive across app restarts.',
  },
  mitmdump: {
    id: 'mitmdump',
    label: 'Claude Proxy Helper',
    required: false,
    installable: true,
    detail: 'Installed by Homebrew package mitmproxy; enables Claude proxy streaming.',
  },
}

const CHECK_ORDER: SetupToolId[] = ['brew', 'claude', 'codex', 'git', 'tmux', 'mitmdump']

export async function checkPrerequisites(): Promise<SetupCheckResult> {
  const state = await loadSetupState()
  const brewPath = await resolveToolPath('brew')
  const entries = await Promise.all(
    CHECK_ORDER.map(async tool => {
      const path = tool === 'brew' ? brewPath : await resolveToolPath(tool)
      const status: SetupToolStatus = {
        ...TOOL_META[tool],
        found: Boolean(path),
        path,
        installable: TOOL_META[tool].installable && Boolean(brewPath),
        skipped: state.skippedOptionalTools[tool] === true,
      }
      return [tool, status] as const
    }),
  )

  const tools = Object.fromEntries(entries) as Record<SetupToolId, SetupToolStatus>
  await updateToolPaths(
    Object.fromEntries(
      entries.map(([tool, status]) => [tool, status.path]),
    ) as Partial<Record<SetupToolId, string | null>>,
  )
  await refreshToolchainFromState()

  const blocking = CHECK_ORDER.filter(tool => tools[tool].required && !tools[tool].found)
  return {
    checkedAt: Date.now(),
    ready: blocking.length === 0,
    blocking,
    tools,
  }
}
