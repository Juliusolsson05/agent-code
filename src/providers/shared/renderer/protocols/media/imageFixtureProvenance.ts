import { readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'

// Provenance of the image-read fixtures, split by what it costs to check.
//
// WHY this is its own module rather than inline in the test (#901): the two
// checks below have DIFFERENT preconditions, and running them together made
// the deterministic gate depend on what the developer happened to have
// retained. The old code asserted that every cited session still existed as
// soon as EITHER corpus root did — so one rotated transcript failed
// `npm test` and blocked `npm run check` for completely unrelated work, on a
// machine where nothing was wrong with the fixtures.
//
// `docs/testing/standard.md` is explicit about the rule that was broken:
// reading a developer's home directory is LIVE behaviour and needs an
// explicit opt-in variable in addition to `test:live`. "The directory happens
// to be there" is not an opt-in.
//
// The real provenance gate is GENERATION, not assertion: a fixture cannot
// exist unless scripts/extract-image-fixtures.mts opened that exact file at
// that exact line and read a parseable record. `unreachableCitations` is a
// second opinion for whoever still has the corpus, not the gate.

export type FixtureCitation = {
  id: string
  censusRows: number[]
  source: string
  proves: string
  substitutions: { path: string; originalChars: number; mime: string }[]
  totalOriginalPayloadChars: number
}

export type ImageFixture = {
  $fixture: FixtureCitation
  entry: Record<string, unknown>
}

export type ProvenanceProblem = { id: string; reason: string }

/**
 * How many shapes the recorded census holds
 * (docs/decomposition/evidence/image-reads/shape-census.md). A fixture cites
 * rows in it by number, so a row outside the range cites nothing.
 */
export const CENSUS_ROW_COUNT = 27

/**
 * The developer-local corpora the fixtures were extracted from, on THIS
 * machine. Only the live suite uses them, to check the roots are there at all
 * before reporting what is missing under them.
 */
export const CORPUS_ROOTS = {
  claude: join(homedir(), '.claude', 'projects'),
  codex: join(homedir(), '.codex', 'sessions'),
}

/**
 * What makes a citation the corpus's, independent of whose machine is asking.
 *
 * WHY segments and not `CORPUS_ROOTS` (CI caught this): the roots embed
 * `homedir()`, so a second developer — or a runner — matches nothing, and
 * `unreachableCitations` skips every fixture and reports a clean result
 * without checking anything. A live suite that passes vacuously on every
 * machine but one is worse than no live suite. The provider directory names
 * are the stable part; the home directory is not.
 */
const CORPUS_SEGMENTS = ['.claude/projects', '.codex/sessions']

/**
 * The number of fixtures the corpus holds. Pinned because every corpus-wide
 * assertion compares its result to `allFixtures().length` — which `0 === 0`
 * satisfies (#1084 review, finding 2). A loader that found NOTHING kept the
 * deterministic suite green AND flipped the live suite from reporting three
 * genuinely missing sessions to reporting none. Both controls were satisfied
 * by having nothing to control.
 *
 * Raise it when a fixture is added; that is the point.
 */
export const IMAGE_FIXTURE_COUNT = 7

/**
 * Both separators folded to `/`.
 *
 * A macOS path may legally contain a backslash, so this is not a general path
 * normaliser — it is only ever applied to a citation, where a backslash is a
 * Windows separator and nothing else.
 */
const normalisePath = (path: string): string => path.split(sep).join('/').split('\\').join('/')

export const FIXTURE_DIR = join(process.cwd(), 'testing/fixtures/image-reads')

export function loadImageFixture(id: string): ImageFixture {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, `${id}.json`), 'utf8')) as ImageFixture
}

export function loadImageFixtures(): ImageFixture[] {
  return readdirSync(FIXTURE_DIR)
    .filter(name => name.endsWith('.json'))
    .map(name => JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8')) as ImageFixture)
}

/** Split a `path/to/file.jsonl:123` citation. Null when it is not that shape. */
export function parseCitation(source: string): { path: string; line: number } | null {
  const at = source.lastIndexOf(':')
  if (at <= 0) return null
  const path = source.slice(0, at)
  const rest = source.slice(at + 1)
  // WHY the line is matched rather than coerced (#1084 review, finding 3):
  // `Number` accepts things a citation never is. `Number('abc')` is NaN and
  // `NaN <= 0` is FALSE, so a non-numeric line slipped through the bound check
  // entirely; and `Number(' 42')`, `Number('+7')` and `Number('0x10')` are all
  // valid numbers that the generator cannot have written. Plain digits is what
  // a citation is.
  if (!/^\d+$/.test(rest)) return null
  const line = Number(rest)
  if (!path.endsWith('.jsonl') || line <= 0) return null
  return { path, line }
}

/**
 * Everything wrong with a fixture that the REPOSITORY can see: a citation that
 * is not a `<file>.jsonl:<line>` pair, no census rows, nothing claimed proved.
 *
 * Reads nothing outside `testing/fixtures/`, so it is safe on a clean machine
 * with no credentials, no personal configuration and no network — which is
 * what `npm test` promises.
 */
export function malformedCitations(fixtures: readonly ImageFixture[]): ProvenanceProblem[] {
  const problems: ProvenanceProblem[] = []
  for (const fixture of fixtures) {
    const { id, censusRows, proves, source } = fixture.$fixture
    if (censusRows.length === 0) problems.push({ id, reason: 'cites no census row' })
    if (proves.length === 0) problems.push({ id, reason: 'claims to prove nothing' })
    if (!parseCitation(source)) problems.push({ id, reason: `source is not <file>.jsonl:<line>: ${source}` })
    // WHY the census rows are checked against the CENSUS and not just counted
    // (#1084 review, finding 4): this function's own name is "cites a census
    // row", and `censusRows: [9999]` passed. The census is committed at
    // docs/decomposition/evidence/image-reads/shape-census.md, so this is
    // repo-deterministic — exactly the kind of provenance that did NOT have to
    // move to the live suite.
    for (const row of censusRows) {
      if (!Number.isInteger(row) || row < 1 || row > CENSUS_ROW_COUNT) {
        problems.push({ id, reason: `cites census row ${row}, which is not one of the ${CENSUS_ROW_COUNT} recorded shapes` })
      }
    }
  }
  return problems
}

/**
 * Fixtures whose cited session is no longer reachable.
 *
 * Only meaningful to whoever extracted them, and only as a second opinion: a
 * missing file here means the transcript was rotated or deleted, not that the
 * fixture is wrong. Citations outside a provider corpus are skipped — they
 * were never a corpus session to begin with.
 */
export function unreachableCitations(
  fixtures: readonly ImageFixture[],
  exists: (path: string) => boolean,
): ProvenanceProblem[] {
  const problems: ProvenanceProblem[] = []
  for (const fixture of fixtures) {
    const parsed = parseCitation(fixture.$fixture.source)
    if (!parsed) continue
    // Normalised before matching so a path recorded on EITHER separator names
    // the same corpus: the segments are the provider's directory names, not
    // the recording host's convention. Matched with surrounding slashes so
    // `.claude` alone does not claim `~/.claude/todos`, which holds real
    // `.jsonl` files that are not sessions.
    if (!CORPUS_SEGMENTS.some(segment => normalisePath(parsed.path).includes(`/${segment}/`))) continue
    if (!exists(parsed.path)) problems.push({ id: fixture.$fixture.id, reason: `cites a missing session: ${parsed.path}` })
  }
  return problems
}
