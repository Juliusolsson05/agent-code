#!/usr/bin/env node

// node-pty's native module launches every PTY through a sibling `spawn-helper`
// executable. Some npm/prebuild extraction paths preserve the Mach-O bytes but
// drop its executable mode, which is especially easy to hit when the host Node
// architecture differs from Electron's architecture: Electron rejects the
// host-built addon, falls back to `prebuilds/darwin-<electron arch>`, and then
// macOS rejects the non-executable helper with the nearly useless
// `posix_spawnp failed` error. That kills Claude, Codex, and terminal panes at
// once even though the application and native addon loaded successfully.
//
// Repair every Darwin candidate rather than only `process.arch`. Contributors
// commonly run an x64 Node under Rosetta while the downloaded Electron binary
// is arm64 (the July 12 failure), so the process performing `npm install` is not
// necessarily the process that will select the helper at runtime.

import { chmod, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const nodePtyRoot = resolve('node_modules/node-pty')
const candidates = process.platform === 'darwin'
  ? [
      join(nodePtyRoot, 'build', 'Release', 'spawn-helper'),
      join(nodePtyRoot, 'prebuilds', 'darwin-arm64', 'spawn-helper'),
      join(nodePtyRoot, 'prebuilds', 'darwin-x64', 'spawn-helper'),
    ]
  : [join(nodePtyRoot, 'build', 'Release', 'spawn-helper')]

let found = 0
for (const helper of candidates) {
  let info
  try {
    info = await stat(helper)
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') continue
    throw error
  }

  found += 1
  // Preserve read/write policy and add only execute bits. Hard-coding 0755
  // would unnecessarily rewrite a deliberately restrictive installation.
  const repairedMode = info.mode | 0o111
  if (repairedMode !== info.mode) await chmod(helper, repairedMode)
}

if (found === 0 && process.platform !== 'win32') {
  throw new Error(`node-pty spawn-helper not found under ${nodePtyRoot}`)
}

process.stdout.write(`[node-pty] verified ${found} executable spawn-helper candidate(s)\n`)
