import { AGENT_PROVIDER_KINDS, type AgentProviderKind } from '@shared/types/providerKind.js'

/**
 * Understands the skill install lines people actually paste (#1161).
 *
 * The de facto standard is vercel-labs/skills (`npx skills add`, skills.sh):
 * READMEs publish `npx skills add owner/repo --skill name`, and skills.sh shows
 * exactly that command on every skill page. Agent Code does not RUN that tool
 * (see D1 in docs/superpowers/specs/2026-09-23-skills-official-install-design.md:
 * it needs Node, sends telemetry, symlinks into provider roots and bypasses
 * the ownership journal). Instead this parser reads the same grammar and
 * hands main a GitHub source plus the selection, and the journaled
 * pipeline installs the same bytes `npx skills add … --copy` would.
 *
 * WHY this module is pure and shared: the renderer uses it for the live
 * "Understood: …" line while the user types, and main uses it as the
 * authority. Main always re-parses the raw text itself, never trusting a
 * renderer-parsed object, so the two can never disagree about what was
 * approved. Source forms mirror vercel-labs/skills `src/source-parser.ts`
 * (1.7); flags mirror its `add` command.
 */

/** Pasted README blocks are small; this bounds tokenizer work, not skills. */
export const SKILL_INSTALL_INPUT_MAX_LENGTH = 64 * 1024

export type SkillInstallGitHubSource = {
  owner: string
  repository: string
  /** `#ref` from shorthand. Resolved against advertised branches/tags in main. */
  ref?: string
  /** `owner/repo/sub/path` shorthand: a directory on the default branch. */
  subpath?: string
  /**
   * `/tree/<ref>/<path>` URL segments. The ref may itself contain slashes, so
   * only main — which sees the advertised refs — can split ref from path.
   */
  treeSegments?: string[]
}

export type SkillInstallSelection = string[] | '*' | null

export type ParsedSkillInstallInput = {
  /** Whether the text was a full install command or just a source. */
  kind: 'command' | 'source'
  source: SkillInstallGitHubSource
  /** Human-readable source for the "Understood:" line and notices. */
  display: string
  /** `--skill` / `@skill` names, `'*'` for all, null for "let me choose". */
  skills: SkillInstallSelection
  /** `-a` mapped to Agent Code providers, `'*'` for all, null when absent. */
  providers: AgentProviderKind[] | '*' | null
  fullDepth: boolean
  /** `-l/--list`: browse without preselecting anything. */
  listOnly: boolean
  notices: string[]
}

export type SkillInstallParseResult =
  | { ok: true; value: ParsedSkillInstallInput }
  | {
      ok: false
      code: 'empty' | 'syntax' | 'unsupported-source' | 'unsupported-flag'
      message: string
    }

/**
 * vercel-labs/skills agent ids that correspond to an Agent Code provider.
 * WHY a map and not "same string": the ecosystem calls Claude `claude-code`,
 * and people paste that. Every other agent id (cursor, windsurf, …) is valid
 * for `npx skills` but not something Agent Code launches, so it becomes a
 * notice rather than an error — the rest of the line is still meaningful.
 */
const AGENT_ALIASES: Record<string, AgentProviderKind> = {
  'claude-code': 'claude',
  claude: 'claude',
  codex: 'codex',
  opencode: 'opencode',
  pi: 'pi',
  grok: 'grok',
}

/** Flags that change nothing for Agent Code but are valid `npx skills add`. */
const IGNORED_FLAGS = new Set(['-g', '--global', '-y', '--yes', '--copy'])

const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const GITHUB_REPOSITORY = /^[A-Za-z0-9_.-]{1,100}$/

export function parseSkillInstallInput(raw: string): SkillInstallParseResult {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { ok: false, code: 'empty', message: 'Paste an install command, a GitHub repository or a URL.' }
  }
  if (raw.length > SKILL_INSTALL_INPUT_MAX_LENGTH) {
    return { ok: false, code: 'syntax', message: 'That text is too long to be one install command.' }
  }
  // README code blocks often keep the shell prompt (`$ npx skills add …`).
  // It is stripped before tokenizing because `$` is otherwise refused as an
  // expansion.
  const tokenized = tokenizeInstallCommand(raw.trimStart().replace(/^[$>]\s+/, ''))
  if (!tokenized.ok) return { ok: false, code: 'syntax', message: tokenized.message }
  const tokens = tokenized.tokens
  if (tokens.length === 0) {
    return { ok: false, code: 'empty', message: 'Paste an install command, a GitHub repository or a URL.' }
  }

  const commandArguments = stripCommandPrefix(tokens)
  if (commandArguments === 'wrong-subcommand') {
    return {
      ok: false,
      code: 'syntax',
      message: 'Only `skills add` commands install skills. Use `npx skills add <source>`.',
    }
  }
  if (commandArguments === null) {
    // Not a command: exactly one bare source (what people type by hand).
    if (tokens.length !== 1) {
      return {
        ok: false,
        code: 'syntax',
        message: 'Paste one source (owner/repo or a URL) or a full `npx skills add …` command.',
      }
    }
    const source = parseSkillSource(tokens[0]!)
    if (!source.ok) return source
    return {
      ok: true,
      value: {
        kind: 'source',
        source: source.source,
        display: source.display,
        skills: source.skill ? [source.skill] : null,
        providers: null,
        fullDepth: false,
        listOnly: false,
        notices: [],
      },
    }
  }

  let sourceToken: string | null = null
  let skills: string[] | '*' | null = null
  let providers: AgentProviderKind[] | '*' | null = null
  let fullDepth = false
  let listOnly = false
  const notices: string[] = []
  const ignoredAgents: string[] = []

  const addSkills = (values: string[]) => {
    const names = values.flatMap(value => value.split(',')).map(value => value.trim()).filter(Boolean)
    if (names.includes('*')) {
      skills = '*'
      return
    }
    if (skills === '*') return
    skills = [...(skills ?? []), ...names]
  }
  const addAgents = (values: string[]) => {
    const names = values.flatMap(value => value.split(',')).map(value => value.trim()).filter(Boolean)
    if (names.includes('*')) {
      providers = '*'
      return
    }
    if (providers === '*') return
    const next = new Set<AgentProviderKind>(providers ?? [])
    for (const name of names) {
      const provider = AGENT_ALIASES[name.toLowerCase()]
      if (provider) next.add(provider)
      else ignoredAgents.push(name)
    }
    providers = AGENT_PROVIDER_KINDS.filter(kind => next.has(kind))
  }

  for (let index = 0; index < commandArguments.length; index += 1) {
    const token = commandArguments[index]!
    if (!token.startsWith('-') || token === '-') {
      if (sourceToken !== null) {
        return {
          ok: false,
          code: 'syntax',
          message: `Unexpected ${JSON.stringify(token)}. \`skills add\` takes one source; put --skill names after it.`,
        }
      }
      sourceToken = token
      continue
    }
    const [flag, inlineValue] = splitInlineValue(token)
    // WHY variadic flags consume every following non-flag token: that is how
    // `npx skills` (commander `<names...>`) reads `--skill a b c`. Matching
    // it means a pasted line selects exactly what it selects there.
    const takeValues = (): string[] => {
      if (inlineValue !== null) return [inlineValue]
      const values: string[] = []
      while (index + 1 < commandArguments.length && !commandArguments[index + 1]!.startsWith('-')) {
        values.push(commandArguments[index + 1]!)
        index += 1
      }
      return values
    }
    switch (flag) {
      case '-s':
      case '--skill': {
        const values = takeValues()
        if (values.length === 0) return missingValue(flag)
        addSkills(values)
        break
      }
      case '-a':
      case '--agent': {
        const values = takeValues()
        if (values.length === 0) return missingValue(flag)
        addAgents(values)
        break
      }
      case '--all':
        skills = '*'
        providers = '*'
        break
      case '--full-depth':
        fullDepth = true
        break
      case '-l':
      case '--list':
        listOnly = true
        break
      default:
        if (IGNORED_FLAGS.has(flag)) break
        return {
          ok: false,
          code: 'unsupported-flag',
          message: `Agent Code does not understand ${flag}. Supported: --skill, --agent, --all, --full-depth, --list (and -g, -y, --copy, which change nothing here).`,
        }
    }
  }
  if (sourceToken === null) {
    return { ok: false, code: 'syntax', message: 'The command has no source. Use `npx skills add owner/repo`.' }
  }
  const source = parseSkillSource(sourceToken)
  if (!source.ok) return source
  if (source.skill) addSkills([source.skill])
  if (ignoredAgents.length > 0) {
    notices.push(`Not managed by Agent Code, ignored: ${[...new Set(ignoredAgents)].join(', ')}.`)
  }
  if (listOnly) skills = null
  return {
    ok: true,
    value: {
      kind: 'command',
      source: source.source,
      display: source.display,
      skills: Array.isArray(skills) ? dedupeCaseInsensitive(skills) : skills,
      providers,
      fullDepth,
      listOnly,
      notices,
    },
  }
}

type SourceParse =
  | { ok: true; source: SkillInstallGitHubSource; display: string; skill: string | null }
  | { ok: false; code: 'syntax' | 'unsupported-source'; message: string }

/** Every source form `npx skills` accepts, narrowed to what Agent Code can acquire (GitHub). */
export function parseSkillSource(input: string): SourceParse {
  const value = input.trim()
  if (!value) return { ok: false, code: 'syntax', message: 'The source is empty.' }

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || /^(?:www\.)?(?:github\.com|skills\.sh)\//i.test(value)) {
    return parseSourceUrl(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`)
  }
  const ssh = /^git@([^:]+):(.+)$/.exec(value)
  if (ssh) {
    if (ssh[1]!.toLowerCase() !== 'github.com') return unsupportedHost(ssh[1]!)
    return shorthand(ssh[2]!.replace(/\/+$/, ''), value)
  }
  const prefixed = /^([a-z]+):(.+)$/i.exec(value)
  if (prefixed && !/^[A-Za-z]:[\\/]/.test(value)) {
    if (prefixed[1]!.toLowerCase() === 'github') return shorthand(prefixed[2]!, value)
    return unsupportedHost(prefixed[1]!)
  }
  // WHY local paths are refused rather than read: the renderer must never be
  // able to hand main an arbitrary filesystem path (managed-skills Warning).
  // Local import needs a main-owned folder picker, which is a follow-up.
  if (/^(?:\.{1,2}(?:[\\/]|$)|[\\/~]|[A-Za-z]:[\\/])/.test(value)) {
    return {
      ok: false,
      code: 'unsupported-source',
      message: 'Installing from a local folder is not supported yet. Use a GitHub source such as owner/repo.',
    }
  }
  return shorthand(value, value)
}

function shorthand(value: string, original: string): SourceParse {
  let rest = value
  let skill: string | null = null
  let ref: string | undefined
  // `owner/repo#ref@skill` and `owner/repo@skill`, as in source-parser.ts.
  const hash = rest.indexOf('#')
  if (hash >= 0) {
    const fragment = rest.slice(hash + 1)
    rest = rest.slice(0, hash)
    const at = fragment.lastIndexOf('@')
    if (at > 0) {
      skill = fragment.slice(at + 1)
      ref = fragment.slice(0, at)
    } else {
      ref = fragment
    }
    if (!ref) return { ok: false, code: 'syntax', message: 'The #ref in the source is empty.' }
  } else {
    const at = /^([^/]+)\/([^/@]+)@(.+)$/.exec(rest)
    if (at) {
      rest = `${at[1]}/${at[2]}`
      skill = at[3]!
    }
  }
  const segments = rest.split('/').filter(segment => segment.length > 0)
  if (segments.length < 2) {
    return {
      ok: false,
      code: 'syntax',
      message: `${JSON.stringify(original)} is not a source. Use owner/repo, a GitHub URL or an \`npx skills add\` command.`,
    }
  }
  const owner = segments[0]!
  const repository = segments[1]!.replace(/\.git$/, '')
  if (!GITHUB_OWNER.test(owner) || !GITHUB_REPOSITORY.test(repository)) {
    return { ok: false, code: 'syntax', message: 'The GitHub owner or repository name is invalid.' }
  }
  const subpathSegments = segments.slice(2)
  if (subpathSegments.some(segment => !isSafeSegment(segment))) {
    return { ok: false, code: 'syntax', message: 'The path inside the repository is unsafe.' }
  }
  if (skill !== null && !skill.trim()) {
    return { ok: false, code: 'syntax', message: 'The @skill name in the source is empty.' }
  }
  const subpath = subpathSegments.join('/') || undefined
  return {
    ok: true,
    source: { owner, repository, ...(ref ? { ref } : {}), ...(subpath ? { subpath } : {}) },
    display: `${owner}/${repository}${subpath ? `/${subpath}` : ''}${ref ? `#${ref}` : ''}`,
    skill: skill?.trim() ?? null,
  }
}

function parseSourceUrl(value: string): SourceParse {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return { ok: false, code: 'syntax', message: 'That URL is not valid.' }
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, '')
  let segments: string[]
  try {
    segments = url.pathname.split('/').filter(Boolean).map(segment => decodeURIComponent(segment))
  } catch {
    return { ok: false, code: 'syntax', message: 'The URL contains invalid escaping.' }
  }
  if (host === 'skills.sh') {
    // skills.sh/<owner>/<repo>[/<skill>] — the page people copy the command from.
    if (segments.length < 2) {
      return { ok: false, code: 'syntax', message: 'Use a skills.sh skill page URL (skills.sh/owner/repo/skill).' }
    }
    const parsed = shorthand(`${segments[0]}/${segments[1]}`, value)
    if (!parsed.ok) return parsed
    return { ...parsed, skill: segments[2] ?? null }
  }
  if (host !== 'github.com') return unsupportedHost(host)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return unsupportedHost(`${url.protocol}//${host}`)
  if (segments.length < 2) {
    return { ok: false, code: 'syntax', message: 'The GitHub URL must include an owner and repository.' }
  }
  const parsed = shorthand(`${segments[0]}/${segments[1]}`, value)
  if (!parsed.ok) return parsed
  if (segments.length === 2) return parsed
  if (segments[2] !== 'tree' || segments.length < 4) {
    return {
      ok: false,
      code: 'syntax',
      message: 'Use a repository URL or a GitHub /tree/<ref>/<directory> URL.',
    }
  }
  const treeSegments = segments.slice(3)
  if (treeSegments.some(segment => !isSafeSegment(segment))) {
    return { ok: false, code: 'syntax', message: 'The GitHub tree path is unsafe.' }
  }
  return {
    ok: true,
    source: { ...parsed.source, treeSegments },
    display: `${parsed.display}/tree/${treeSegments.join('/')}`,
    skill: null,
  }
}

function unsupportedHost(host: string): SourceParse {
  return {
    ok: false,
    code: 'unsupported-source',
    message: `Agent Code installs skills from GitHub only for now (${host} is not supported). Use owner/repo or a github.com URL.`,
  }
}

function isSafeSegment(segment: string): boolean {
  return segment !== '.'
    && segment !== '..'
    && !segment.includes('\\')
    && !/[\u0000-\u001f\u007f]/.test(segment)
}

/** Returns the arguments after `skills add`, null when the text is not a command. */
function stripCommandPrefix(tokens: string[]): string[] | null | 'wrong-subcommand' {
  let index = 0
  const runner = tokens[0]?.toLowerCase()
  if (runner === 'npx' || runner === 'bunx') {
    index = 1
    // `npx -y skills` / `npx --yes skills`
    while (tokens[index] === '-y' || tokens[index] === '--yes') index += 1
  } else if ((runner === 'pnpm' || runner === 'yarn') && tokens[1] === 'dlx') {
    index = 2
  } else if (runner === 'pnpx') {
    index = 1
  }
  const tool = tokens[index]
  if (!tool || !/^skills(?:@[^\s]+)?$/i.test(tool)) {
    return index === 0 ? null : 'wrong-subcommand'
  }
  const subcommand = tokens[index + 1]?.toLowerCase()
  if (subcommand === undefined) return 'wrong-subcommand'
  if (!['add', 'a', 'install', 'i'].includes(subcommand)) return 'wrong-subcommand'
  return tokens.slice(index + 2)
}

function splitInlineValue(token: string): [string, string | null] {
  if (!token.startsWith('--')) return [token, null]
  const equals = token.indexOf('=')
  return equals < 0 ? [token, null] : [token.slice(0, equals), token.slice(equals + 1)]
}

function missingValue(flag: string): SkillInstallParseResult {
  return { ok: false, code: 'syntax', message: `${flag} needs at least one value.` }
}

function dedupeCaseInsensitive(values: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const key = value.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(value)
  }
  return result
}

/**
 * A POSIX-shell subset: whitespace separation, single and double quotes,
 * backslash escapes and line continuations.
 *
 * WHY expansions and operators are REFUSED rather than ignored: `$VAR`,
 * backticks, `$(…)`, `;`, `&&` and `|` cannot be evaluated faithfully here,
 * and silently dropping them would install something other than what the
 * pasted line means. A clear error is better than a confident wrong guess.
 */
export function tokenizeInstallCommand(
  input: string,
): { ok: true; tokens: string[] } | { ok: false; message: string } {
  const tokens: string[] = []
  let current = ''
  let hasToken = false
  let quote: '"' | "'" | null = null
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!
    if (quote === "'") {
      if (char === "'") quote = null
      else current += char
      continue
    }
    if (char === '\\') {
      const next = input[index + 1]
      if (next === '\n') {
        index += 1
        continue
      }
      if (next === '\r' && input[index + 2] === '\n') {
        index += 2
        continue
      }
      if (next !== undefined) {
        current += next
        hasToken = true
        index += 1
      }
      continue
    }
    if (char === '$' || char === '`') {
      return { ok: false, message: 'Shell variables and command substitution are not supported in install commands.' }
    }
    if (quote === '"') {
      if (char === '"') quote = null
      else current += char
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      hasToken = true
      continue
    }
    if (char === ';' || char === '|' || char === '&' || char === '<' || char === '>') {
      return { ok: false, message: 'Paste one install command, without `;`, `&&`, `|` or redirects.' }
    }
    if (/\s/.test(char)) {
      if (hasToken) tokens.push(current)
      current = ''
      hasToken = false
      continue
    }
    current += char
    hasToken = true
  }
  if (quote) return { ok: false, message: 'The command has an unclosed quote.' }
  if (hasToken) tokens.push(current)
  return { ok: true, tokens }
}

/** Human summary for the Add dialog's "Understood:" line. */
export function describeSkillInstallInput(value: ParsedSkillInstallInput): string {
  const parts = [`source ${value.display}`]
  if (value.skills === '*') parts.push('skills: all')
  else if (value.skills) parts.push(`skills: ${value.skills.join(', ')}`)
  else parts.push('skills: choose')
  if (value.providers === '*') parts.push('agents: all')
  else if (value.providers) parts.push(`agents: ${value.providers.join(', ') || 'none managed here'}`)
  if (value.fullDepth) parts.push('full depth')
  return parts.join(' · ')
}
