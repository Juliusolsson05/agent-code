/**
 * The text a Skills, Conventions or Custom Skills surface may show for an
 * error (#1427, q22/q39).
 *
 * WHY this and not `error.message`: the old `safeErrorMessage` passed Node's
 * own text through, so the UI showed `EACCES: permission denied, mkdir
 * '/Users/…/.claude/skills'`, with the user's home path and OS jargon, in
 * target rows, mutation results and the recovery banner. A system error (it
 * carries an errno `code` and a `syscall`) now becomes one fixed sentence per
 * code. Any other message is the service's own curated text (validation,
 * product-skill conflicts) and is kept, unless it contains an absolute path or
 * runs long, which only happens when it came from somewhere else; then it gets
 * the generic sentence. The raw error always goes to the main log, because
 * the fixed sentence is useless for diagnosis.
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
// POSIX absolute paths after start/space/quote/paren, and Windows drive paths.
const ABSOLUTE_PATH = /(^|[\s'"(=:])\/[^\s'"]+\/|[A-Za-z]:\\/

function systemCode(error: unknown): string | null {
  if (!(error instanceof Error)) return null
  const { code, syscall, errno } = error as NodeJS.ErrnoException
  return typeof code === 'string' && /^E[A-Z_]+$/.test(code) && (typeof syscall === 'string' || typeof errno === 'number') ? code : null
}

export function userFacingSkillError(error: unknown, context = 'agent-code-conventions'): string {
  const code = systemCode(error)
  let sentence: string
  if (code !== null) sentence = SENTENCES[code] ?? GENERIC_SKILL_ERROR
  else if (error instanceof Error && error.message && error.message.length <= MAX_KEPT_MESSAGE && !ABSOLUTE_PATH.test(error.message)) return error.message
  else sentence = GENERIC_SKILL_ERROR
  console.warn(`[${context}] ${sentence}`, error)
  return sentence
}
