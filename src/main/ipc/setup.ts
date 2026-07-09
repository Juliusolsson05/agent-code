import { ipcMain } from 'electron'

import type {
  SetupInstallTarget,
  SetupSetToolPathResult,
  SetupToolId,
} from '@shared/types/setup.js'
import { classifyExecutable } from '@main/setup/binaryResolver.js'
import { installWithHomebrew } from '@main/setup/homebrewInstaller.js'
import { checkPrerequisites } from '@main/setup/prerequisites.js'
import { markOptionalSkipped, setManualToolPath } from '@main/setup/setupState.js'
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
  // executable *regular file*, persist it via setManualToolPath() — which
  // records durable user intent in manualToolPaths AND updates the same
  // toolPaths cache the automatic probe writes, so PATH augmentation
  // treats it identically to a probed path — then re-run the check so the
  // gate can unlock in one round-trip.
  //
  // A valid override outranks every automatic layer from here on:
  // checkPrerequisites and revalidateToolchain both consult
  // manualToolPaths before probing (precedence comment in
  // prerequisites.ts), so neither the recheck below nor the next app
  // launch can silently replace or delete what the user chose.
  ipcMain.handle(
    'setup:set-tool-path',
    async (_evt, tool: SetupToolId, rawPath: string): Promise<SetupSetToolPathResult> => {
      const candidate = rawPath.trim()
      if (!candidate.startsWith('/')) {
        return { ok: false, reason: 'Enter an absolute path (starting with /).' }
      }
      // classifyExecutable, not a bare X_OK check: POSIX access(dir, X_OK)
      // succeeds for any searchable directory, so `/usr/local/bin` used to
      // validate here and the provider later tried to spawn a directory.
      // The verdict lets us tell the user *how* the path is wrong — the
      // directory case gets its own message because it is the natural typo
      // (pasting the containing dir instead of the binary).
      switch (await classifyExecutable(candidate)) {
        case 'ok':
          break
        case 'directory':
          return {
            ok: false,
            reason: `That path is a directory — enter the path to the binary itself (e.g. ${candidate.replace(/\/+$/, '')}/${tool}).`,
          }
        case 'missing':
          return { ok: false, reason: 'No file exists at that path.' }
        default:
          return { ok: false, reason: 'Not an executable file at that path.' }
      }
      await setManualToolPath(tool, candidate)
      await refreshToolchainFromState()
      return { ok: true, check: await checkPrerequisites() }
    },
  )
}
