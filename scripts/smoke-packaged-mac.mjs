#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

// Run only the host-native thin app. The structural verifier checks both
// artifacts byte-for-byte; trying to execute the opposite slice would add a
// hidden Rosetta dependency to otherwise clean CI runners.
const dir = process.arch === 'arm64' ? 'mac-arm64' : 'mac'
const executable = resolve('release', dir, 'Agent Code.app', 'Contents', 'MacOS', 'Agent Code')

const code = await new Promise((resolvePromise, reject) => {
  const child = spawn(executable, ['--packaging-smoke'], {
    stdio: 'inherit',
    env: { ...process.env, AGENT_CODE_PERF: '0' },
  })
  child.once('error', reject)
  child.once('exit', exitCode => resolvePromise(exitCode ?? 1))
})

if (code !== 0) process.exit(code)
