import { execFile } from 'child_process'
import { promisify } from 'util'

// Read the installed version of a CLI by spawning `<binary> --version` and
// parsing the first semver in the output.
//
// WHY a spawn instead of reading a package.json:
//   The Claude Code binary is native (Rust; ships via native installer for
//   most users) with no reachable package.json on disk. Codex is also a
//   native Rust binary; its npm wrapper's package.json exists but reports
//   the wrapper version, which can drift from the actual vendored per-arch
//   binary version (the reported reason for the "keeps prompting after
//   update" bug on npm — community.openai.com/…/1385324). `<binary>
//   --version` is the CLI's own answer to "what am I", and it's what we
//   compare against later to decide if an update actually took.
//
// WHY execFile with a hard timeout:
//   A stuck --version (broken PATH resolution, symlink loop, ptrace ban)
//   must not hang the app boot. 5 s is generous; a healthy CLI answers in
//   <100 ms. If we time out, we return 'timeout' and the orchestrator
//   treats the whole probe as 'not installed / not probeable' — silent.
//
// WHY parse first semver rather than "trust the whole line":
//   clap's default output is `<name> <version>` (Codex confirmed to use
//   `codex 0.144.0`); Claude prints `2.1.205` alone in some builds. Both
//   CLIs also emit prereleases like `0.144.0-alpha.4`. Extracting the
//   first `MAJOR.MINOR.PATCH(-tag)?` match is robust to either format
//   AND to a future banner line that might get spliced in ("Update
//   available!" etc.), which we suppress in the CLIs' own config where
//   we can — but this parser needs to work whether that suppression has
//   landed yet or not.

const execFileAsync = promisify(execFile)

const SEMVER_RE = /(\d+)\.(\d+)\.(\d+)(?:-([\w.]+))?/

export type CliVersionResult =
  | { ok: true; version: string; major: number; minor: number; patch: number; prerelease: string | null }
  | { ok: false; reason: 'not-found' | 'timeout' | 'unparseable' | 'spawn-error' }

export async function readInstalledVersion(binary: string): Promise<CliVersionResult> {
  // In-process cache is skipped intentionally: this function runs at most
  // twice per launch per CLI (before + after update) and the cost is a
  // fork+exec, not IPC. A cache would need to be invalidated when the
  // orchestrator finishes an update to detect the new version, and getting
  // that wrong is exactly the class of bug (Codex vendored-binary "didn't
  // actually change") we're trying to catch. Two spawns per launch is fine.
  let out: string
  try {
    const result = await execFileAsync(binary, ['--version'], {
      timeout: 5_000,
      maxBuffer: 64 * 1024,
      // Do NOT inherit process env wholesale — `NO_COLOR=1` keeps ANSI
      // escape sequences out of the output so the regex sees the raw
      // semver. Some CLIs also gate their version banner on TTY detection;
      // running under execFile means no TTY, which is what we want.
      env: { ...process.env, NO_COLOR: '1', CI: '1' },
    })
    out = String(result.stdout ?? '') + String(result.stderr ?? '')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    // The killed-by-timeout path comes back as an error with signal SIGTERM;
    // execFile also sets `killed` on the error. Node doesn't always give us
    // ETIMEDOUT here — pattern-match instead.
    if (code === 'ETIMEDOUT' || (err as { killed?: boolean }).killed) {
      return { ok: false, reason: 'timeout' }
    }
    if (code === 'ENOENT') return { ok: false, reason: 'not-found' }
    return { ok: false, reason: 'spawn-error' }
  }

  const match = SEMVER_RE.exec(out)
  if (!match) return { ok: false, reason: 'unparseable' }
  return {
    ok: true,
    version: match[0],
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  }
}

/** Compare two semver strings the CLI-updater cares about. Returns:
 *   -1 if a < b, 0 if equal, +1 if a > b.
 *
 *  WHY not pull in the `semver` npm package:
 *   The two CLIs both publish plain MAJOR.MINOR.PATCH(-alpha.N) tags. The
 *   full semver spec (build metadata, wildcards, ranges, coercion) is
 *   dead code for us. A local comparator is <30 lines and has no external
 *   dependency to keep pinned. If we ever need range checks, revisit.
 *
 *  Prerelease handling matches semver: `1.0.0-alpha < 1.0.0`, dot-separated
 *  identifiers compared numerically when numeric else lexically. Because
 *  we compare against dist-tags.stable / releases/latest, prereleases are
 *  rare in this path, but the CLI itself might report one if the user
 *  opted into `--channel alpha`. Getting the comparator right there means
 *  we don't falsely report "update available" for a prerelease we already
 *  have. */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const parseA = SEMVER_RE.exec(a)
  const parseB = SEMVER_RE.exec(b)
  // If either side is unparseable, treat as equal — the caller will decide
  // what "we don't know" means. Never throw from a comparator.
  if (!parseA || !parseB) return 0
  const parts = (m: RegExpExecArray): [number, number, number, string | undefined] => [
    Number(m[1]),
    Number(m[2]),
    Number(m[3]),
    m[4],
  ]
  const [aMaj, aMin, aPat, aPre] = parts(parseA)
  const [bMaj, bMin, bPat, bPre] = parts(parseB)
  if (aMaj !== bMaj) return aMaj < bMaj ? -1 : 1
  if (aMin !== bMin) return aMin < bMin ? -1 : 1
  if (aPat !== bPat) return aPat < bPat ? -1 : 1
  // Both parse to the same MAJOR.MINOR.PATCH; the prerelease tag breaks
  // the tie. Per semver: any release is greater than any prerelease of
  // the same core version.
  if (aPre === undefined && bPre === undefined) return 0
  if (aPre === undefined) return 1
  if (bPre === undefined) return -1
  const aIds = aPre.split('.')
  const bIds = bPre.split('.')
  for (let i = 0; i < Math.max(aIds.length, bIds.length); i += 1) {
    const ai = aIds[i]
    const bi = bIds[i]
    if (ai === undefined) return -1
    if (bi === undefined) return 1
    const an = Number(ai)
    const bn = Number(bi)
    const bothNumeric = !Number.isNaN(an) && !Number.isNaN(bn)
    if (bothNumeric) {
      if (an !== bn) return an < bn ? -1 : 1
    } else {
      if (ai !== bi) return ai < bi ? -1 : 1
    }
  }
  return 0
}

/** Classify the difference between two versions into the severity buckets
 *  the banner UI cares about. Same version → `null` (no banner). Any
 *  prerelease change → `prerelease` (rare, opt-in). Otherwise the highest
 *  component that changed. */
export function severity(from: string, to: string): 'patch' | 'minor' | 'major' | 'prerelease' | null {
  const a = SEMVER_RE.exec(from)
  const b = SEMVER_RE.exec(to)
  if (!a || !b) return null
  if (a[0] === b[0]) return null
  if (a[4] !== undefined || b[4] !== undefined) return 'prerelease'
  if (a[1] !== b[1]) return 'major'
  if (a[2] !== b[2]) return 'minor'
  if (a[3] !== b[3]) return 'patch'
  return null
}
