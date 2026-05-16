// Upstream drift detector.
//
// Deliberately dumb: it answers exactly one question per provider —
// "is the version on npm's `latest` dist-tag newer than the version
// this repo has explicitly accepted as supported in
// support/upstream-versions.json?"
//
// It does NOT read changelogs, guess affected code, or rank severity.
// Inferring meaning from release notes is unreliable and gives false
// confidence; a human/agent does the compatibility pass. See
// docs/superpowers/plans/2026-05-16-upstream-drift-tracker.md and
// support/README.md for the full rationale.
//
// Output: machine-readable JSON to stdout, a human summary to stderr,
// and (under GitHub Actions) a `result=<json>` line to $GITHUB_OUTPUT
// so the workflow can branch on it. Exit 0 = ran fine (drift is a
// signal, not an error). Exit 1 = the registry was unreachable or
// returned junk — fail the run red rather than emit a false "in sync".

import { appendFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// support/upstream-versions.json sits one directory up from scripts/.
// This layout is identical in all three repos that carry this script,
// so the relative resolve is portable.
const SUPPORT_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'support',
  'upstream-versions.json',
)

// Parse "2.1.143" / "v2.1.143" / "0.131.0-alpha.2" into a comparable
// [major, minor, patch] tuple. The prerelease suffix is intentionally
// dropped: npm's `latest` dist-tag points at a stable release by
// convention, but stripping the suffix keeps the comparison total even
// if a prerelease ever lands on `latest`. A non-numeric segment
// becomes 0 so a malformed version sorts low instead of throwing.
function core(version) {
  const [release] = String(version).trim().replace(/^v/, '').split('-')
  const parts = release.split('.').map(n => Number.parseInt(n, 10))
  return [0, 1, 2].map(i => (Number.isFinite(parts[i]) ? parts[i] : 0))
}

// True when `a` is strictly newer than `b`.
function isNewer(a, b) {
  const ca = core(a)
  const cb = core(b)
  for (let i = 0; i < 3; i += 1) {
    if (ca[i] > cb[i]) return true
    if (ca[i] < cb[i]) return false
  }
  return false
}

// Fetch npm's ABBREVIATED registry metadata. The
// `application/vnd.npm.install-v1+json` Accept header returns the small
// abbreviated document — it still carries `dist-tags`, so we get
// `latest` without downloading the full registry doc (which contains
// every version ever published and is multiple MB for these packages).
async function fetchLatest(pkg) {
  const url = `https://registry.npmjs.org/${pkg.replace('/', '%2F')}`
  const res = await fetch(url, {
    headers: { Accept: 'application/vnd.npm.install-v1+json' },
  })
  if (!res.ok) {
    throw new Error(`npm registry returned ${res.status} for ${pkg}`)
  }
  const body = await res.json()
  const latest = body['dist-tags']?.latest
  if (typeof latest !== 'string' || latest.length === 0) {
    throw new Error(`no dist-tags.latest for ${pkg}`)
  }
  return latest
}

async function main() {
  const support = JSON.parse(await readFile(SUPPORT_FILE, 'utf8'))
  const results = []

  for (const [provider, entry] of Object.entries(support.providers)) {
    const latest = await fetchLatest(entry.pkg)
    results.push({
      provider,
      label: entry.label,
      pkg: entry.pkg,
      accepted: entry.accepted,
      latest,
      drift: isNewer(latest, entry.accepted),
      changelog: entry.changelog,
    })
  }

  // Human summary to stderr so stdout stays pure JSON.
  for (const r of results) {
    process.stderr.write(
      `${r.label}: accepted ${r.accepted}, latest ${r.latest} — ` +
        `${r.drift ? 'DRIFT' : 'in sync'}\n`,
    )
  }

  const json = JSON.stringify({ results })
  process.stdout.write(`${json}\n`)

  // GitHub Actions exposes a per-step output file via $GITHUB_OUTPUT.
  // Absent when run locally — that is fine, the JSON is also on stdout.
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `result=${json}\n`)
  }
}

main().catch(err => {
  process.stderr.write(`upstream check failed: ${err.message}\n`)
  process.exit(1)
})
