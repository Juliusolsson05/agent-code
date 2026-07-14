#!/usr/bin/env node

// Packaged-app structural verification.
//
// WHY this is a script instead of a growing CI shell block: the same artifact
// contract must be checkable by a contributor before Apple credentials enter
// the picture. Signing cannot rescue a package that omitted the phone client,
// a native PTY, or a runtime helper, and all three failures are invisible in
// `npm run dev`. This check intentionally understands the final .app layout and
// fails before an incomplete bundle can be uploaded or notarized.

import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { listPackage } from '@electron/asar'

const releaseDir = resolve(process.cwd(), 'release')
const expected = [
  { dir: 'mac-arm64', arch: 'arm64' },
  { dir: 'mac', arch: 'x86_64' },
]

for (const target of expected) {
  const app = join(releaseDir, target.dir, 'Agent Code.app')
  const resources = join(app, 'Contents', 'Resources')
  const unpacked = join(resources, 'app.asar.unpacked')

  const asarPath = join(resources, 'app.asar')
  await mustExist(asarPath)
  const asarEntries = listPackage(asarPath).map(entry => entry.replace(/^[/\\]/, ''))
  if (!asarEntries.includes('out/remote-client/index.html')) {
    throw new Error(`${target.dir}: phone client missing from app.asar`)
  }
  await mustExecute(join(unpacked, 'out', 'main', 'runtime', 'hotkey-helper', 'AgentCodeDictationHotkeyHelper'))
  await mustExist(join(unpacked, 'out', 'main', 'runtime', 'mitmproxy', 'manifest.json'))
  await mustExecute(join(unpacked, 'out', 'main', 'runtime', 'tmux', `darwin-${target.arch}`, 'tmux'))
  await mustExecute(join(unpacked, 'out', 'main', 'runtime', 'cloudflared', `darwin-${target.arch}`, 'cloudflared'))
  const otherRuntimeArch = target.arch === 'arm64' ? 'darwin-x86_64' : 'darwin-arm64'
  for (const tool of ['mitmproxy', 'tmux', 'cloudflared']) {
    await mustNotExist(join(unpacked, 'out', 'main', 'runtime', tool, otherRuntimeArch))
  }
  await mustExist(join(resources, 'licenses', 'Agent-Code-LICENSE.txt'))
  await mustExist(join(resources, 'PRIVACY.md'))

  // Verify the exact path node-pty resolves at runtime. Auditing every `.node`
  // under node_modules is actively misleading: npm packages may carry optional
  // prebuilds for other operating systems that Node will never load.
  const ptyModule = join(unpacked, 'node_modules', 'node-pty', 'build', 'Release', 'pty.node')
  const ptySpawnHelper = join(
    unpacked,
    'node_modules',
    'node-pty',
    'build',
    'Release',
    'spawn-helper',
  )
  await mustExist(ptyModule)
  // Loading pty.node is not enough. The addon delegates the actual child
  // launch to this sibling executable; a lost +x bit produces only
  // `posix_spawnp failed` at runtime and breaks every provider simultaneously.
  await mustExecute(ptySpawnHelper)
  await mustNotExist(join(unpacked, 'node_modules', 'node-pty', 'prebuilds'))
  const ptyDescription = await commandOutput('/usr/bin/file', [ptyModule])
  if (!ptyDescription.includes(target.arch)) {
    throw new Error(`${target.dir}: node-pty has wrong architecture: ${ptyDescription.trim()}`)
  }

  process.stdout.write(`[verify-packaged-mac] OK ${target.dir} (${target.arch})\n`)
}

async function mustExist(path) {
  await access(path, constants.R_OK).catch(() => {
    throw new Error(`required packaged resource missing: ${path}`)
  })
}

async function mustExecute(path) {
  await access(path, constants.R_OK | constants.X_OK).catch(() => {
    throw new Error(`required packaged executable missing or not executable: ${path}`)
  })
}

async function mustNotExist(path) {
  try {
    await access(path)
  } catch {
    return
  }
  throw new Error(`excluded packaged resource is still present: ${path}`)
}

function commandOutput(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.once('error', reject)
    child.once('exit', code => {
      if (code === 0) resolvePromise(stdout)
      else reject(new Error(`${command} exited ${code}: ${stderr.trim()}`))
    })
  })
}
