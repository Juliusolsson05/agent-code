import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, expect, it } from 'vitest'
import { OpencodeHeadless, SpawnedServer } from 'opencode-headless'

import { OPENCODE_SERVE_STARTUP_TIMEOUT_MS } from './opencodeSession.js'

// #1355, on the real readiness mechanism: SpawnedServer spawns a real child
// and waits for its listen line. The stub stands in for a CPU-starved but
// healthy `opencode serve` (the real binary took 16.7-43.1 s under load,
// 0.6-0.9 s idle): it prints the same listen line OpenCode prints, 11 s late.
// Under the package's 10 s default that start was killed; under the app's
// wait it succeeds.
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

// WHY the positive cases' test budget follows the product deadline (#1367
// review b): they assert "the app keeps waiting", so the test must never give
// up before the app would. A fixed 30 s let a loaded runner fail them while
// SpawnedServer would still have waited; this only fails when the app would.
const WAITS_LIKE_THE_APP = OPENCODE_SERVE_STARTUP_TIMEOUT_MS + 10_000

function slowServe(delayMs: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'opencode-slow-serve-'))
  dirs.push(dir)
  const bin = join(dir, 'opencode')
  writeFileSync(bin, `#!/usr/bin/env node
setTimeout(() => { console.log('opencode server listening on http://127.0.0.1:4096') }, ${delayMs})
setInterval(() => {}, 1000)
`)
  chmodSync(bin, 0o755)
  return bin
}

it('waits out a slow but healthy serve start', async () => {
  const server = new SpawnedServer({ binary: slowServe(11_000), cwd: tmpdir(), startupTimeoutMs: OPENCODE_SERVE_STARTUP_TIMEOUT_MS })
  const info = await server.start()
  expect(info.url).toBe('http://127.0.0.1:4096')
  await server.stop()
}, WAITS_LIKE_THE_APP)

it('is what the package default killed', async () => {
  const server = new SpawnedServer({ binary: slowServe(11_000), cwd: tmpdir() })
  await expect(server.start()).rejects.toThrow('to report its URL')
}, 30_000)

// #1367 review a (surviving mutation): the app hands the wait to
// OpencodeHeadless, not to SpawnedServer, so the package's forwarding is part
// of the fix. Dropping it put structured panes back on the 10 s default while
// both tests above stayed green. This goes through the same package method a
// structured start uses (resolveServerUrl -> SpawnedServer) with the app's
// option, and stops before the SDK connects (the stub serves no API).
it('forwards the wait through OpencodeHeadless to the spawned serve', async () => {
  const headless = new OpencodeHeadless({ binary: slowServe(11_000), cwd: tmpdir(), startupTimeoutMs: OPENCODE_SERVE_STARTUP_TIMEOUT_MS })
  try {
    const url = await (headless as unknown as { resolveServerUrl(): Promise<string> }).resolveServerUrl()
    expect(url).toBe('http://127.0.0.1:4096')
  } finally {
    await headless.stop()
  }
}, WAITS_LIKE_THE_APP)
