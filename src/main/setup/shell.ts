import { execFile } from 'child_process'
import { promisify } from 'util'
import { accessSync, constants as fsConstants } from 'fs'
import { basename } from 'path'

const execFileAsync = promisify(execFile)

// WHY a POSIX allowlist instead of just trusting $SHELL (#495 A1):
// runLoginShell exists to see the PATH a user's *login* environment builds
// (rc files add ~/.local/bin, `brew shellenv`, volta/asdf shims, …). That
// only works if the shell accepts the POSIX `-lc <script>` contract and
// gives `command -v` POSIX semantics. fish, nushell, xonsh, elvish and
// pwsh don't reliably do either — with one of those as $SHELL the probe
// used to fail, the caller treated "probe broke" as "tool missing", and
// SetupGate hard-locked the entire app on first launch with no Continue
// button and no override. So: use $SHELL only when its basename is a known
// POSIX shell; otherwise probe through the first of /bin/zsh → /bin/bash →
// /bin/sh that exists. A fish user's fish-only PATH additions are covered
// by the direct PATH/well-known-dir scan in binaryResolver (layer 2 of
// resolution), NOT by contorting this probe per-shell — teaching this file
// fish/nu dialects would couple us to every shell's flag grammar forever.
const POSIX_SHELLS = new Set(['bash', 'zsh', 'sh', 'dash', 'ksh'])

// Computed per call, not at module load: two stat syscalls are nothing
// next to the fork+exec that follows, and a module-level const would bake
// in whatever $SHELL looked like at first import for the process lifetime.
function pickProbeShell(): string {
  const userShell = process.env.SHELL
  if (userShell && POSIX_SHELLS.has(basename(userShell))) return userShell
  for (const candidate of ['/bin/zsh', '/bin/bash', '/bin/sh']) {
    try {
      accessSync(candidate, fsConstants.X_OK)
      return candidate
    } catch {
      // keep looking
    }
  }
  // Nothing probeable exists — return /bin/sh anyway so the spawn error
  // surfaces to the caller (which maps it to "not found" and falls through
  // to the direct PATH scan) instead of throwing from here synchronously.
  return '/bin/sh'
}

export type LoginShellResult = {
  stdout: string
  stderr: string
}

export async function runLoginShell(
  script: string,
  options: { timeoutMs?: number; maxBuffer?: number } = {},
): Promise<LoginShellResult> {
  const { stdout, stderr } = await execFileAsync(
    pickProbeShell(),
    ['-lc', script],
    {
      timeout: options.timeoutMs ?? 30_000,
      maxBuffer: options.maxBuffer ?? 1024 * 1024,
      env: process.env,
    },
  )
  return {
    stdout: String(stdout ?? ''),
    stderr: String(stderr ?? ''),
  }
}
