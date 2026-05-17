import { contextBridge } from 'electron'

import { api, type Api } from '@preload/api/index.js'

// Preload bridge — multi-session API.
//
// Every IPC channel is sessionId-scoped because the main process can
// now run N ClaudeSessions in parallel and needs to route messages to
// the right one. The renderer subscribes ONCE per event type and
// dispatches by sessionId in the callback — this avoids N×N listener
// storms as tabs and splits grow.
//
// Legacy note: the pre-tiling API had channels like `pty:screen`,
// `pty:input`, `pty:exit`. Those are all gone. The tile tree uses
// `session:*` channels that carry `{ sessionId, ... }` payloads.
//
// The api object itself is composed in ./api/index.ts by flattening
// per-domain modules (session, provider, lsp, fs, workspace, debug,
// sessions, ghost, git, system). This file stays tiny: bind to the
// global and re-export the types that the renderer imports.

contextBridge.exposeInMainWorld('api', api)

export type { Api }

// Re-export every payload type. Renderer code that imports types
// from '@preload/index' (or from this file via d.ts) keeps working
// verbatim — the types just moved from inline declarations into
// ./api/types.ts, and this file is still the public face of the
// preload bundle.
export type {
  FeedDebugPersistEntry,
  DevDebugConfig,
  JsonlEntry,
  LspDiagnostic,
  LspDiagnosticsEvent,
  LspSemanticLegend,
  PickerItem,
  ProviderConditionSnapshot,
  SavedClaudeImage,
  ScreenSnapshot,
  SessionCompactionStateEvent,
  SessionConditionsEvent,
  SessionExitEvent,
  SessionHistoryChunk,
  SessionIndexEntry,
  SessionIndexPrompt,
  SessionInfo,
  WorktreeActivityIndexStatus,
  WorktreeActivitySummary,
  DictationProvider,
  DictationHotkeyConfigureResult,
  DictationStartResult,
  DictationStreamTranscriptEvent,
  DictationStopResult,
  SessionJsonlEntriesEvent,
  SessionJsonlEntryEvent,
  SessionJsonlErrorEvent,
  SessionPermissionPromptEvent,
  SessionAgentPtyDataEvent,
  SessionKind,
  SessionResumePromptEvent,
  SessionScreenEvent,
  SessionSemanticEvent,
  SessionStartedEvent,
  SessionTerminalDataEvent,
  SessionTrustDialogEvent,
  SlashPickerState,
  TranscriptPathRequest,
  TranscriptPathResult,
} from '@preload/api/types.js'
export type {
  OrchestrationAgentRecord,
  OrchestrationRendererRequest,
  OrchestrationRendererResponse,
} from '@mcp/shared/orchestrationTypes.js'
export type {
  AiWorkspaceAttachFileParams,
  AiWorkspaceCreateParams,
  AiWorkspaceDetachFileParams,
  AiWorkspaceFileEntry,
  AiWorkspaceOpenRequest,
  AiWorkspaceReadFileResult,
  AiWorkspaceRecord,
  AiWorkspaceSummary,
  AiWorkspaceWriteFileResult,
} from '@mcp/shared/aiWorkspaceTypes.js'

export type {
  SetupCheckResult,
  SetupInstallResult,
  SetupInstallTarget,
  SetupToolId,
  SetupToolStatus,
} from '@shared/types/setup.js'
