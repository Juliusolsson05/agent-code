import type { AgentProviderKind } from '@shared/types/providerKind.js'

// See docs/design/agent-code-conventions.md for the canonical subsystem design.

export const AGENT_CODE_CONVENTIONS_SCHEMA_VERSION = 3 as const
export const AGENT_CODE_CONVENTIONS_PREVIOUS_SCHEMA_VERSION = 2 as const
export const AGENT_CODE_CONVENTIONS_LEGACY_SCHEMA_VERSION = 1 as const
export const AGENT_CODE_CONVENTIONS_SKILL_NAME = 'agent-code-conventions'
export const AGENT_CODE_CONVENTIONS_MANAGED_MARKER = '<!-- agent-code-managed:v1 -->'
export const AGENT_CODE_CONVENTIONS_MAX_BYTES = 32 * 1024
export const AGENT_CODE_CONVENTIONS_COLLISION_MAX_BYTES = 128 * 1024
// Custom and installed skills share this app-owned document with Conventions.
// Installed package bytes stay outside JSON, but their bounded path/hash
// manifests can legitimately exceed the old 4 MiB collection ceiling when a
// user installs several large multi-file packages. Keep recovery reads bounded
// without making valid state impossible to persist near the advertised limits.
export const AGENT_CODE_CONVENTIONS_STATE_MAX_BYTES = 16 * 1024 * 1024

export const AGENT_CODE_CONVENTIONS_STARTER = `# Development workflow

- Read repository-local instructions before changing files.
- Keep changes scoped to the request.
- Run relevant checks before reporting completion.
- Explain non-obvious decisions and constraints.

# Git

- Do not create commits unless explicitly asked.
- Use Conventional Commits: \`type(scope): imperative summary\`.
- Keep commit subjects concise and explain rationale in the body when needed.`

export type AgentCodeConventionsHealth =
  | 'disabled'
  | 'active'
  | 'degraded'
  | 'conflict'
  | 'unsupported'
  | 'recovery-required'

export type AgentCodeConventionsTargetState =
  | 'installed'
  | 'missing'
  | 'conflict'
  | 'error'
  | 'not-installed'
  | 'unsupported'
  | 'retired'

export type AgentCodeConventionsTargetStatus = {
  id: string
  providers: AgentProviderKind[]
  displayPath: string
  state: AgentCodeConventionsTargetState
  message?: string
  canOverwrite?: boolean
  /**
   * Opaque compare token for the exact external bytes the user reviewed.
   * The renderer must return it unchanged; it is never a path or authority on
   * its own, and main rechecks it while holding the mutation lock.
   */
  conflictFingerprint?: string
}

export type AgentCodeConventionsSnapshot = {
  revision: number
  enabled: boolean
  markdown: string
  updatedAt: string | null
  health: AgentCodeConventionsHealth
  warnings: string[]
  unsupportedProviders: AgentProviderKind[]
  recovery?: { message: string; stateFilePath: string }
  targets: AgentCodeConventionsTargetStatus[]
}

export type AgentCodeConventionsConflictResolution = {
  targetId: string
  expectedConflictFingerprint: string
}

export type SaveAgentCodeConventionsRequest = {
  expectedRevision: number
  enabled: boolean
  markdown: string
  overwriteTargets?: AgentCodeConventionsConflictResolution[]
}

export type ClearAgentCodeConventionsRequest = {
  expectedRevision: number
  abandonTargets?: AgentCodeConventionsConflictResolution[]
}

export type AgentCodeConventionsMutationResult =
  | { ok: true; snapshot: AgentCodeConventionsSnapshot }
  | { ok: false; code: 'validation'; message: string; warnings?: string[] }
  | { ok: false; code: 'revision-conflict'; snapshot: AgentCodeConventionsSnapshot }
  | { ok: false; code: 'target-conflict'; snapshot: AgentCodeConventionsSnapshot }
  | { ok: false; code: 'clear-blocked'; snapshot: AgentCodeConventionsSnapshot }
  | { ok: false; code: 'unsupported'; snapshot: AgentCodeConventionsSnapshot }
  | { ok: false; code: 'recovery-required'; snapshot: AgentCodeConventionsSnapshot }
  | {
      ok: false
      code: 'io-error'
      message: string
      snapshot: AgentCodeConventionsSnapshot
    }

export type AgentCodeConventionsPreviewResult =
  | {
      ok: true
      renderedSkill: string
      warnings: string[]
      counts: AgentCodeConventionsTextCounts
    }
  | { ok: false; code: 'validation'; message: string; warnings?: string[] }

export type AgentCodeConventionsTextCounts = {
  bytes: number
  characters: number
  lines: number
}

export type AgentCodeConventionsMaterialization = {
  path: string
  sha256: string
  /**
   * V1 records omit identity because every artifact was Conventions. V2 custom
   * records carry both fields so an opaque collection key never becomes the
   * source of deletion authority.
   */
  skillId?: string
  targetId?: string
}

export type AgentCodeConventionsPendingOperation = {
  operationId: string
  targetId: string
  path: string
  kind: 'write' | 'delete'
  previousSha256: string | null
  desiredSha256: string | null
  /**
   * An overwrite prompt approves one observed collision, not a pathname for
   * all time. Persisting the fingerprint keeps crash recovery from broadening
   * that one approval into permission to replace later external edits.
   */
  expectedConflictFingerprint?: string
  skillId?: string
}

export type AgentCodeCustomSkillRecord = {
  id: string
  name: string
  description: string
  markdown: string
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export type AgentCodeInstalledSkillFileRecord = {
  /** POSIX-style path relative to the skill package root. */
  path: string
  bytes: number
  sha256: string
  executable: boolean
}

export type AgentCodeInstalledSkillSource = {
  owner: string
  repository: string
  repositoryUrl: string
  requestedRef: string
  requestedRefType: 'branch' | 'tag'
  path: string
  skillUrl: string
  resolvedCommit: string
}

export type AgentCodeInstalledSkillRecord = {
  id: string
  name: string
  description: string
  enabled: boolean
  source: AgentCodeInstalledSkillSource
  snapshotDigest: string
  files: AgentCodeInstalledSkillFileRecord[]
  warnings: string[]
  createdAt: string
  updatedAt: string
}

export type AgentCodeInstalledSkillMaterialization = {
  skillId: string
  targetId: string
  path: string
  snapshotDigest: string
  files: AgentCodeInstalledSkillFileRecord[]
}

export type AgentCodeInstalledSkillPendingOperation = {
  operationId: string
  skillId: string
  targetId: string
  path: string
  kind: 'sync' | 'delete'
  previousSnapshotDigest: string | null
  previousFiles: AgentCodeInstalledSkillFileRecord[]
  desiredSnapshotDigest: string | null
  desiredFiles: AgentCodeInstalledSkillFileRecord[]
}

export type AgentCodeConventionsDocument = {
  schemaVersion: typeof AGENT_CODE_CONVENTIONS_SCHEMA_VERSION
  revision: number
  enabled: boolean
  markdown: string
  updatedAt: string | null
  customSkills: Record<string, AgentCodeCustomSkillRecord>
  installedSkills: Record<string, AgentCodeInstalledSkillRecord>
  materializations: Record<string, AgentCodeConventionsMaterialization>
  pendingOperations: Record<string, AgentCodeConventionsPendingOperation>
  installedMaterializations: Record<string, AgentCodeInstalledSkillMaterialization>
  installedPendingOperations: Record<string, AgentCodeInstalledSkillPendingOperation>
}

export function createEmptyAgentCodeConventionsDocument(): AgentCodeConventionsDocument {
  return {
    schemaVersion: AGENT_CODE_CONVENTIONS_SCHEMA_VERSION,
    revision: 0,
    enabled: false,
    markdown: '',
    updatedAt: null,
    customSkills: {},
    installedSkills: {},
    materializations: {},
    pendingOperations: {},
    installedMaterializations: {},
    installedPendingOperations: {},
  }
}
