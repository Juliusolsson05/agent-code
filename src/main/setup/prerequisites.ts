import type {
  SetupCheckResult,
  SetupToolId,
  SetupToolStatus,
} from '@shared/types/setup.js'
import { isExecutable, resolveToolPath } from '@main/setup/binaryResolver.js'
import { isBundledArchiveAvailable } from '@main/setup/runtimeTools.js'
import type { BundledToolId } from '@main/setup/runtimeTools.js'
import { loadSetupState, updateToolPaths } from '@main/setup/setupState.js'
import { listProviderSetupDescriptors } from '@providers/registry.setup.js'
import { AGENT_PROVIDER_KINDS } from '@shared/types/providerKind.js'
import { refreshToolchainFromState } from '@main/setup/toolchain.js'

// WHY this map exists: not every SetupToolId has a bundled artifact,
// and the `tool === 'X'` shape doesn't compose well when more tools
// land. Whitelisting the IDs that participate in the runtime-bundling
// pipeline makes the relationship explicit and keeps `prerequisites`
// from importing the resolver for irrelevant tools.
const BUNDLED_TOOL_IDS: ReadonlySet<SetupToolId> = new Set<SetupToolId>([
  'mitmdump',
])

// Provider SetupGate rows derived from the plain-data setup registry
// (cycle-safe — see registry.setup.ts's header for why it isn't
// registry.main.ts). `installable: false` for all providers today:
// the CLIs have their own install/sign-in stories the gate can't
// automate.
const PROVIDER_TOOL_META = Object.fromEntries(
  listProviderSetupDescriptors().map(([kind, d]) => [
    kind,
    {
      id: kind,
      label: d.label,
      required: d.required,
      installable: false,
      detail: d.detail,
    },
  ]),
) as Record<SetupToolId, Omit<SetupToolStatus, 'found' | 'path'>>

const TOOL_META: Record<SetupToolId, Omit<SetupToolStatus, 'found' | 'path'>> = {
  ...PROVIDER_TOOL_META,
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
  git: {
    id: 'git',
    label: 'Git',
    required: false,
    installable: false,
    detail: 'Used by Git Bar, worktree badges, and repository metadata.',
  },
  // NOTE: tmux is intentionally absent. The SetupGate is for tools
  // the user might need to install themselves; tmux is now a bundled
  // runtime artifact (see issue #120 and third_party/tmux/). It has
  // no install story for users to participate in. The runtime
  // resolver (`src/main/setup/runtimeTools.ts`) is the single
  // authority on tmux availability now.
  mitmdump: {
    id: 'mitmdump',
    label: 'Claude Proxy Helper',
    required: false,
    installable: true,
    detail: 'Installed by Homebrew package mitmproxy; enables Claude proxy streaming.',
  },
}

// Display/check order: brew first (it unlocks installs), then every
// registered provider in AGENT_PROVIDER_KINDS order, then the rest.
const CHECK_ORDER: SetupToolId[] = ['brew', ...AGENT_PROVIDER_KINDS, 'git', 'mitmdump']

export async function checkPrerequisites(): Promise<SetupCheckResult> {
  const state = await loadSetupState()
  const brewPath = await resolveToolPath('brew')
  const entries = await Promise.all(
    CHECK_ORDER.map(async tool => {
      // Resolution precedence (#495 A1 + codex review of #504), highest
      // first — each layer only runs when every layer above it failed:
      //
      //   0. Valid manual override (manualToolPaths + file still an
      //      executable regular file). The user's explicit word beats
      //      every probe: an earlier revision consulted the probes FIRST,
      //      so a user who deliberately pointed us at
      //      ~/bin/claude-wrapper had it silently replaced by PATH's
      //      /usr/local/bin/claude on the very next check, and the
      //      write-back below then erased the override from toolPaths.
      //      Override-first also makes the write-back safe by
      //      construction: when the override wins, the value written back
      //      IS the override. An override whose file vanished or lost +x
      //      falls through to auto layers (the gate must not stay
      //      "found" on a dead path) but stays recorded in
      //      manualToolPaths — intent is durable, and it resumes winning
      //      if the file comes back.
      //   1. Login-shell probe (`command -v` through a POSIX shell) —
      //      reflects the user's curated environment.
      //   2. Direct PATH/well-known-dir scan inside resolveToolPath —
      //      catches exotic-$SHELL / broken-rc false negatives.
      //   3. Persisted auto-path fallback: a previously-probed toolPaths
      //      entry whose file still execs, so a transient probe failure
      //      (slow rc file, shell hiccup) can't wipe a good cached path
      //      via the null → delete write-back. Re-checks the file, not
      //      the bookkeeping, so genuinely-removed tools still clear.
      const manual = state.manualToolPaths[tool]
      let systemPath =
        manual && (await isExecutable(manual)) ? manual : null
      if (!systemPath) {
        systemPath = tool === 'brew' ? brewPath : await resolveToolPath(tool)
      }
      if (!systemPath) {
        const persisted = state.toolPaths[tool]
        if (persisted && (await isExecutable(persisted))) systemPath = persisted
      }
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
