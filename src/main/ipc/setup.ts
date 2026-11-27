import { homedir } from 'node:os'
import { join } from 'node:path'

import { ipcMain } from 'electron'

import type {
  SetupInstallTarget,
  SetupSetToolPathResult,
  SetupToolId,
} from '@shared/types/setup.js'
import { classifyExecutable } from '@main/setup/binaryResolver.js'
import { installWithHomebrew } from '@main/setup/homebrewInstaller.js'
import { checkPrerequisites } from '@main/setup/prerequisites.js'
import { syncDetectedProvidersFromCheck } from '@main/setup/providerEnablement.js'
import { markNoProvidersAcknowledged, markOptionalSkipped, setManualToolPath } from '@main/setup/setupState.js'
import { refreshToolchainFromState } from '@main/setup/toolchain.js'

export function registerSetupIpc(): void {
  ipcMain.handle('setup:check', async () => {
    const check = await checkPrerequisites()
    // Sync newly discovered CLIs into providerEnablement so PathPickerModal
    // (⌘T) reflects installs immediately without an app restart (#1553).
    // Best-effort: a secondary enablement sync failure must never fail setup.
    await syncDetectedProvidersFromCheck(check).catch(err => {
      console.warn('[setup] failed to sync provider enablement after check:', err)
    })
    return check
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
        check: await checkPrerequisites({ force: true }),
      }
    }
    return await installWithHomebrew(target)
  })

  ipcMain.handle('setup:skip-optional', async (_evt, tool: SetupToolId) => {
    await markOptionalSkipped(tool, true)
    return await checkPrerequisites({ force: true })
  })

  // The first-run answer "continue without a provider" (#995). Durable for the
  // same reason a skipped helper is: otherwise the panel reopens on every
  // launch, and in every new window, for a user who has already answered it.
  ipcMain.handle('setup:acknowledge-no-providers', async () => {
    await markNoProvidersAcknowledged()
    return await checkPrerequisites({ force: true })
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
      const trimmed = rawPath.trim()
      // Expand leading `~` / `~/` to homedir() before absolute-path validation
      // (#1553): users routinely paste `~/.local/bin/claude` or `~/.opencode/bin/opencode`
      // from install docs, and rejecting tilde paths forces them to look up
      // their full home directory manually.
      const candidate = trimmed === '~'
        ? homedir()
        : trimmed.startsWith('~/')
          ? join(homedir(), trimmed.slice(2))
          : trimmed
      if (!candidate.startsWith('/')) {
        return { ok: false, reason: 'Enter an absolute path (starting with / or ~/).' }
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
      const check = await checkPrerequisites({ force: true })
      await syncDetectedProvidersFromCheck(check).catch(err => {
        console.warn('[setup] failed to sync provider enablement after set-tool-path:', err)
      })
      return { ok: true, check }
    },
  )
}
