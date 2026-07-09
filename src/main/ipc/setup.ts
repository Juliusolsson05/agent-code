import { ipcMain } from 'electron'

import type {
  SetupInstallTarget,
  SetupSetToolPathResult,
  SetupToolId,
} from '@shared/types/setup.js'
import { isExecutable } from '@main/setup/binaryResolver.js'
import { installWithHomebrew } from '@main/setup/homebrewInstaller.js'
import { checkPrerequisites } from '@main/setup/prerequisites.js'
import { markOptionalSkipped, updateToolPaths } from '@main/setup/setupState.js'
import { refreshToolchainFromState } from '@main/setup/toolchain.js'

export function registerSetupIpc(): void {
  ipcMain.handle('setup:check', async () => {
    return await checkPrerequisites()
  })

  ipcMain.handle('setup:install', async (_evt, target: SetupInstallTarget) => {
    // tmux was dropped from the install pathway when bundled tmux
    // (#120) became the only supported source. The remaining target
    // is mitmproxy, which follows the same cleanup track and will
    // disappear shortly. Keep this validation in step with
    // SetupInstallTarget so renderer-side type checks remain useful.
    if (target !== 'mitmproxy') {
      return {
        ok: false,
        target,
        output: `Unknown setup install target: ${String(target)}`,
        check: await checkPrerequisites(),
      }
    }
    return await installWithHomebrew(target)
  })

  ipcMain.handle('setup:skip-optional', async (_evt, tool: SetupToolId) => {
    await markOptionalSkipped(tool, true)
    return await checkPrerequisites()
  })

  // Escape hatch for #495 A1: automatic resolution is a probe, and a
  // probe false-negative must never be the *sole* gate on the whole
  // product. The user pastes an absolute path; we accept it iff it is an
  // executable file, persist it through the same updateToolPaths() the
  // automatic probe uses (so revalidateToolchain and PATH augmentation
  // treat it identically to a probed path — no second bookkeeping story),
  // then re-run the check so the gate can unlock in one round-trip.
  //
  // checkPrerequisites re-probes every tool and writes back its own
  // updateToolPaths(); it keeps a persisted path whose file still execs
  // when the probe misses (see the fallback in prerequisites.ts), so the
  // manual override survives the recheck instead of being deleted by the
  // null-path write-back.
  ipcMain.handle(
    'setup:set-tool-path',
    async (_evt, tool: SetupToolId, rawPath: string): Promise<SetupSetToolPathResult> => {
      const candidate = rawPath.trim()
      if (!candidate.startsWith('/')) {
        return { ok: false, reason: 'Enter an absolute path (starting with /).' }
      }
      if (!(await isExecutable(candidate))) {
        return { ok: false, reason: 'Not an executable file at that path.' }
      }
      await updateToolPaths({ [tool]: candidate })
      await refreshToolchainFromState()
      return { ok: true, check: await checkPrerequisites() }
    },
  )
}
