import type { AgentProviderKind } from '@shared/types/providerKind.js'
import type {
  AgentCodeConventionsHealth,
  AgentCodeConventionsTargetStatus,
  AgentCodeInstalledSkillFileRecord,
  AgentCodeInstalledSkillSource,
} from './agentCodeConventions.js'

// WHY there is no installed-skill COUNT constant (#1161): the former cap of 25
// was invented here — no provider or the Agent Skills spec limits the number
// of skills. Every remaining limit below bounds one hostile or huge PACKAGE
// (or one network response), never how many packages a user installs. The
// only aggregate ceiling left is the 16 MiB state document, which is
// thousands of skills and fails as a normal I/O error, not recovery.
export const AGENT_CODE_INSTALLED_SKILL_MAX_URL_LENGTH = 2_048
export const AGENT_CODE_INSTALLED_SKILL_MAX_FILES = 256
export const AGENT_CODE_INSTALLED_SKILL_MAX_FILE_BYTES = 5 * 1024 * 1024
export const AGENT_CODE_INSTALLED_SKILL_MAX_TOTAL_BYTES = 10 * 1024 * 1024
export const AGENT_CODE_INSTALLED_SKILL_MAX_DISCOVERY_BYTES = 25 * 1024 * 1024
export const AGENT_CODE_INSTALLED_SKILL_MAX_SKILL_MD_BYTES = 128 * 1024
export const AGENT_CODE_INSTALLED_SKILL_DISCOVERY_TTL_MS = 15 * 60 * 1_000
// WHY 512 and not the former 5: this bounds in-memory review state, not how
// many skills a user may have. After lazy acquisition (#1161) a staged
// discovery holds tree metadata and SKILL.md text only, and "Check updates"
// stages one discovery per installed source — at 5, most update reviews
// expired before the user could open them. TTL eviction runs first.
export const AGENT_CODE_INSTALLED_SKILL_MAX_STAGED_DISCOVERIES = 512

export function isSafeAgentCodeInstalledSkillPath(value: unknown): value is string {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > 1_024
    || value.startsWith('/')
    || value.includes('\\')) return false
  return value.split('/').every(segment => {
    if (segment.length === 0
      || segment === '.'
      || segment === '..'
      || segment.toLowerCase() === '.git'
      || /[\u0000-\u001f\u007f<>:"|?*]/.test(segment)
      || /[. ]$/.test(segment)
      // WHY component bytes are bounded in the portable contract rather than
      // left to the current host: Git can represent names that a supported
      // provider filesystem cannot materialize. Rejecting them during review
      // prevents an accepted package from becoming an install-time surprise.
      || new TextEncoder().encode(segment.normalize('NFC')).byteLength > 255) return false
    // WHY Windows device names are rejected even when discovery runs on Unix:
    // the immutable source identity is supposed to be portable across Agent
    // Code installations. Accepting a package that can never materialize on a
    // supported platform would defer a deterministic validation error until
    // after the user has reviewed and installed it.
    return !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(segment)
  })
}

export function agentCodeInstalledSkillPathCollisionKey(value: string): string {
  // WHY both normalization and case folding are required: Git paths are byte
  // identities, while default macOS and Windows filesystems collapse canonical
  // Unicode spellings and/or case. The importer promises portability, so two
  // paths that could name one provider file must be rejected before review.
  return value.split('/').map(segment => segment.normalize('NFC').toLowerCase()).join('/')
}

export function findAgentCodeInstalledSkillPathCollision(
  paths: string[],
): { left: string; right: string } | null {
  // WHY this tracks both files and implied parent directories: exact-key
  // checks miss the equally destructive `Foo` + `foo/bar.txt` case. Git can
  // store both paths, but a case-insensitive provider filesystem would need
  // the same normalized name to be a file and a directory at once.
  const files = new Map<string, string>()
  const parents = new Map<string, string>()
  for (const path of paths) {
    const key = agentCodeInstalledSkillPathCollisionKey(path)
    const exact = files.get(key)
    if (exact) return { left: exact, right: path }
    const descendant = parents.get(key)
    if (descendant) return { left: descendant, right: path }
    const segments = key.split('/')
    let parent = ''
    for (const segment of segments.slice(0, -1)) {
      parent = parent ? `${parent}/${segment}` : segment
      const parentFile = files.get(parent)
      if (parentFile) return { left: parentFile, right: path }
      if (!parents.has(parent)) parents.set(parent, path)
    }
    files.set(key, path)
  }
  return null
}

export function compareAgentCodeInstalledSkillPaths(left: string, right: string): number {
  // localeCompare intentionally does not define manifest identity: its result
  // changes with locale and treats some distinct Git paths as equal. UTF-16
  // ordinal order is deterministic in every process that reads persisted state.
  return left === right ? 0 : left < right ? -1 : 1
}

/**
 * One file of a package under review.
 *
 * WHY review files carry no sha256 (#1161): discovery now builds the review
 * from the commit TREE and downloads only each candidate's SKILL.md, so a
 * 200-skill collection no longer spends its budget downloading packages
 * nobody selected. The tree's Git blob object id is the identity the review
 * binds to; acquisition verifies every downloaded byte against it, and the
 * sha256 manifest is computed only once the package is acquired.
 */
export type AgentCodeInstalledSkillReviewFile = Pick<
  AgentCodeInstalledSkillFileRecord,
  'path' | 'bytes' | 'executable'
>

export type AgentCodeInstalledSkillCandidate = {
  candidateId: string
  name: string
  description: string
  source: AgentCodeInstalledSkillSource
  files: AgentCodeInstalledSkillReviewFile[]
  totalBytes: number
  warnings: string[]
  /**
   * `metadata.internal: true` in SKILL.md. Hidden from browsing (as `npx
   * skills` hides it) and listed only when the user names it explicitly.
   */
  internal?: boolean
}

/** What main understood from the pasted command, echoed back for the dialog. */
export type AgentCodeInstalledSkillSelection = {
  display: string
  skills: string[] | '*' | null
  providers: AgentProviderKind[] | '*' | null
  fullDepth: boolean
  listOnly: boolean
}

export type AgentCodeInstalledSkillDiscovery = {
  discoveryId: string
  repositoryUrl: string
  requestedRef: string
  requestedRefType: 'branch' | 'tag'
  resolvedCommit: string
  expiresAt: string
  candidates: AgentCodeInstalledSkillCandidate[]
  notices: string[]
  /** `--skill` names that matched no skill in the source. */
  missingSkills: string[]
  selection: AgentCodeInstalledSkillSelection
}

export type AgentCodeInstalledSkillDiscoveryResult =
  | { ok: true; discovery: AgentCodeInstalledSkillDiscovery }
  | {
      ok: false
      code: 'validation' | 'not-found' | 'git-unavailable' | 'network' | 'io-error'
      message: string
    }

export type AgentCodeInstalledSkill = {
  id: string
  name: string
  description: string
  enabled: boolean
  source: AgentCodeInstalledSkillSource
  snapshotDigest: string
  files: AgentCodeInstalledSkillFileRecord[]
  totalBytes: number
  warnings: string[]
  /** Providers whose agents get it (#1161); absent means every provider. */
  providers?: AgentProviderKind[]
  /** An agent proposed it; it stays off until the user reviews and enables it. */
  pendingReview?: { by: 'agent'; sessionId: string; requestedAt: string }
  createdAt: string
  updatedAt: string
  health: AgentCodeConventionsHealth
  targets: AgentCodeConventionsTargetStatus[]
}

export type AgentCodeInstalledSkillsSnapshot = {
  revision: number
  skills: AgentCodeInstalledSkill[]
  unsupportedProviders: AgentProviderKind[]
  recovery?: { message: string; stateFilePath: string }
}

export type InstallAgentCodeGitHubSkillsRequest = {
  expectedRevision: number
  discoveryId: string
  candidateIds: string[]
  /**
   * Providers whose agents get these skills (from `-a` or the dialog).
   * Absent means every provider that supports personal skills.
   */
  providers?: AgentProviderKind[]
}

export type SetAgentCodeInstalledSkillProvidersRequest = {
  expectedRevision: number
  skillId: string
  /** null restores "every supporting provider". */
  providers: AgentProviderKind[] | null
}

export type SetAgentCodeInstalledSkillEnabledRequest = {
  expectedRevision: number
  skillId: string
  enabled: boolean
}

export type DeleteAgentCodeInstalledSkillRequest = {
  expectedRevision: number
  skillId: string
  abandonTargets?: Array<{
    targetId: string
    expectedConflictFingerprint: string
  }>
}

export type ApplyAgentCodeInstalledSkillUpdateRequest = {
  expectedRevision: number
  skillId: string
  discoveryId: string
  candidateId: string
}

export type AgentCodeInstalledSkillFileChanges = {
  added: string[]
  changed: string[]
  removed: string[]
}

export type AgentCodeInstalledSkillUpdateResult =
  | { ok: true; kind: 'up-to-date' }
  | {
      ok: true
      kind: 'update-available'
      discovery: AgentCodeInstalledSkillDiscovery
      candidate: AgentCodeInstalledSkillCandidate
      changes: AgentCodeInstalledSkillFileChanges
    }
  | {
      ok: false
      code: 'validation' | 'not-found' | 'git-unavailable' | 'network' | 'io-error'
      message: string
    }

export type AgentCodeInstalledSkillsMutationResult =
  | { ok: true; snapshot: AgentCodeInstalledSkillsSnapshot }
  | { ok: false; code: 'validation' | 'expired'; message: string }
  // Acquiring the reviewed bytes happens before the mutation (#1161) and can
  // fail on the network or on a blob that no longer matches the review.
  | {
      ok: false
      code: 'acquisition'
      reason: 'validation' | 'not-found' | 'git-unavailable' | 'network' | 'io-error'
      message: string
    }
  | { ok: false; code: 'revision-conflict'; snapshot: AgentCodeInstalledSkillsSnapshot }
  | {
      ok: false
      code: 'target-conflict' | 'delete-blocked'
      message: string
      snapshot: AgentCodeInstalledSkillsSnapshot
      targets: AgentCodeConventionsTargetStatus[]
    }
  | { ok: false; code: 'unsupported'; snapshot: AgentCodeInstalledSkillsSnapshot }
  | { ok: false; code: 'recovery-required'; snapshot: AgentCodeInstalledSkillsSnapshot }
  | { ok: false; code: 'not-found'; message: string; snapshot: AgentCodeInstalledSkillsSnapshot }
  | { ok: false; code: 'io-error'; message: string; snapshot: AgentCodeInstalledSkillsSnapshot }
