import { dirname, isAbsolute } from 'path'
import { mkdir, unlink } from 'fs/promises'

import { atomicWriteTextFile, readBoundedTextFile } from '@main/editorFileIO.js'
import {
  AGENT_CODE_CONVENTIONS_SCHEMA_VERSION,
  AGENT_CODE_CONVENTIONS_STATE_MAX_BYTES,
  createEmptyAgentCodeConventionsDocument,
  type AgentCodeConventionsDocument,
  type AgentCodeConventionsMaterialization,
  type AgentCodeConventionsPendingOperation,
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
    && typeof value.createdDirectory === 'boolean'
    && (value.createdDirectoryIdentity === undefined
      || (typeof value.createdDirectoryIdentity === 'string'
        && /^\d+:\d+$/.test(value.createdDirectoryIdentity)))
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
    && (value.createdDirectory === undefined || typeof value.createdDirectory === 'boolean')
    && (value.createdDirectoryIdentity === undefined
      || (typeof value.createdDirectoryIdentity === 'string'
        && /^\d+:\d+$/.test(value.createdDirectoryIdentity)))
    && (value.expectedConflictFingerprint === undefined
      || (typeof value.expectedConflictFingerprint === 'string'
        && /^[a-f0-9]{64}$/.test(value.expectedConflictFingerprint)))
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
  if (!isRecord(value.materializations) || !isRecord(value.pendingOperations)) return null
  if (!Object.values(value.materializations).every(isMaterialization)) return null
  if (!Object.values(value.pendingOperations).every(isPendingOperation)) return null
  return value as AgentCodeConventionsDocument
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
      message: `Agent Code could not safely read conventions state: ${safeErrorMessage(error)}`,
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
      message: 'Conventions state is not valid JSON. The original file was preserved.',
      stateFilePath,
    }
  }
  const document = parseDocument(parsed)
  if (document) return { kind: 'ok', document }
  return {
    kind: 'recovery-required',
    document: recoverReadableFields(parsed),
    message: 'Conventions state uses an unsupported or unsafe shape. The original file was preserved.',
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
  if (!result.ok) throw new Error('Conventions state changed during atomic write')
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
