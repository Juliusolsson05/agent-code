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

// Cross-platform shell-command runner for the CLI update orchestrator.
//
// WHY this is not just `runLoginShell` for everyone:
//   `runLoginShell` is a POSIX-only concept — it spawns bash/zsh with
//   `-l` so rc files add brew/nvm/volta/asdf/bun/pnpm shims to PATH
//   that Electron's Finder-launched main process doesn't otherwise see.
//   That whole story does not apply to Windows: Windows sets PATH via
//   system environment variables that every process inherits, so no
//   login-shell equivalent is needed to reach `npm`, `winget`, etc.
//
//   `pickProbeShell()` falls back to `/bin/sh` on Windows, and there is
//   no `/bin/sh` on Windows — the spawn would ENOENT. Rather than
//   pretending POSIX everywhere, this helper branches: POSIX uses the
//   login shell, Windows dispatches through PowerShell (chosen over
//   cmd.exe because our Codex-native install command uses `irm | iex`
//   which is PowerShell-specific).
//
// The shell distinction matters for shell operator support too: the
// Claude Homebrew fallback command uses `cmd1 2>/dev/null || cmd2`,
// which is POSIX shell syntax. On Windows we never invoke the brew
// command path (brew doesn't exist there), so this is fine — the only
// Windows commands we dispatch are `winget ...`, `npm ...`, `claude
// update`, `codex update`, and the PowerShell Codex install line, all
// of which parse cleanly under PowerShell's own grammar.
export async function runShellCommand(
  script: string,
  options: { timeoutMs?: number; maxBuffer?: number } = {},
): Promise<LoginShellResult> {
  if (process.platform === 'win32') {
    const { stdout, stderr } = await execFileAsync(
      'powershell.exe',
      // `-NoProfile` skips $PROFILE — we don't need it (PATH is in the
      // process env) and it shortens startup. `-Command` takes the whole
      // script as one argument, unlike `-lc` under POSIX. `-ExecutionPolicy
      // Bypass` matches how Anthropic documents Windows installer invocations.
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
      {
        timeout: options.timeoutMs ?? 30_000,
        maxBuffer: options.maxBuffer ?? 1024 * 1024,
        env: process.env,
        // PowerShell is UTF-16 by default; force UTF-8 through Node.
        encoding: 'utf8',
      },
    )
    return { stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }
  }
  return await runLoginShell(script, options)
}
