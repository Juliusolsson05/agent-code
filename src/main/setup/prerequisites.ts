import type {
  SetupCheckResult,
  SetupToolId,
  SetupToolStatus,
} from '@shared/types/setup.js'
import { resolveToolPath } from '@main/setup/binaryResolver.js'
import {
  isBundledArchiveAvailable,
  type BundledToolId,
} from '@main/setup/runtimeTools.js'
import { loadSetupState, updateToolPaths } from '@main/setup/setupState.js'
import { refreshToolchainFromState } from '@main/setup/toolchain.js'

// WHY this map exists: not every SetupToolId has a bundled artifact,
// and the `tool === 'X'` shape doesn't compose well when more tools
// land. Whitelisting the IDs that participate in the runtime-bundling
// pipeline makes the relationship explicit and keeps `prerequisites`
// from importing the resolver for irrelevant tools.
const BUNDLED_TOOL_IDS: ReadonlySet<SetupToolId> = new Set<BundledToolId>([
  'mitmdump',
])

const TOOL_META: Record<SetupToolId, Omit<SetupToolStatus, 'found' | 'path'>> = {
  // WHY brew is NOT required:
  //   Packaged Agent Code ships its own mitmdump (see issue #119)
  //   and will ship its own tmux (see #120), so a packaged user
  //   without Homebrew should still be able to start the app. The
  //   only thing Homebrew unlocks today is the "install missing
  //   optional tool from the SetupGate" button — useful in dev,
  //   not a launch blocker. Hard-blocking on brew would force a
  //   third-party package manager onto every user just so the
  //   setup screen could clear.
  brew: {
    id: 'brew',
    label: 'Homebrew',
    required: false,
    installable: false,
    detail: 'Used in dev to install optional tools. Not required to launch.',
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
      const systemPath = tool === 'brew' ? brewPath : await resolveToolPath(tool)
      // WHY bundled detection takes precedence over PATH:
      //   When we ship a tool, that is the version we tested with and
      //   the version proxy diagnostics + behaviour assume. A user's
      //   stale Homebrew install of an older mitmproxy could pass
      //   PATH detection but break our proxy startup contract. Show
      //   the bundled status so the user knows what's actually being
      //   spawned at runtime.
      const bundled =
        BUNDLED_TOOL_IDS.has(tool) && (await isBundledArchiveAvailable(tool as BundledToolId))
      const found = bundled || Boolean(systemPath)
      const status: SetupToolStatus = {
        ...TOOL_META[tool],
        found,
        path: systemPath,
        source: bundled ? 'bundled' : systemPath ? 'system' : undefined,
        // A bundled tool is never installable from setup: it's
        // already shipped. Suppress the "Install via Homebrew" button.
        installable:
          !bundled && TOOL_META[tool].installable && Boolean(brewPath),
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
