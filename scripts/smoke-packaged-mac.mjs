#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import electron from 'electron'

if (process.versions.electron) {
  // Loading the build through a bootstrap lets an ESM linking error reach CI
  // immediately. Electron's default application loader can leave an error
  // dialog open forever before our main entry has installed its own handlers.
  try {
    electron.app.setAppPath(process.cwd())
    await import(pathToFileURL(resolve('out/main/index.js')).href)
  } catch (error) {
    console.error('[packaging-smoke] main entry failed to load', error)
    electron.app.exit(1)
  }
} else {
  // Before packaging use the installed Electron with the production bundle.
  // After packaging run the host-native thin app itself (the other slice is
  // verified structurally), retaining the strict isPackaged check in main.
  const builtMain = process.argv.includes('--built-main')
  const archDir = process.arch === 'arm64' ? 'mac-arm64' : 'mac'
  const executable = builtMain ? electron : resolve('release', archDir, 'Agent Code.app', 'Contents', 'MacOS', 'Agent Code')
  const args = builtMain ? [fileURLToPath(import.meta.url), '--packaging-smoke', '--built-main-smoke'] : ['--packaging-smoke']
  const profile = mkdtempSync(join(tmpdir(), 'agent-code-startup-smoke-'))
  try {
    const env = { ...process.env, HOME: profile, AGENT_CODE_PERF: '0' }
    delete env.ELECTRON_RUN_AS_NODE
    const result = spawnSync(executable, [`--user-data-dir=${profile}`, '--noerrdialogs', ...args], {
      env, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL',
    })
    process.stdout.write(result.stdout ?? '')
    process.stderr.write(result.stderr ?? '')
    if (result.error) throw result.error
    if (result.status !== 0 || !/^\[packaging-smoke\] OK /m.test(result.stdout)) {
      throw new Error(`Electron did not confirm startup (exit ${result.status}, signal ${result.signal})`)
    }
  } finally {
    rmSync(profile, { recursive: true, force: true })
  }
}
