import { readFile } from 'fs/promises'

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
  resolveUserPrompt,
} from 'agent-transcript-parser'
import type {
  ConversationContent,
  ConversationDocument,
  NativeResumeProjectionResult,
  PromptAddress,
  PromptReference,
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
  listPrompts(cwd: string, providerSessionId: string): Promise<RewindPrompt[]>
  draft(content: readonly ConversationContent[]): RewindDraft
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
  async listPrompts(cwd, providerSessionId) {
    return promptsFromSnapshot(
      await loadClaudeSnapshot(cwd, providerSessionId),
      claudeDraft,
    )
  },
  draft: claudeDraft,
  async projectNativeResume(conversation, context) {
    return claudeNativeResumeProjector.projectNativeResume(conversation, {
      ...context,
      version: await installedVersion('claude'),
      model: 'claude-opus-4-7',
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
  async listPrompts(cwd, providerSessionId) {
    return promptsFromSnapshot(
      await loadCodexSnapshot(cwd, providerSessionId),
      plainDraft,
    )
  },
  draft: plainDraft,
  async projectNativeResume(conversation, context) {
    return codexNativeResumeProjector.projectNativeResume(conversation, {
      ...context,
      cliVersion: await installedVersion('codex'),
      modelProvider: 'openai',
      model: 'gpt-5',
    })
  },
  async write(_cwd, values) {
    return writeProjectedCodexRolloutFile(values)
  },
  sessionId(values) {
    return projectedCodexSessionMeta(values).id
  },
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
  const path = await getClaudeSessionFilePath(cwd, providerSessionId)
  const source = await readFile(path, 'utf8')
  const records = classifyClaudeDocument(decodeJsonl(source)).records
  return {
    conversation: decodeClaudeConversation(records),
    prompts: analyzeClaudeTranscript(records).prompts,
  }
}

async function loadCodexSnapshot(
  _cwd: string,
  providerSessionId: string,
): Promise<TranscriptSnapshot> {
  const path = await findCodexRolloutPathBySessionId(providerSessionId)
  if (!path) throw new Error(`Codex rollout for session ${providerSessionId} was not found.`)
  const source = await readFile(path, 'utf8')
  const records = classifyCodexDocument(decodeJsonl(source)).records
  return {
    conversation: decodeCodexConversation(records),
    prompts: analyzeCodexTranscript(records).prompts,
  }
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
