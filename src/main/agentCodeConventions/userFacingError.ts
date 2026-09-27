import { GitHubSkillSourceError } from './githubSkillSource.js'

/**
 * The text a Skills, Conventions or Custom Skills surface may show for an
 * error (#1427, q22/q39).
 *
 * WHY this and not `error.message`: the old `safeErrorMessage` passed Node's
 * own text through, so the UI showed `EACCES: permission denied, mkdir
 * '/Users/…/.claude/skills'`, with the user's home path and OS jargon, in
 * target rows, mutation results and the recovery banner.
 *
 * The rules, in order:
 *   1. A Node system error (an errno `code` string plus `syscall` or `errno`):
 *      one fixed sentence per code.
 *   2. A child-process error (it carries `cmd` or `stderr`; its `code` is the
 *      exit NUMBER, so rule 1 misses it): generic. Its message is
 *      `Command failed: …` plus raw stderr.
 *   3. Kept only when the error is exactly a plain `Error` or the package's
 *      `GitHubSkillSourceError`, i.e. text this package wrote, AND the text is
 *      one bounded line with no path in it. Library errors (TypeError from
 *      fetch, SyntaxError, the YAML parser's) are subclasses and get the
 *      generic sentence, as does anything else.
 * The first version kept ANY short message without a recognised path, and
 * review of #1456 (a) showed raw git stderr, `/tmp`, `~/…`, `../…` and
 * `\\server` shares passing through. The raw error always goes to the main
 * log whenever the text is rewritten, because the fixed sentence is useless
 * for diagnosis.
 */
// Location-neutral on purpose (review of #1456, b): the same mapper covers
// skill folders, Agent Code's own state file and GitHub downloads, so a
// sentence must be true for all of them. The row it appears in says where.
const SENTENCES: Record<string, string> = {
  EACCES: 'Agent Code does not have permission to use this location.',
  EPERM: 'Agent Code does not have permission to use this location.',
  EROFS: 'This location is on a read-only volume.',
  ENOSPC: 'There is no space left on the disk.',
  EDQUOT: 'There is no space left on the disk.',
  ENOENT: 'A file or folder Agent Code needs is missing.',
  ENOTDIR: 'A file is in the way where a folder should be.',
  EISDIR: 'A folder is in the way where a file should be.',
  EEXIST: 'Something already exists where Agent Code needs to write.',
  ENOTEMPTY: 'Something already exists where Agent Code needs to write.',
  EBUSY: 'The file is busy. Try again in a moment.',
  EMFILE: 'The system is out of open files. Try again in a moment.',
  ENFILE: 'The system is out of open files. Try again in a moment.',
  ENOTFOUND: 'Agent Code could not reach the network.',
  EAI_AGAIN: 'Agent Code could not reach the network.',
  ECONNREFUSED: 'Agent Code could not reach the network.',
  ECONNRESET: 'Agent Code could not reach the network.',
  ETIMEDOUT: 'Agent Code could not reach the network.',
}
export const GENERIC_SKILL_ERROR = 'Agent Code could not read or write the files it needs.'
const MAX_KEPT_MESSAGE = 300
// Anything that starts like a path. The rule is deliberately blunt (review of
// #1456, rounds 1 and 2 c): a `/` or `./` / `../` at the start or after ANY
// character that is not a letter, digit or `_` is a path start, whatever
// follows it; so is `~/`, a UNC `\\\\`, a drive letter and `file://`. Listing
// delimiters missed `[` in round 1; excluding `.` and `-` missed `failed./var`
// in round 2. Prose with a letter before the slash (`and/or`, `file/folder`,
// a package-relative `scripts/a.sh`) stays readable; a spaced ` / ` in prose
// is treated as a path and rewritten, which fails closed.
const PATH_LIKE = /(^|[^\w])\.{0,2}\/|~[\/\\]|\\\\|[A-Za-z]:[\/\\]|file:\/\//

function systemCode(error: unknown): string | null {
  if (!(error instanceof Error)) return null
  const { code, syscall, errno } = error as NodeJS.ErrnoException
  return typeof code === 'string' && /^E[A-Z_]+$/.test(code) && (typeof syscall === 'string' || typeof errno === 'number') ? code : null
}

function isChildProcessError(error: Error): boolean {
  return 'cmd' in error || 'stderr' in error
}

function isOwnCuratedText(error: unknown): error is Error {
  if (!(error instanceof Error) || !error.message) return false
  if (isChildProcessError(error)) return false
  // By identity, not by name (review of #1456, round 2 a): a library class that happens to be
  // called GitHubSkillSourceError is not this package's text. A plain Error is this package's
  // own throw; GitHubSkillSourceError (and its discovery-limit subclass) is checked by instanceof.
  const own = error.constructor === Error || error instanceof GitHubSkillSourceError
  return own
    && error.message.length <= MAX_KEPT_MESSAGE
    && !error.message.includes('\n')
    && !PATH_LIKE.test(error.message)
}

export function userFacingSkillError(error: unknown, context = 'agent-code-conventions'): string {
  const code = systemCode(error)
  if (code === null && isOwnCuratedText(error)) {
    // A curated reason that carries its offending path on the side (see
    // skillPathSafety's pathComponentError): shown without it, logged with it.
    if (typeof (error as { path?: unknown }).path === 'string') console.warn(`[${context}] ${error.message}`, error)
    return error.message
  }
  const sentence = code === null ? GENERIC_SKILL_ERROR : SENTENCES[code] ?? GENERIC_SKILL_ERROR
  console.warn(`[${context}] ${sentence}`, error)
  return sentence
}

/**
 * The Reveal result when `shell.openPath` fails (review of #1456, a). Electron
 * returns the failure as a string such as `Failed to open /Users/…/skills`,
 * and the four Reveal handlers returned it as the IPC `message`, where the
 * Skills rows show it. The raw text goes to the main log instead.
 */
export const REVEAL_FAILED = 'Agent Code could not open this folder.'

export function revealFailureMessage(raw: string, context: string): string {
  console.warn(`[${context}] reveal failed:`, raw)
  return REVEAL_FAILED
}
