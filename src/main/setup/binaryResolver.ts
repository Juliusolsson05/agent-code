import { access, stat } from 'fs/promises'
import { constants as fsConstants } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

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

// WHY a classifier and not a plain boolean: on POSIX, X_OK against a
// DIRECTORY means "searchable", so `access('/usr/local/bin', X_OK)`
// succeeds. The old boolean-only check therefore accepted directories
// as "executables" — a user could paste `/usr/local/bin` into the
// manual override, the SetupGate would happily unlock, and the failure
// (spawn EACCES/EISDIR) surfaced minutes later when a provider tried
// to exec the directory, with no hint that setup was the culprit.
// The classifier lets callers that talk to humans (setup:set-tool-path)
// say *which* way the path is wrong, while machine callers collapse it
// through isExecutable() below.
//
// stat() (not lstat) on purpose: it follows symlinks, and a symlink to
// a real binary (brew's `/opt/homebrew/bin/*`, volta/asdf shims) must
// classify by its target — rejecting symlinks would break the most
// common install layouts on macOS.
export type ExecutableVerdict =
  | 'ok'
  | 'missing' // nothing stat-able at the path (or unreadable parent)
  | 'directory' // exists but is a directory — the /usr/local/bin trap
  | 'not-a-file' // socket/FIFO/device — spawnable by nothing we do
  | 'not-executable' // regular file without +x for this user

export async function classifyExecutable(path: string): Promise<ExecutableVerdict> {
  let info
  try {
    info = await stat(path)
  } catch {
    return 'missing'
  }
  if (info.isDirectory()) return 'directory'
  if (!info.isFile()) return 'not-a-file'
  try {
    await access(path, fsConstants.X_OK)
  } catch {
    return 'not-executable'
  }
  return 'ok'
}

export async function isExecutable(path: string): Promise<boolean> {
  return (await classifyExecutable(path)) === 'ok'
}

// Layer 2 of resolution (#495 A1): a direct executable scan that cannot be
// poisoned by the user's shell. Covers (a) non-POSIX $SHELL where the
// login-shell probe ran through a substitute shell that never sources the
// user's real rc files, and (b) tools whose dir is added by a non-login rc
// block the `-l` probe never sources.
//
// WHY these extra dirs: they are the standard install targets of the tools
// we resolve (npm-global/volta/asdf/bun shims for the provider CLIs, brew
// for git+mitmdump) and each costs one stat. process.env.PATH comes first —
// when the app is launched from a terminal it is the user's real PATH; from
// Finder it is launchd's minimal one, which is exactly when the well-known
// dirs earn their keep.
const WELL_KNOWN_BIN_DIRS = [
  join(homedir(), '.local', 'bin'),
  join(homedir(), '.volta', 'bin'),
  join(homedir(), '.asdf', 'shims'),
  join(homedir(), '.bun', 'bin'),
  join(homedir(), '.cargo', 'bin'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
]

async function scanForTool(command: string): Promise<string | null> {
  const pathDirs = (process.env.PATH ?? '').split(':').filter(Boolean)
  const seen = new Set<string>()
  for (const dir of [...pathDirs, ...WELL_KNOWN_BIN_DIRS]) {
    if (seen.has(dir)) continue
    seen.add(dir)
    const candidate = join(dir, command)
    if (await isExecutable(candidate)) return candidate
  }
  return null
}

export async function resolveToolPath(tool: SetupToolId): Promise<string | null> {
  const command = TOOL_COMMAND[tool]
  // Layer 1: the login-shell probe. It stays first because its answer
  // reflects the user's curated environment — a version manager's shim
  // dir early in the login PATH must beat a stale system copy that the
  // raw scan below would otherwise surface.
  try {
    const result = await runLoginShell(`command -v ${command}`, {
      timeoutMs: 10_000,
      maxBuffer: 64 * 1024,
    })
    const path = result.stdout.trim().split('\n')[0]?.trim()
    if (path && await isExecutable(path)) return path
  } catch {
    // Probe failure is NOT evidence of absence (#495 A1) — a broken rc
    // file, a slow shell init past the timeout, or an exotic $SHELL all
    // land here. Fall through to the direct scan.
  }
  return scanForTool(command)
}

