import type {
  SetupInstallResult,
  SetupInstallTarget,
} from '@shared/types/setup.js'
import { runLoginShell } from '@main/setup/shell.js'
import { checkPrerequisites } from '@main/setup/prerequisites.js'

const INSTALL_COMMAND: Record<SetupInstallTarget, string> = {
  // tmux was removed when bundled tmux (#120) became the only source
  // Agent Code spawns from. mitmproxy is on the same track and will
  // be dropped in a follow-up cleanup PR.
  mitmproxy: 'brew list mitmproxy >/dev/null 2>&1 || brew install mitmproxy',
}

export async function installWithHomebrew(
  target: SetupInstallTarget,
): Promise<SetupInstallResult> {
  let output = ''
  let ok = false
  if (!(target in INSTALL_COMMAND)) {
    return {
      ok: false,
      target,
      output: `Unknown setup install target: ${String(target)}`,
      check: await checkPrerequisites(),
    }
  }
  try {
    const result = await runLoginShell(INSTALL_COMMAND[target], {
      timeoutMs: 15 * 60_000,
      maxBuffer: 8 * 1024 * 1024,
    })
    output = `${result.stdout}${result.stderr}`.trim()
    ok = true
  } catch (err) {
    const failed = err as Error & { stdout?: string | Buffer; stderr?: string | Buffer }
    const stdout = failed.stdout ? String(failed.stdout) : ''
    const stderr = failed.stderr ? String(failed.stderr) : ''
    output = `${stdout}${stderr}`.trim() || (err instanceof Error ? err.message : String(err))
  }
  return {
    ok,
    target,
    output,
    check: await checkPrerequisites(),
  }
}
