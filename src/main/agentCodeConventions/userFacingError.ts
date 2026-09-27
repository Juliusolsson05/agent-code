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
const SENTENCES: Record<string, string> = {
  EACCES: 'Agent Code does not have permission to read or write these skill files.',
  EPERM: 'Agent Code does not have permission to read or write these skill files.',
  EROFS: 'These skill files are on a read-only volume.',
  ENOSPC: 'There is no space left on the disk for these skill files.',
  EDQUOT: 'There is no space left on the disk for these skill files.',
  ENOENT: 'A skill file or folder is missing.',
  ENOTDIR: 'A file is in the way where a skill folder should be.',
  EISDIR: 'A folder is in the way where a skill file should be.',
  EEXIST: 'Something already exists where Agent Code needs to write.',
  ENOTEMPTY: 'Something already exists where Agent Code needs to write.',
  EBUSY: 'The skill files are busy. Try again in a moment.',
  EMFILE: 'The system is out of open files. Try again in a moment.',
  ENFILE: 'The system is out of open files. Try again in a moment.',
  ENOTFOUND: 'Agent Code could not reach the network.',
  EAI_AGAIN: 'Agent Code could not reach the network.',
  ECONNREFUSED: 'Agent Code could not reach the network.',
  ECONNRESET: 'Agent Code could not reach the network.',
  ETIMEDOUT: 'Agent Code could not reach the network.',
}
export const GENERIC_SKILL_ERROR = 'Agent Code could not access these skill files.'
const MAX_KEPT_MESSAGE = 300
// Anything that starts like a path: `/x`, `~/`, `./`, `../`, a UNC `\\host`,
// or a drive letter, at the start or after a space, quote, paren, `=` or `:`.
const PATH_LIKE = /(^|[\s'"`(=:])(?:\/[^\s'"`]|~[\/\\]|\.{1,2}[\/\\]|\\\\|[A-Za-z]:[\/\\])|file:\/\//
const OWN_ERROR_NAMES = new Set(['Error', 'GitHubSkillSourceError', 'GitHubSkillDiscoveryLimitError'])

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
  // By constructor, not `name` alone: a library can set any name.
  const own = error.constructor === Error || OWN_ERROR_NAMES.has(error.constructor?.name ?? '')
  return own
    && error.message.length <= MAX_KEPT_MESSAGE
    && !error.message.includes('\n')
    && !PATH_LIKE.test(error.message)
}

export function userFacingSkillError(error: unknown, context = 'agent-code-conventions'): string {
  const code = systemCode(error)
  if (code === null && isOwnCuratedText(error)) return error.message
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
