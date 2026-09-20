import { readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

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
const CORPUS_SEGMENTS = [join('.claude', 'projects'), join('.codex', 'sessions')]

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
  const line = Number(source.slice(at + 1))
  if (!path.endsWith('.jsonl') || !Number.isInteger(line) || line <= 0) return null
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
    if (!CORPUS_SEGMENTS.some(segment => parsed.path.includes(segment))) continue
    if (!exists(parsed.path)) problems.push({ id: fixture.$fixture.id, reason: `cites a missing session: ${parsed.path}` })
  }
  return problems
}
