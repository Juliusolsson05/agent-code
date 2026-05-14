#!/usr/bin/env node
// Verify the built static tmux binary against manifest.json.
//
// Until PR 3 lands the static build, the manifest contains TBD-PR3
// placeholders and the cache is empty. In that state this script
// exits 0 with a "skipped" warning so the bundling pipeline can
// continue (mitmproxy still verifies normally) and so `npm run
// runtime:verify` does not block PR 1 review.
//
// Once PR 3 lands real hashes, CI can switch to `--strict` and this
// script will fail when the cache is missing or corrupted.

import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..')
const manifestPath = join(repoRoot, 'third_party', 'tmux', 'manifest.json')
const cacheRoot = join(repoRoot, 'third_party', 'tmux', 'cache')

async function main() {
  const strict = process.argv.includes('--strict')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))

  if (manifestHasPlaceholders(manifest)) {
    const msg =
      '[verify-tmux] manifest contains TBD-PR3 placeholders; skipping (tracked in issue #120).'
    if (strict) {
      console.error(msg)
      process.exit(1)
    } else {
      console.warn(msg)
      return
    }
  }

  let problems = 0
  for (const [platformKey, platform] of Object.entries(manifest.platforms)) {
    const file = join(cacheRoot, platformKey, 'tmux')
    try {
      await stat(file)
    } catch {
      const msg = `[verify-tmux] missing cache: ${platformKey} (${file})`
      if (strict) {
        console.error(msg)
        problems++
      } else {
        console.warn(`${msg} — run \`npm run runtime:build:tmux\``)
      }
      continue
    }
    const buf = await readFile(file)
    const digest = createHash('sha256').update(buf).digest('hex')
    if (digest !== platform.sha256) {
      console.error(
        `[verify-tmux] hash mismatch for ${platformKey}: ${digest} != ${platform.sha256}`,
      )
      problems++
      continue
    }
    console.log(`[verify-tmux] OK ${platformKey} (${digest.slice(0, 12)})`)
  }

  if (problems > 0) {
    console.error(`[verify-tmux] ${problems} problem(s) found`)
    process.exit(1)
  }
}

function manifestHasPlaceholders(manifest) {
  return JSON.stringify(manifest).includes('TBD-PR3')
}

main().catch(err => {
  console.error(`[verify-tmux] ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
