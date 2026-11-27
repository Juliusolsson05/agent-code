import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getAppPath: () => '/nonexistent',
    getPath: () => '/nonexistent',
  },
}))

import {
  BundledToolExecProbeError,
  clearExecProbeCacheForTests,
  probeExecutable,
} from './runtimeTools.js'

let dir: string

beforeEach(async () => {
  clearExecProbeCacheForTests()
  dir = await mkdtemp(join(tmpdir(), 'runtime-tools-probe-'))
})

afterEach(async () => {
  clearExecProbeCacheForTests()
  await rm(dir, { recursive: true, force: true })
})

describe('probeExecutable (#1553)', () => {
  it('kills a hung binary after timeoutMs and rejects with BundledToolExecProbeError', async () => {
    const script = join(dir, 'hang.sh')
    await writeFile(script, '#!/bin/sh\nsleep 10\n')
    await chmod(script, 0o755)

    await expect(probeExecutable('opencode', script, ['--version'], 120)).rejects.toThrow(
      BundledToolExecProbeError,
    )
    await expect(probeExecutable('opencode', script, ['--version'], 120)).rejects.toThrow(
      /timed out after 120ms/,
    )
  })

  it('evicts failed probes from execProbeCache so Retry succeeds once fixed, while caching successes', async () => {
    const script = join(dir, 'flaky.sh')
    const counter = join(dir, 'count.txt')
    // First run fails (simulates Gatekeeper/quarantine failure).
    await writeFile(script, '#!/bin/sh\necho blocked >&2\nexit 1\n')
    await chmod(script, 0o755)

    await expect(probeExecutable('opencode', script, ['--version'], 2_000)).rejects.toThrow(
      BundledToolExecProbeError,
    )

    // User clears quarantine / fixes the binary; next probe must re-run and succeed.
    await writeFile(script, `#!/bin/sh\necho x >> "${counter}"\nexit 0\n`)
    await chmod(script, 0o755)

    await expect(probeExecutable('opencode', script, ['--version'], 2_000)).resolves.toBeUndefined()
    // Subsequent call hits the success cache without spawning again.
    await expect(probeExecutable('opencode', script, ['--version'], 2_000)).resolves.toBeUndefined()

    const { readFile } = await import('node:fs/promises')
    const lines = (await readFile(counter, 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(1)
  })
})
