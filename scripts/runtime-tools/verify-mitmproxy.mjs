#!/usr/bin/env node
// Verify already-downloaded mitmproxy archives in
// third_party/mitmproxy/cache/ against manifest.json without
// re-downloading.
//
// Usage:
//   node scripts/runtime-tools/verify-mitmproxy.mjs            # warn on missing
//   node scripts/runtime-tools/verify-mitmproxy.mjs --strict   # fail on missing or mismatched
//
// Strict mode is what CI release jobs run after fetch. Non-strict mode
// is for local "did my cache get corrupted?" checks.

import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..')
const manifestPath = join(repoRoot, 'third_party', 'mitmproxy', 'manifest.json')
const cacheRoot = join(repoRoot, 'third_party', 'mitmproxy', 'cache')

async function main() {
  const strict = process.argv.includes('--strict')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))

  let problems = 0

  for (const [platformKey, platform] of Object.entries(manifest.platforms)) {
    // See fetch-mitmproxy.mjs for the WHY on per-platform filename.
    const filename = platform.filename.replaceAll('{version}', manifest.version)
    const file = join(cacheRoot, platformKey, filename)

    try {
      await stat(file)
    } catch {
      const msg = `[verify-mitmproxy] missing cache: ${platformKey} (${file})`
      if (strict) {
        console.error(msg)
        problems++
      } else {
        console.warn(`${msg} — run \`npm run runtime:fetch:mitmproxy\``)
      }
      continue
    }

    const buf = await readFile(file)
    const digest = createHash('sha256').update(buf).digest('hex')
    if (digest !== platform.sha256) {
      console.error(
        `[verify-mitmproxy] hash mismatch for ${platformKey}: ${digest} != ${platform.sha256}`,
      )
      problems++
      continue
    }
    if (platform.bytes && buf.length !== platform.bytes) {
      console.error(
        `[verify-mitmproxy] byte-size mismatch for ${platformKey}: ${buf.length} != ${platform.bytes}`,
      )
      problems++
      continue
    }
    console.log(`[verify-mitmproxy] OK ${platformKey} (${digest.slice(0, 12)})`)
  }

  if (problems > 0) {
    console.error(`[verify-mitmproxy] ${problems} problem(s) found`)
    process.exit(1)
  }
}

main().catch(err => {
  console.error(
    `[verify-mitmproxy] ${err instanceof Error ? err.message : String(err)}`,
  )
  process.exit(1)
})
