// See docs/design/provider-switching.md for the adapter boundary and the rule
// that projection model metadata must match capacity planning metadata.
import { readFile } from 'fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import type { AgentProviderKind } from '@shared/types/providerKind.js'
import type {
  RewindPrompt,
  RewindPromptAddress,
} from '@shared/types/transcriptRewind.js'
import {
  analyzeClaudeTranscript,
  analyzeCodexTranscript,
  classifyClaudeDocument,
  classifyCodexDocument,
  claudeNativeResumeProjector,
  codexNativeResumeProjector,
  decodeClaudeConversation,
  decodeCodexConversation,
  decodeJsonl,
  budgetCharactersForContextTokens,
  resolveCodexTargetProfileFromSources,
  resolveUserPrompt,
} from 'agent-transcript-parser'
import type {
  ConversationContent,
  ConversationDocument,
  NativeResumeProjectionResult,
  PromptAddress,
  PromptReference,
  RawJsonlDocument,
} from 'agent-transcript-parser'

import { readInstalledVersion } from '@main/setup/cliVersion.js'
import { getToolPath } from '@main/setup/toolchain.js'
import {
  findCodexRolloutPathBySessionId,
  getClaudeSessionFilePath,
  projectedClaudeSessionId,
  projectedCodexSessionMeta,
  writeProjectedClaudeSessionFile,
  writeProjectedCodexRolloutFile,
} from '@main/providerSwitch/shared.js'

export interface TranscriptProjectionContext {
  cwd: string
  targetSessionId: string
  now: string
  targetProfile?: TranscriptTargetProfile
}

export interface TranscriptTargetProfile {
  model: string
  modelProvider?: string
  budgetCharacters: number
}

export interface RewindDraft {
  promptText: string
  promptMode: 'prompt' | 'bash'
  promptImages: Array<{ mediaType: string; data: string }>
}

interface TranscriptSnapshot {
  conversation: ConversationDocument
  prompts: PromptReference[]
}

export interface HostTranscriptAdapter {
  provider: string
  read(cwd: string, providerSessionId: string): Promise<ConversationDocument>
  // WHY the path is exposed separately from read(): the compaction wait in
  // compactBeforeSwitch.ts polls the live source transcript for minutes. A
  // full read() decodes the whole file (60–150 MB for a long Codex rollout)
  // and, for Codex, walks the entire date-bucketed sessions tree to find it.
  // Doing that four times a second pinned ~350 MB and stalled the main event
  // loop for seconds at a time (#720). With the path in hand the caller can
  // stat() cheaply and only pay for a decode when the file actually grew.
  locate(cwd: string, providerSessionId: string): Promise<string>
  // Decode a transcript whose path the caller already resolved via locate().
  // read() is locate()+readAt(); the compaction wait pairs a single locate()
  // with repeated readAt() so the Codex sessions-tree walk is paid once.
  readAt(path: string): Promise<ConversationDocument>
  listPrompts(cwd: string, providerSessionId: string): Promise<RewindPrompt[]>
  draft(content: readonly ConversationContent[]): RewindDraft
  targetProfile(): Promise<TranscriptTargetProfile>
  projectNativeResume(
    conversation: ConversationDocument,
    context: TranscriptProjectionContext,
  ): Promise<NativeResumeProjectionResult>
  write(cwd: string, values: readonly Record<string, unknown>[]): Promise<string>
  sessionId(values: readonly Record<string, unknown>[]): string
}

const claudeAdapter: HostTranscriptAdapter = {
  provider: 'claude',
  async read(cwd, providerSessionId) {
    return (await loadClaudeSnapshot(cwd, providerSessionId)).conversation
  },
  locate: getClaudeSessionFilePath,
  async readAt(path) {
    return (await loadClaudeSnapshotAt(path)).conversation
  },
  async listPrompts(cwd, providerSessionId) {
    return promptsFromSnapshot(
      await loadClaudeSnapshot(cwd, providerSessionId),
      claudeDraft,
    )
  },
  draft: claudeDraft,
  targetProfile: resolveClaudeTargetProfile,
  async projectNativeResume(conversation, context) {
    const targetProfile = context.targetProfile ?? await resolveClaudeTargetProfile()
    return claudeNativeResumeProjector.projectNativeResume(conversation, {
      ...context,
      version: await installedVersion('claude'),
      model: targetProfile.model,
    })
  },
  write: writeProjectedClaudeSessionFile,
  sessionId: projectedClaudeSessionId,
}

const codexAdapter: HostTranscriptAdapter = {
  provider: 'codex',
  async read(cwd, providerSessionId) {
    return (await loadCodexSnapshot(cwd, providerSessionId)).conversation
  },
  async locate(_cwd, providerSessionId) {
    return locateCodexRollout(providerSessionId)
  },
  async readAt(path) {
    return (await loadCodexSnapshotAt(path)).conversation
  },
  async listPrompts(cwd, providerSessionId) {
    return promptsFromSnapshot(
      await loadCodexSnapshot(cwd, providerSessionId),
      plainDraft,
    )
  },
  draft: plainDraft,
  targetProfile: resolveCodexTargetProfile,
  async projectNativeResume(conversation, context) {
    const targetProfile = context.targetProfile ?? await resolveCodexTargetProfile()
    return codexNativeResumeProjector.projectNativeResume(conversation, {
      ...context,
      cliVersion: await installedVersion('codex'),
      modelProvider: targetProfile.modelProvider ?? 'openai',
      model: targetProfile.model,
    })
  },
  async write(_cwd, values) {
    return writeProjectedCodexRolloutFile(values)
  },
  sessionId(values) {
    return projectedCodexSessionMeta(values).id
  },
}

async function resolveClaudeTargetProfile(): Promise<TranscriptTargetProfile> {
  const claudeHome = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
  const settings = await readFile(join(claudeHome, 'settings.json'), 'utf8')
    .then(value => JSON.parse(value) as unknown)
    .catch(() => null)
  const configuredModel = isRecord(settings) && typeof settings.model === 'string'
    ? settings.model
    : null
  const model = process.env.ANTHROPIC_MODEL ?? configuredModel ?? 'default'
  const contextTokens = /\[1m\]/i.test(model) ? 1_000_000 : 200_000
  return {
    model,
    // WHY 200k is the default rather than assuming an advertised long-context
    // beta: Agent Code does not pass --model when it spawns Claude. Only an
    // explicit settings/env model with the [1m] selector proves that larger
    // window is active. A conservative plan may compact early; an optimistic
    // 1m guess writes a resume that fails only after the source pane is gone.
    budgetCharacters: budgetCharactersForContextTokens(contextTokens),
  }
}

async function resolveCodexTargetProfile(): Promise<TranscriptTargetProfile> {
  const codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex')
  const config = await readFile(join(codexHome, 'config.toml'), 'utf8').catch(() => '')
  const cache = await readFile(join(codexHome, 'models_cache.json'), 'utf8')
    .then(value => JSON.parse(value) as unknown)
    .catch(() => null)
  const profile = resolveCodexTargetProfileFromSources(config, cache)
  return {
    model: profile.model,
    modelProvider: profile.modelProvider,
    budgetCharacters: profile.budgetCharacters,
  }
}

// WHY a registry rather than source/target pair branches: each provider owns
// one decoder, one native projector, and its storage policy. Switching composes
// any installed source and target adapters through ConversationDocument, so a
// third provider adds one entry here instead of two translators for every
// provider already shipped.
const transcriptAdapters = new Map<string, HostTranscriptAdapter>([
  [claudeAdapter.provider, claudeAdapter],
  [codexAdapter.provider, codexAdapter],
])

export function getHostTranscriptAdapter(provider: AgentProviderKind): HostTranscriptAdapter {
  const adapter = transcriptAdapters.get(provider)
  if (!adapter) {
    throw new Error(`No transcript engine adapter is registered for provider "${provider}".`)
  }
  return adapter
}

async function installedVersion(provider: 'claude' | 'codex'): Promise<string> {
  const binary = getToolPath(provider, provider)
  const result = await readInstalledVersion(binary)
  // The wire field is required by both providers, but failure to probe a CLI
  // must not turn a successfully decoded transcript into an accidental write.
  // This explicit marker is honest and parseable; the projection profile still
  // carries the narrower evidence coordinate used to claim resume support.
  return result.ok ? result.version : '0.0.0-unprobed'
}

async function loadClaudeSnapshot(
  cwd: string,
  providerSessionId: string,
): Promise<TranscriptSnapshot> {
  return loadClaudeSnapshotAt(await getClaudeSessionFilePath(cwd, providerSessionId))
}

async function loadClaudeSnapshotAt(path: string): Promise<TranscriptSnapshot> {
  const document = await readStableTranscript(path)
  const records = classifyClaudeDocument(document).records
  return {
    conversation: decodeClaudeConversation(records),
    prompts: analyzeClaudeTranscript(records).prompts,
  }
}

async function locateCodexRollout(providerSessionId: string): Promise<string> {
  const path = await findCodexRolloutPathBySessionId(providerSessionId)
  if (!path) throw new Error(`Codex rollout for session ${providerSessionId} was not found.`)
  return path
}

async function loadCodexSnapshot(
  _cwd: string,
  providerSessionId: string,
): Promise<TranscriptSnapshot> {
  return loadCodexSnapshotAt(await locateCodexRollout(providerSessionId))
}

async function loadCodexSnapshotAt(path: string): Promise<TranscriptSnapshot> {
  const document = await readStableTranscript(path)
  const records = classifyCodexDocument(document).records
  return {
    conversation: decodeCodexConversation(records),
    prompts: analyzeCodexTranscript(records).prompts,
  }
}

async function readStableTranscript(path: string): Promise<RawJsonlDocument> {
  const maxAttempts = 2
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const document = decodeJsonl(await readFile(path, 'utf8'))
    const malformed = document.lines.filter(line => line.kind === 'malformed')
    if (malformed.length === 0) return document

    const finalLine = document.lines.at(-1)
    const onlyActiveTail = malformed.length === 1 && (
      finalLine?.kind === 'malformed' && finalLine.unterminated
    )
    if (onlyActiveTail && attempt + 1 < maxAttempts) {
      // WHY one bounded reread is preferable to accepting the valid prefix:
      // provider files are append-oriented, so a snapshot can land between a
      // record write and its terminator. A short retry handles that race while
      // still failing durable corruption before any projected file is written.
      await delay(25)
      continue
    }

    const lines = malformed.map(line => line.index).join(', ')
    throw new Error(`Transcript ${path} contains malformed JSONL at physical line(s) ${lines}.`)
  }

  throw new Error(`Transcript ${path} could not be read as stable JSONL.`)
}

function promptsFromSnapshot(
  snapshot: TranscriptSnapshot,
  draft: (content: readonly ConversationContent[]) => RewindDraft,
): RewindPrompt[] {
  const prompts: RewindPrompt[] = []
  for (const reference of snapshot.prompts) {
    const message = resolveUserPrompt(snapshot.conversation, reference.address)

    // Rewinding the first semantic prompt would leave no resumable history.
    // A blank provider file is not a portable "new chat" representation, so
    // the picker only offers boundaries with an actual semantic prefix.
    const hasResumablePrefix = snapshot.conversation.entries.some(entry => (
      entry.source.line < reference.address.line && entry.kind !== 'opaque'
    ))
    if (!hasResumablePrefix) continue

    const promptDraft = draft(message.content)
    const text = promptDraft.promptText.trim().length > 0
      ? promptDraft.promptText
      : promptDraft.promptImages.length > 0
        ? '[Image prompt]'
        : ''
    if (text.length === 0) continue
    prompts.push({
      address: ipcPromptAddress(reference.address),
      text,
      timestamp: message.timestamp,
    })
  }
  return prompts
}

function ipcPromptAddress(address: PromptAddress): RewindPromptAddress {
  if (address.provider !== 'claude' && address.provider !== 'codex' && address.provider !== 'opencode') {
    throw new Error(`Provider "${address.provider}" cannot cross the Agent Code rewind IPC boundary.`)
  }
  return {
    provider: address.provider,
    line: address.line,
    sessionId: address.sessionId,
    ...('uuid' in address && (typeof address.uuid === 'string' || address.uuid === null)
      ? { uuid: address.uuid }
      : {}),
  }
}

function plainDraft(content: readonly ConversationContent[]): RewindDraft {
  return {
    promptText: content
      .filter((item): item is Extract<ConversationContent, { kind: 'text' }> => item.kind === 'text')
      .map(item => item.text)
      .join('\n'),
    promptMode: 'prompt',
    promptImages: [],
  }
}

function claudeDraft(content: readonly ConversationContent[]): RewindDraft {
  const plain = plainDraft(content)
  const images: RewindDraft['promptImages'] = []
  for (const item of content) {
    if (item.kind !== 'image' || !isRecord(item.value)) continue
    const source = isRecord(item.value.source) ? item.value.source : null
    if (source?.type !== 'base64' || typeof source.data !== 'string') continue
    images.push({
      mediaType: typeof source.media_type === 'string' ? source.media_type : 'image/png',
      data: source.data,
    })
  }

  const bash = extractTagBody(plain.promptText, 'bash-input')
  if (bash !== null) {
    return { promptText: bash, promptMode: 'bash', promptImages: images }
  }
  const command = extractTagBody(plain.promptText, 'command-name')
  if (command !== null) {
    const args = extractTagBody(plain.promptText, 'command-args') ?? ''
    return {
      promptText: args.length > 0 ? `${command} ${args}` : command,
      promptMode: 'prompt',
      promptImages: images,
    }
  }
  return {
    promptText: stripClaudeContext(plain.promptText),
    promptMode: 'prompt',
    promptImages: images,
  }
}

function extractTagBody(source: string, tag: string): string | null {
  const match = source.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))
  return match ? (match[1] ?? '').trim() : null
}

function stripClaudeContext(source: string): string {
  // These are Claude-authored transport wrappers, not arbitrary XML. Keeping
  // the list closed prevents a user-authored tag from silently disappearing.
  const wrappers = [
    'ide_selection',
    'ide_diagnostics',
    'ide_opened_files',
    'local-command-caveat',
    'local-command-stdout',
    'system-reminder',
  ]
  let result = source
  for (const tag of wrappers) {
    result = result.replace(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, 'g'), '')
  }
  return result.trim()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
