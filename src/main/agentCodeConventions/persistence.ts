import { dirname, isAbsolute } from 'path'
import { mkdir, unlink } from 'fs/promises'

import { atomicWriteTextFile, readBoundedTextFile } from '@main/editorFileIO.js'
import {
  AGENT_CODE_CONVENTIONS_LEGACY_SCHEMA_VERSION,
  AGENT_CODE_CONVENTIONS_SCHEMA_VERSION,
  AGENT_CODE_CONVENTIONS_STATE_MAX_BYTES,
  createEmptyAgentCodeConventionsDocument,
  type AgentCodeConventionsDocument,
  type AgentCodeConventionsMaterialization,
  type AgentCodeConventionsPendingOperation,
  type AgentCodeCustomSkillRecord,
} from '@shared/types/agentCodeConventions.js'

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
    || !isRecord(value.pendingOperations)) return null
  if (!Object.entries(value.customSkills).every(([key, entry]) =>
    isCustomSkill(entry) && entry.id === key)) return null
  const names = Object.values(value.customSkills).map(entry =>
    (entry as AgentCodeCustomSkillRecord).name)
  if (new Set(names).size !== names.length) return null
  if (!Object.values(value.materializations).every(isMaterialization)) return null
  if (!Object.values(value.pendingOperations).every(isPendingOperation)) return null
  return value as AgentCodeConventionsDocument
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
    materializations: value.materializations as AgentCodeConventionsDocument['materializations'],
    pendingOperations: value.pendingOperations as AgentCodeConventionsDocument['pendingOperations'],
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
  const document = parseDocument(parsed) ?? migrateLegacyDocument(parsed)
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
