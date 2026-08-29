import { createHash } from 'node:crypto'
import { dirname, isAbsolute } from 'path'
import { mkdir, unlink } from 'fs/promises'

import { atomicWriteTextFile, readBoundedTextFile } from '@main/editorFileIO.js'
import {
  AGENT_CODE_CONVENTIONS_LEGACY_SCHEMA_VERSION,
  AGENT_CODE_CONVENTIONS_PREVIOUS_SCHEMA_VERSION,
  AGENT_CODE_CONVENTIONS_SCHEMA_VERSION,
  AGENT_CODE_CONVENTIONS_STATE_MAX_BYTES,
  createEmptyAgentCodeConventionsDocument,
  type AgentCodeConventionsDocument,
  type AgentCodeConventionsMaterialization,
  type AgentCodeConventionsPendingOperation,
  type AgentCodeCustomSkillRecord,
  type AgentCodeInstalledSkillFileRecord,
  type AgentCodeInstalledSkillMaterialization,
  type AgentCodeInstalledSkillPendingOperation,
  type AgentCodeInstalledSkillRecord,
} from '@shared/types/agentCodeConventions.js'
import {
  AGENT_CODE_INSTALLED_SKILL_MAX_COUNT,
  AGENT_CODE_INSTALLED_SKILL_MAX_FILES,
  AGENT_CODE_INSTALLED_SKILL_MAX_FILE_BYTES,
  AGENT_CODE_INSTALLED_SKILL_MAX_TOTAL_BYTES,
  AGENT_CODE_INSTALLED_SKILL_MAX_URL_LENGTH,
  compareAgentCodeInstalledSkillPaths,
  findAgentCodeInstalledSkillPathCollision,
  isSafeAgentCodeInstalledSkillPath,
} from '@shared/types/agentCodeInstalledSkills.js'

export type AgentCodeConventionsStateReadResult =
  | { kind: 'ok'; document: AgentCodeConventionsDocument }
  | {
      kind: 'recovery-required'
      document: AgentCodeConventionsDocument
      message: string
      stateFilePath: string
    }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isMaterialization(value: unknown): value is AgentCodeConventionsMaterialization {
  return isRecord(value)
    && typeof value.path === 'string'
    && isAbsolute(value.path)
    && typeof value.sha256 === 'string'
    && /^[a-f0-9]{64}$/.test(value.sha256)
    && (value.skillId === undefined || typeof value.skillId === 'string')
    && (value.targetId === undefined || typeof value.targetId === 'string')
    && ((value.skillId === undefined) === (value.targetId === undefined))
}

function isPendingOperation(value: unknown): value is AgentCodeConventionsPendingOperation {
  if (!isRecord(value)) return false
  return typeof value.operationId === 'string'
    && typeof value.targetId === 'string'
    && typeof value.path === 'string'
    && isAbsolute(value.path)
    && (value.kind === 'write' || value.kind === 'delete')
    && (value.previousSha256 === null || (
      typeof value.previousSha256 === 'string' && /^[a-f0-9]{64}$/.test(value.previousSha256)
    ))
    && (value.desiredSha256 === null || (
      typeof value.desiredSha256 === 'string' && /^[a-f0-9]{64}$/.test(value.desiredSha256)
    ))
    && (value.expectedConflictFingerprint === undefined
      || (typeof value.expectedConflictFingerprint === 'string'
        && /^[a-f0-9]{64}$/.test(value.expectedConflictFingerprint)))
    && (value.skillId === undefined || typeof value.skillId === 'string')
}

function isCustomSkill(value: unknown): value is AgentCodeCustomSkillRecord {
  return isRecord(value)
    && typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 256
    && typeof value.name === 'string'
    && value.name.length <= 64
    && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.name)
    && value.name !== 'agent-code-conventions'
    && typeof value.description === 'string'
    && value.description.length > 0
    && value.description.length <= 1_024
    && !/[\r\n\0]/.test(value.description)
    && typeof value.markdown === 'string'
    && !value.markdown.includes('\0')
    && Buffer.byteLength(value.markdown, 'utf8') <= 32 * 1024
    && typeof value.enabled === 'boolean'
    && typeof value.createdAt === 'string'
    && typeof value.updatedAt === 'string'
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function isInstalledFile(value: unknown): value is AgentCodeInstalledSkillFileRecord {
  return isRecord(value)
    && isSafeAgentCodeInstalledSkillPath(value.path)
    && Number.isSafeInteger(value.bytes)
    && Number(value.bytes) >= 0
    && Number(value.bytes) <= AGENT_CODE_INSTALLED_SKILL_MAX_FILE_BYTES
    && isSha256(value.sha256)
    && typeof value.executable === 'boolean'
}

function isInstalledFileManifest(value: unknown): value is AgentCodeInstalledSkillFileRecord[] {
  if (!Array.isArray(value)
    || value.length === 0
    || value.length > AGENT_CODE_INSTALLED_SKILL_MAX_FILES
    || !value.every(isInstalledFile)) return false
  const paths = value.map(file => file.path)
  const totalBytes = value.reduce((total, file) => total + file.bytes, 0)
  return paths.includes('SKILL.md')
    && new Set(paths).size === paths.length
    && findAgentCodeInstalledSkillPathCollision(paths) === null
    && paths.every((path, index) => index === 0
      || compareAgentCodeInstalledSkillPaths(value[index - 1]!.path, path) < 0)
    && totalBytes <= AGENT_CODE_INSTALLED_SKILL_MAX_TOTAL_BYTES
}

function isInstalledSource(value: unknown): value is AgentCodeInstalledSkillRecord['source'] {
  return isRecord(value)
    && typeof value.owner === 'string' && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(value.owner)
    && typeof value.repository === 'string'
    && value.repository.length > 0 && value.repository.length <= 100
    && /^[A-Za-z0-9_.-]+$/.test(value.repository)
    && typeof value.repositoryUrl === 'string'
    && value.repositoryUrl.length <= AGENT_CODE_INSTALLED_SKILL_MAX_URL_LENGTH
    && typeof value.requestedRef === 'string'
    && value.requestedRef.length > 0 && value.requestedRef.length <= 512
    && (value.requestedRefType === 'branch' || value.requestedRefType === 'tag')
    && typeof value.path === 'string'
    && (value.path === '' || isSafeAgentCodeInstalledSkillPath(value.path))
    && typeof value.skillUrl === 'string'
    && value.skillUrl.length <= AGENT_CODE_INSTALLED_SKILL_MAX_URL_LENGTH
    && typeof value.resolvedCommit === 'string'
    && /^[a-f0-9]{40}$/.test(value.resolvedCommit)
    && hasCanonicalInstalledSourceUrls(value)
}

function hasCanonicalInstalledSourceUrls(value: Record<string, unknown>): boolean {
  if (typeof value.owner !== 'string'
    || typeof value.repository !== 'string'
    || typeof value.requestedRef !== 'string'
    || typeof value.path !== 'string'
    || typeof value.repositoryUrl !== 'string'
    || typeof value.skillUrl !== 'string') return false
  const repositoryUrl = `https://github.com/${value.owner}/${value.repository}`
  const encodedRef = value.requestedRef.split('/').map(encodeURIComponent).join('/')
  const encodedPath = value.path.split('/').filter(Boolean).map(encodeURIComponent).join('/')
  const skillUrl = `${repositoryUrl}/tree/${encodedRef}${encodedPath ? `/${encodedPath}` : ''}`
  return value.repositoryUrl === repositoryUrl && value.skillUrl === skillUrl
}

function isInstalledSkill(value: unknown): value is AgentCodeInstalledSkillRecord {
  return isRecord(value)
    && typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 256
    && typeof value.name === 'string'
    && value.name.length <= 64
    && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.name)
    && isSafeAgentCodeInstalledSkillPath(value.name)
    && value.name !== 'agent-code-conventions'
    && typeof value.description === 'string'
    && value.description.length > 0 && value.description.length <= 1_024
    && !/[\r\n\0]/.test(value.description)
    && typeof value.enabled === 'boolean'
    && isInstalledSource(value.source)
    && isSha256(value.snapshotDigest)
    && isInstalledFileManifest(value.files)
    && installedManifestDigest(value.files) === value.snapshotDigest
    && Array.isArray(value.warnings)
    && value.warnings.length <= 32
    && value.warnings.every(warning => typeof warning === 'string' && warning.length <= 2_048)
    && typeof value.createdAt === 'string'
    && typeof value.updatedAt === 'string'
}

function isInstalledMaterialization(
  value: unknown,
): value is AgentCodeInstalledSkillMaterialization {
  return isRecord(value)
    && typeof value.skillId === 'string'
    && typeof value.targetId === 'string'
    && typeof value.path === 'string'
    && isAbsolute(value.path)
    && isSha256(value.snapshotDigest)
    && isInstalledFileManifest(value.files)
    && installedManifestDigest(value.files) === value.snapshotDigest
}

function isInstalledPendingOperation(
  value: unknown,
): value is AgentCodeInstalledSkillPendingOperation {
  if (!isRecord(value)) return false
  if (!(typeof value.operationId === 'string'
    && typeof value.skillId === 'string'
    && typeof value.targetId === 'string'
    && typeof value.path === 'string'
    && isAbsolute(value.path)
    && (value.kind === 'sync' || value.kind === 'delete')
    && (value.previousSnapshotDigest === null || isSha256(value.previousSnapshotDigest))
    && isInstalledFileManifestOrEmpty(value.previousFiles)
    && (value.desiredSnapshotDigest === null || isSha256(value.desiredSnapshotDigest))
    && isInstalledFileManifestOrEmpty(value.desiredFiles))) return false
  const previousMatches = value.previousSnapshotDigest === null
    ? value.previousFiles.length === 0
    : value.previousFiles.length > 0
      && installedManifestDigest(value.previousFiles) === value.previousSnapshotDigest
  const desiredMatches = value.desiredSnapshotDigest === null
    ? value.desiredFiles.length === 0
    : value.desiredFiles.length > 0
      && installedManifestDigest(value.desiredFiles) === value.desiredSnapshotDigest
  return previousMatches
    && desiredMatches
    && (value.kind === 'sync' ? value.desiredSnapshotDigest !== null : value.desiredSnapshotDigest === null)
}

function isInstalledFileManifestOrEmpty(value: unknown): value is AgentCodeInstalledSkillFileRecord[] {
  return (Array.isArray(value) && value.length === 0) || isInstalledFileManifest(value)
}

function installedManifestDigest(files: AgentCodeInstalledSkillFileRecord[]): string {
  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(file.path)
    hash.update('\0')
    hash.update(file.sha256)
    hash.update('\0')
    hash.update(file.executable ? '1' : '0')
    hash.update('\0')
  }
  return hash.digest('hex')
}

function recoverReadableFields(value: unknown): AgentCodeConventionsDocument {
  const recovered = createEmptyAgentCodeConventionsDocument()
  if (!isRecord(value)) return recovered
  if (Number.isSafeInteger(value.revision) && Number(value.revision) >= 0) {
    recovered.revision = Number(value.revision)
  }
  if (typeof value.enabled === 'boolean') recovered.enabled = value.enabled
  if (typeof value.markdown === 'string') recovered.markdown = value.markdown
  if (typeof value.updatedAt === 'string' || value.updatedAt === null) {
    recovered.updatedAt = value.updatedAt
  }
  if (isRecord(value.customSkills)) {
    for (const [key, entry] of Object.entries(value.customSkills)) {
      if (isCustomSkill(entry) && entry.id === key) recovered.customSkills[key] = entry
    }
  }
  if (isRecord(value.installedSkills)) {
    for (const [key, entry] of Object.entries(value.installedSkills)) {
      if (isInstalledSkill(entry) && entry.id === key) recovered.installedSkills[key] = entry
    }
  }
  if (isRecord(value.materializations)) {
    for (const [key, entry] of Object.entries(value.materializations)) {
      if (isMaterialization(entry)) recovered.materializations[key] = entry
    }
  }
  if (isRecord(value.pendingOperations)) {
    for (const [key, entry] of Object.entries(value.pendingOperations)) {
      if (isPendingOperation(entry)) recovered.pendingOperations[key] = entry
    }
  }
  if (isRecord(value.installedMaterializations)) {
    for (const [key, entry] of Object.entries(value.installedMaterializations)) {
      if (isInstalledMaterialization(entry)) recovered.installedMaterializations[key] = entry
    }
  }
  if (isRecord(value.installedPendingOperations)) {
    for (const [key, entry] of Object.entries(value.installedPendingOperations)) {
      if (isInstalledPendingOperation(entry)) recovered.installedPendingOperations[key] = entry
    }
  }
  return recovered
}

function parseDocument(value: unknown): AgentCodeConventionsDocument | null {
  if (!isRecord(value)) return null
  if (value.schemaVersion !== AGENT_CODE_CONVENTIONS_SCHEMA_VERSION) return null
  if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 0) return null
  if (typeof value.enabled !== 'boolean' || typeof value.markdown !== 'string') return null
  if (!(typeof value.updatedAt === 'string' || value.updatedAt === null)) return null
  if (!isRecord(value.customSkills)
    || !isRecord(value.materializations)
    || !isRecord(value.pendingOperations)
    || !isRecord(value.installedSkills)
    || !isRecord(value.installedMaterializations)
    || !isRecord(value.installedPendingOperations)) return null
  if (!Object.entries(value.customSkills).every(([key, entry]) =>
    isCustomSkill(entry) && entry.id === key)) return null
  const names = Object.values(value.customSkills).map(entry =>
    (entry as AgentCodeCustomSkillRecord).name)
  if (new Set(names).size !== names.length) return null
  if (Object.keys(value.installedSkills).length > AGENT_CODE_INSTALLED_SKILL_MAX_COUNT) return null
  if (!Object.entries(value.installedSkills).every(([key, entry]) =>
    isInstalledSkill(entry) && entry.id === key)) return null
  const installedNames = Object.values(value.installedSkills).map(entry =>
    (entry as AgentCodeInstalledSkillRecord).name)
  if (new Set(installedNames).size !== installedNames.length) return null
  if (installedNames.some(name => names.includes(name))) return null
  if (!Object.values(value.materializations).every(isMaterialization)) return null
  if (!Object.values(value.pendingOperations).every(isPendingOperation)) return null
  if (!Object.values(value.installedMaterializations).every(isInstalledMaterialization)) return null
  if (!Object.values(value.installedPendingOperations).every(isInstalledPendingOperation)) return null
  return value as AgentCodeConventionsDocument
}

function migratePreviousDocument(value: unknown): AgentCodeConventionsDocument | null {
  if (!isRecord(value) || value.schemaVersion !== AGENT_CODE_CONVENTIONS_PREVIOUS_SCHEMA_VERSION) {
    return null
  }
  if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 0) return null
  if (typeof value.enabled !== 'boolean' || typeof value.markdown !== 'string') return null
  if (!(typeof value.updatedAt === 'string' || value.updatedAt === null)) return null
  if (!isRecord(value.customSkills)
    || !Object.entries(value.customSkills).every(([key, entry]) =>
      isCustomSkill(entry) && entry.id === key)) return null
  if (!isRecord(value.materializations)
    || !Object.values(value.materializations).every(isMaterialization)) return null
  if (!isRecord(value.pendingOperations)
    || !Object.values(value.pendingOperations).every(isPendingOperation)) return null

  // WHY imported package maps are added empty rather than inferred from files
  // on disk: v2 explicitly treated every external/package skill as unmanaged.
  // Migration must not convert filesystem presence into write/delete authority.
  return {
    schemaVersion: AGENT_CODE_CONVENTIONS_SCHEMA_VERSION,
    revision: Number(value.revision),
    enabled: value.enabled,
    markdown: value.markdown,
    updatedAt: value.updatedAt,
    customSkills: value.customSkills as AgentCodeConventionsDocument['customSkills'],
    installedSkills: {},
    materializations: value.materializations as AgentCodeConventionsDocument['materializations'],
    pendingOperations: value.pendingOperations as AgentCodeConventionsDocument['pendingOperations'],
    installedMaterializations: {},
    installedPendingOperations: {},
  }
}

function migrateLegacyDocument(value: unknown): AgentCodeConventionsDocument | null {
  if (!isRecord(value) || value.schemaVersion !== AGENT_CODE_CONVENTIONS_LEGACY_SCHEMA_VERSION) {
    return null
  }
  if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 0) return null
  if (typeof value.enabled !== 'boolean' || typeof value.markdown !== 'string') return null
  if (!(typeof value.updatedAt === 'string' || value.updatedAt === null)) return null
  if (!isRecord(value.materializations) || !isRecord(value.pendingOperations)) return null
  if (!Object.values(value.materializations).every(isMaterialization)) return null
  if (!Object.values(value.pendingOperations).every(isPendingOperation)) return null

  // WHY migration is pure and keeps legacy ownership keys unchanged: those
  // keys are part of the proof tying a historical provider path to the
  // Conventions artifact. Re-keying during parsing would make recovery depend
  // on new code before the original evidence has even been audited.
  return {
    schemaVersion: AGENT_CODE_CONVENTIONS_SCHEMA_VERSION,
    revision: Number(value.revision),
    enabled: value.enabled,
    markdown: value.markdown,
    updatedAt: value.updatedAt,
    customSkills: {},
    installedSkills: {},
    materializations: value.materializations as AgentCodeConventionsDocument['materializations'],
    pendingOperations: value.pendingOperations as AgentCodeConventionsDocument['pendingOperations'],
    installedMaterializations: {},
    installedPendingOperations: {},
  }
}

export async function readAgentCodeConventionsState(
  stateFilePath: string,
): Promise<AgentCodeConventionsStateReadResult> {
  let text: string
  try {
    text = (await readBoundedTextFile(
      stateFilePath,
      AGENT_CODE_CONVENTIONS_STATE_MAX_BYTES,
    )).text
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { kind: 'ok', document: createEmptyAgentCodeConventionsDocument() }
    }
    return {
      kind: 'recovery-required',
      document: createEmptyAgentCodeConventionsDocument(),
      message: `Agent Code could not safely read managed skill state: ${safeErrorMessage(error)}`,
      stateFilePath,
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return {
      kind: 'recovery-required',
      document: createEmptyAgentCodeConventionsDocument(),
      message: 'Managed skill state is not valid JSON. The original file was preserved.',
      stateFilePath,
    }
  }
  const document = parseDocument(parsed)
    ?? migratePreviousDocument(parsed)
    ?? migrateLegacyDocument(parsed)
  if (document) return { kind: 'ok', document }
  return {
    kind: 'recovery-required',
    document: recoverReadableFields(parsed),
    message: 'Managed skill state uses an unsupported or unsafe shape. The original file was preserved.',
    stateFilePath,
  }
}

export async function writeAgentCodeConventionsState(
  stateFilePath: string,
  document: AgentCodeConventionsDocument,
): Promise<void> {
  await mkdir(dirname(stateFilePath), { recursive: true, mode: 0o700 })
  const result = await atomicWriteTextFile({
    absolutePath: stateFilePath,
    text: `${JSON.stringify(document, null, 2)}\n`,
    maxBytes: AGENT_CODE_CONVENTIONS_STATE_MAX_BYTES,
    // Canonical conventions may contain sensitive working practices. Unlike
    // editor saves, this app-owned state has a fixed private permission policy
    // even when repairing a pre-existing permissive file.
    mode: 0o600,
  })
  if (!result.ok) throw new Error('Managed skill state changed during atomic write')
}

export async function resetAgentCodeConventionsState(stateFilePath: string): Promise<void> {
  // Recovery reset is deliberately exact-file only. It never walks STATE_DIR,
  // where unrelated workspace, incident, and credential state also lives.
  await unlink(stateFilePath).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  })
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return 'unknown filesystem error'
}
