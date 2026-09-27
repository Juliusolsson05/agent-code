import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, expect, it } from 'vitest'

import { collectProxyRunDirs } from './debugRetention.js'

// #1385 (q91 follow-up of #1380): retention collected a proxy run dir only
// once it held `proxy-events.jsonl`. A run dir holding just
// `session-meta.json` + `sslkeylog.log` was walked into, never collected, never
// budgeted and never removed, and those are plaintext TLS session secrets. The
// owner's machine had 23 such dirs (5.18 MB, May-September 2026; names and
// sizes recounted by #1380 review c, contents never read). Shapes below are
// those real layouts: proxy/<project>/<session-key>/<ISO timestamp>/.
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function runDir(root: string, parts: string[], files: Record<string, string>): string {
  const dir = join(root, ...parts)
  mkdirSync(dir, { recursive: true })
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body)
  return dir
}

it('collects a key-log-only run dir as a proxy artifact, alongside normal run dirs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'proxy-retention-'))
  roots.push(root)
  runDir(root, ['medlo', 'shell-89d43b9b', '2026-08-28T17-30-06-452Z'], { 'session-meta.json': '{}', 'sslkeylog.log': 'x'.repeat(4096) })
  runDir(root, ['agent-code', 'resume-a5fb379b', '2026-09-27T01-03-52-273Z'], { 'session-meta.json': '{}', 'proxy-events.jsonl': '{}\n', 'sslkeylog.log': 'x'.repeat(1024) })
  // Shared mitmproxy state is never a run dir, whatever it holds.
  runDir(root, ['_shared-conf'], { 'mitmproxy-ca-cert.pem': 'ca' })
  // Metadata alone is not a run's evidence; leave it for its own pass.
  runDir(root, ['agent-code', 'shell-empty', '2026-09-01T00-00-00-000Z'], { 'session-meta.json': '{}' })

  const artifacts = await collectProxyRunDirs(root)
  expect(artifacts.map(artifact => relative(root, artifact.path)).sort()).toEqual([
    join('agent-code', 'resume-a5fb379b', '2026-09-27T01-03-52-273Z'),
    join('medlo', 'shell-89d43b9b', '2026-08-28T17-30-06-452Z'),
  ])
  const keyLogOnly = artifacts.find(artifact => artifact.path.includes('shell-89d43b9b'))!
  expect(keyLogOnly).toMatchObject({ kind: 'dir', bucket: 'proxy' })
  expect(keyLogOnly.bytes).toBeGreaterThanOrEqual(4096)
})
