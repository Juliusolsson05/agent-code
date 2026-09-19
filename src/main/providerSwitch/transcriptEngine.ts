// See docs/design/provider-switching.md for the adapter boundary and the rule
// that projection model metadata must match capacity planning metadata.
import { readFile } from 'fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { opencodeTranscriptFile } from 'opencode-terminal-headless'

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
  decodeOpencodeConversation,
  decodeJsonl,
  budgetCharactersForContextTokens,
  opencodeNativeResumeProjector,
  resolveCodexTargetProfileFromSources,
  resolveUserPrompt,
  projectGrokNativeResume,
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
  exportOpencodeSession,
  importOpencodeSession,
  listOpencodeModels,
  readOpencodeModelState,
  selectOpencodeTargetModel,
  opencodeExportSessionId,
  readResolvedOpencodeConfig,
} from '@providers/opencode/runtime/opencodeCliSessions.js'
import {
  findCodexRolloutPathBySessionId,
  getClaudeSessionFilePath,
  projectedClaudeSessionId,
  projectedCodexSessionMeta,
  writeProjectedClaudeSessionFile,
  writeProjectedCodexRolloutFile,
} from '@main/providerSwitch/shared.js'
import {
  loadGrokSnapshot,
  loadGrokSnapshotAt,
  writeProjectedGrokSession,
} from './grokTranscript.js'
import { listAllGrokSessions, parseGrokSummary, resolveGrokTranscriptPath } from 'grok-code-headless'

export interface TranscriptProjectionContext {
  cwd: string
  targetSessionId: string
  now: string
  targetProfile?: TranscriptTargetProfile
}

export interface TranscriptTargetProfile {
  model: string
  modelProvider?: string
  /** OpenCode only: the reasoning variant saved for this model, stamped on
   *  the projected session so opening it does not reset the user's effort. */
  modelVariant?: string
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

export interface TranscriptPublication {
  values: readonly Record<string, unknown>[]
  // Grok owns its identity/model/counters in summary.json, not a JSONL row.
  // Pass the projection object intact through every transformation so a host
  // adapter can publish native sidecars without manufacturing history records.
  summary?: Record<string, unknown>
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
  locate?(cwd: string, providerSessionId: string): Promise<string>
  // Decode a transcript whose path the caller already resolved via locate().
  // read() is locate()+readAt(); the compaction wait pairs a single locate()
  // with repeated readAt() so the Codex sessions-tree walk is paid once.
  readAt?(path: string): Promise<ConversationDocument>
  listPrompts(cwd: string, providerSessionId: string): Promise<RewindPrompt[]>
  draft(content: readonly ConversationContent[]): RewindDraft
  targetProfile(cwd?: string): Promise<TranscriptTargetProfile>
  projectNativeResume(
    conversation: ConversationDocument,
    context: TranscriptProjectionContext,
  ): Promise<NativeResumeProjectionResult>
  write(cwd: string, publication: TranscriptPublication): Promise<string>
  sessionId(publication: TranscriptPublication): string
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
  write: (cwd, { values }) => writeProjectedClaudeSessionFile(cwd, values),
  sessionId: ({ values }) => projectedClaudeSessionId(values),
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
  async write(_cwd, { values }) {
    return writeProjectedCodexRolloutFile(values)
  },
  sessionId({ values }) {
    return projectedCodexSessionMeta(values).id
  },
}

// WHY transcript transforms get their own, much larger OpenCode deadline:
// runOpencode's 30 s default came from e9ac8bdf (Refs #864), where it bounds a
// hung *empty-session* import that would otherwise hold OpenCode Terminal
// startup. A transform exports or imports a whole conversation instead. The
// session that exposed #845 was a 14.6 MB / 804-message export, and its export
// duration was never measured (the live probe ran before any deadline existed).
// Applying the startup bound here could turn the fixed truncation into a
// timeout on exactly the large sessions #845 made switchable, duplicable and
// rewindable. Five minutes still ends a genuinely wedged CLI, and runOpencode
// SIGKILLs its whole process group when it does.
//
// These transform calls carry no AbortSignal (nothing between the IPC handlers
// and this adapter threads one), so the deadline is their only bound; stop()
// cancellation exists for the terminal startup import alone. The target-profile
// probes (`debug config`, `models`) keep the 30 s default because their cost
// does not grow with conversation size.
const OPENCODE_TRANSFORM_TIMEOUT_MS = 5 * 60_000

const opencodeAdapter: HostTranscriptAdapter = {
  provider: 'opencode',
  async read(cwd, providerSessionId) {
    return (await loadOpencodeSnapshot(cwd, providerSessionId)).conversation
  },
  async listPrompts(cwd, providerSessionId) {
    return promptsFromSnapshot(
      await loadOpencodeSnapshot(cwd, providerSessionId),
      plainDraft,
    )
  },
  draft: plainDraft,
  targetProfile: resolveOpencodeTargetProfile,
  async projectNativeResume(conversation, context) {
    const targetProfile = context.targetProfile ?? await resolveOpencodeTargetProfile(context.cwd)
    return opencodeNativeResumeProjector.projectNativeResume(conversation, {
      ...context,
      cliVersion: await installedVersion('opencode'),
      modelProvider: targetProfile.modelProvider ?? 'opencode',
      model: targetProfile.model,
      modelVariant: targetProfile.modelVariant,
    })
  },
  async write(cwd, { values }) {
    if (values.length !== 1 || !isRecord(values[0])) {
      throw new Error('Projected OpenCode resume must contain exactly one export object.')
    }
    const binary = getToolPath('opencode', 'opencode')
    const sessionId = await importOpencodeSession({ binary, cwd, timeoutMs: OPENCODE_TRANSFORM_TIMEOUT_MS }, values[0])
    return opencodeTranscriptFile(sessionId)
  },
  sessionId({ values }) {
    if (values.length !== 1 || !isRecord(values[0])) {
      throw new Error('Projected OpenCode resume must contain exactly one export object.')
    }
    return opencodeExportSessionId(values[0])
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

/** The default agent's own `model` from the resolved config. OpenCode ranks
 *  it above the global `model` (server `input.model ?? agent.model ?? …`, TUI
 *  agent model before config). Imported sessions run as `build` unless the
 *  config names another default agent. */
function opencodeDefaultAgentModel(config: Record<string, unknown>): string | null {
  const agentName = typeof config.default_agent === 'string' && config.default_agent.length > 0 ? config.default_agent : 'build'
  const agents = config.agent && typeof config.agent === 'object' ? config.agent as Record<string, unknown> : {}
  const agent = agents[agentName] && typeof agents[agentName] === 'object' ? agents[agentName] as Record<string, unknown> : {}
  return typeof agent.model === 'string' && agent.model.length > 0 ? agent.model : null
}

async function resolveOpencodeTargetProfile(cwd = process.cwd()): Promise<TranscriptTargetProfile> {
  const binary = getToolPath('opencode', 'opencode')
  const options = { binary, cwd }
  const config = await readResolvedOpencodeConfig(options).catch(() => ({} as Record<string, unknown>))
  const [state, available] = await Promise.all([
    readOpencodeModelState(),
    listOpencodeModels(options).catch(() => null),
  ])
  // B18: the fallback used to be `listOpencodeModels()[0]` whenever config
  // had no model, i.e. the catalog's first row (`opencode/big-pickle` here),
  // even for a user who had picked another model many times. The projector
  // stamps the model on EVERY imported message, and OpenCode's lastModel()
  // keeps it, so the switched agent ran on a model the user never chose.
  // selectOpencodeTargetModel follows OpenCode's own order instead.
  const selectedModel = selectOpencodeTargetModel({
    agentModel: opencodeDefaultAgentModel(config),
    configuredModel: typeof config.model === 'string' ? config.model : null,
    recent: state.recent,
    available,
  })
  if (!selectedModel) {
    throw new Error(
      'OpenCode did not report a configured or available model; select a model in OpenCode first.',
    )
  }
  const separator = selectedModel.indexOf('/')
  if (separator <= 0 || separator === selectedModel.length - 1) {
    throw new Error(
      `OpenCode model ${JSON.stringify(selectedModel)} is not in provider/model form.`,
    )
  }
  return {
    modelProvider: selectedModel.slice(0, separator),
    model: selectedModel.slice(separator + 1),
    modelVariant: state.variants[selectedModel],
    // OpenCode can front models with very different windows and its resolved
    // config does not expose a reliable context size. A conservative 128k
    // window prevents an imported session from failing only after the source
    // pane has been replaced; models with larger windows merely compact early.
    budgetCharacters: budgetCharactersForContextTokens(128_000),
  }
}

// Grok's target profile: the SOURCE session's model when the source is grok
// (projectNativeResume reads the summary directly), otherwise the newest
// native session's modelId, otherwise the corpus-recorded grok-4.6 default
// (every recorded summary ran it). No env override — none was ever recorded.
// The conservative 128k budget mirrors OpenCode's rule: an unknown window must
// fail BEFORE the source pane is retired, not after.
async function resolveGrokTargetProfile(): Promise<TranscriptTargetProfile> {
  const newest = listAllGrokSessions({ limit: 1 })[0]
  return {
    modelProvider: 'xai',
    model: newest?.modelId ?? 'grok-4.6',
    budgetCharacters: budgetCharactersForContextTokens(128_000),
  }
}

/** The model a specific grok session ran with (its summary's
 *  current_model_id), when the summary is readable; null otherwise. */
async function grokSessionModel(cwd: string, sessionId: string): Promise<string | null> {
  try {
    const summary = parseGrokSummary(await readFile(join(dirname(resolveGrokTranscriptPath(cwd, sessionId)), 'summary.json'), 'utf8'))
    return typeof summary.current_model_id === 'string' && summary.current_model_id.length > 0 ? summary.current_model_id : null
  } catch {
    return null
  }
}

const grokAdapter: HostTranscriptAdapter = {
  provider: 'grok',
  async read(cwd, providerSessionId) {
    return (await loadGrokSnapshot(cwd, providerSessionId)).conversation
  },
  async locate(cwd, providerSessionId) {
    return resolveGrokTranscriptPath(cwd, providerSessionId)
  },
  async readAt(path) {
    return (await loadGrokSnapshotAt(path)).conversation
  },
  async listPrompts(cwd, providerSessionId) {
    return promptsFromSnapshot(
      await loadGrokSnapshot(cwd, providerSessionId),
      plainDraft,
    )
  },
  // Grok genuine-user rows carry text (and optional images) only; the plain
  // draft shape is exactly their content.
  draft: plainDraft,
  targetProfile: resolveGrokTargetProfile,
  async projectNativeResume(conversation, context) {
    // WHY the source model wins: rewind and duplicate pass no target profile,
    // and taking the NEWEST grok session's model could import a conversation
    // under some OTHER session's model. For a grok source the document names
    // its session, and that session's summary carries the model it ran with.
    const sourceModel = conversation.sourceProvider === 'grok' && conversation.sourceSessionIds[0]
      ? await grokSessionModel(context.cwd, conversation.sourceSessionIds[0])
      : null
    const targetProfile = context.targetProfile ?? {
      modelProvider: 'xai',
      model: sourceModel ?? (listAllGrokSessions({ limit: 1 })[0]?.modelId ?? 'grok-4.6'),
      budgetCharacters: budgetCharactersForContextTokens(128_000),
    }
    // The parser's projector owns the whole native projection (rows plus the
    // summary.json sidecar with its counters); the host adapter publishes it
    // intact — grok keeps its identity in summary.json, not a JSONL row.
    return projectGrokNativeResume(conversation, {
      cwd: context.cwd,
      targetSessionId: context.targetSessionId,
      now: context.now,
      model: targetProfile.model,
    })
  },
  write: (cwd, publication) => writeProjectedGrokSession(cwd, publication),
  sessionId({ summary }) {
    // writeProjectedGrokSession enforces the same identity on the way in.
    return parseGrokSummary(JSON.stringify(summary ?? null)).info.id
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
  [opencodeAdapter.provider, opencodeAdapter],
  [grokAdapter.provider, grokAdapter],
])

export function getHostTranscriptAdapter(provider: AgentProviderKind): HostTranscriptAdapter {
  const adapter = transcriptAdapters.get(provider)
  if (!adapter) {
    throw new Error(`No transcript engine adapter is registered for provider "${provider}".`)
  }
  return adapter
}

async function installedVersion(provider: AgentProviderKind): Promise<string> {
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

async function loadOpencodeSnapshot(
  cwd: string,
  providerSessionId: string,
): Promise<TranscriptSnapshot> {
  const binary = getToolPath('opencode', 'opencode')
  const exported = await exportOpencodeSession({ binary, cwd, timeoutMs: OPENCODE_TRANSFORM_TIMEOUT_MS }, providerSessionId)
  assertStableOpencodeExport(exported, providerSessionId)
  const conversation = decodeOpencodeConversation(exported)
  // OpenCode exports one complete native message per array position. That
  // position is therefore the exact rewind coordinate; deriving references
  // from decoded user entries keeps prompt listing and rewindConversation on
  // the same address without inventing a renderer ordinal.
  const prompts: PromptReference[] = []
  const seenLines = new Set<number>()
  for (const entry of conversation.entries) {
    if (entry.kind !== 'message' || entry.role !== 'user') continue
    if (seenLines.has(entry.source.line)) continue
    seenLines.add(entry.source.line)
    prompts.push({
      address: {
        provider: 'opencode',
        line: entry.source.line,
        sessionId: conversation.sourceSessionIds[0] ?? providerSessionId,
      },
      raw: entry.source.raw,
    })
  }
  return { conversation, prompts }
}

function assertStableOpencodeExport(
  exported: Record<string, unknown>,
  providerSessionId: string,
): void {
  if (!Array.isArray(exported.messages) || exported.messages.length === 0) return
  const last = exported.messages.at(-1)
  const info = isRecord(last) && isRecord(last.info) ? last.info : null
  const time = info && isRecord(info.time) ? info.time : null
  const settled = info?.role === 'assistant' &&
    typeof time?.completed === 'number' &&
    Number.isFinite(time.completed)
  if (settled) return

  // Live activity describes the running process, not the exported snapshot
  // (and parked sessions have no live channel). Validate the durable export
  // before a transformation can replace the source: a settled turn
  // ends with an assistant message carrying `time.completed`; an in-flight
  // export ends with a user message or an incomplete assistant. Refuse that
  // snapshot before rewind/duplicate/switch can project partial work and kill
  // the source pane. A cancelled user-only tail is intentionally conservative:
  // the CLI provides no evidence that distinguishes it from a live request.
  throw new Error(
    `OpenCode session ${providerSessionId} has an unfinished turn; wait for the native TUI to finish before transforming its transcript.`,
  )
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
  // Grok joins the rewind boundary in Stage 6: its addresses are the plain
  // (provider, line, sessionId) shape the boundary already serializes.
  if (address.provider !== 'claude' && address.provider !== 'codex' && address.provider !== 'opencode' && address.provider !== 'grok') {
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
