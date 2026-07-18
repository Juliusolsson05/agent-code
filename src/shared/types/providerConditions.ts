// The generic wire ACTION primitives now live in conditions-core/contract.ts
// (the provider-agnostic source of truth for the registry framework). We
// import them here so the provider condition unions below can keep referencing
// `ConditionAction`, AND re-export them so every existing import of these names
// from '@shared/types/providerConditions.js' keeps working byte-for-byte — this
// file remains the home of the provider-SPECIFIC state shapes + condition
// unions below. A bare `export type { … } from` would NOT bind these names into
// this module's local scope, so the unions below (which use `ConditionAction`)
// would fail to resolve; importing first is what keeps them visible here.
// See docs/design/conditions-system.md.
import type {
  ConditionPtyAction,
  ConditionCustomAction,
  ConditionAction,
} from '@shared/conditions-core/contract.js'
import type { AgentProviderKind } from '@shared/types/providerKind.js'

export type { ConditionPtyAction, ConditionCustomAction, ConditionAction }

export type ClaudeTrustDialogState = {
  visible: boolean
  options?: Array<{ key: string; label: string }>
  workspace?: string
}

export type ClaudeResumePromptState = {
  visible: boolean
  sessionAgeText?: string
  tokenCountText?: string
  selectedIndex?: number
}

export type ClaudePermissionPromptState = {
  visible: boolean
  title?: string
  toolName?: string
  command?: string
  options?: Array<{ key: string; label: string }>
  selectedIndex?: number
}

export type ClaudeCompactionState = {
  visible: boolean
  phase?: 'running' | 'error' | 'done'
  statusText?: string
  errorText?: string
  /** Structured proxy lifecycle is authoritative; screen is an explicitly
   * lower-confidence fallback for older/no-proxy sessions and errors. */
  source?: 'structured' | 'screen'
  operationId?: string
}

// AskUserQuestion picker state (PR-4). This MUST stay structurally identical to
// `AskUserQuestionState` / `AskUserQuestionOption` in claude-code-headless's
// AskUserQuestionParser.ts — that parser produces the value, this is the
// app-side mirror the wire snapshot is typed against (the submodule import wall
// means we can't import the headless type directly). If the parser's shape
// changes, this must change with it.
//
// Unlike the modal states above there is NO `visible: boolean` field: the parser
// returns `null` when no picker is on screen and a `{ active: true, … }` record
// when one is, so presence is "the record exists", not a flag. `active` is
// always true when present (a convenience for consumers that destructure without
// a null-check first).
export type ClaudeAskUserQuestionOption = {
  // The on-screen 1-based number; in single-select it is ALSO the exact answer
  // keystroke (see the askUserQuestion module's action contract).
  number: number
  label: string
  // Multi-select only: the live checkbox state. `undefined` in single-select.
  toggled?: boolean
}

export type ClaudeAskUserQuestionState = {
  active: true
  mode: 'single' | 'multi'
  header: string | null
  question: string | null
  // Real numbered options INCLUDING the auto-injected "Type something" row,
  // EXCLUDING the below-divider "Chat about this" footer.
  options: ClaudeAskUserQuestionOption[]
  // Row the `❯` cursor sits on, or null when the cursor is on the Submit row.
  cursorNumber: number | null
  // Multi-select: true when `❯` is on the focusable "Submit" row.
  submitFocused: boolean
  // The "Type something" free-text row's number, or null if absent.
  otherNumber: number | null
  // The "Chat about this" footer row's number, or null if absent.
  chatNumber: number | null
}

export type PickerItem = {
  id: string
  label: string
  description: string
  selected: boolean
}

export type ClaudeSlashPickerState = {
  visible: boolean
  items: PickerItem[]
}

export type CodexTrustDialogState = {
  visible: boolean
  workspace?: string
  options?: Array<{ key: string; label: string }>
}

export type CodexApprovalState = {
  title: string
  reason: string | null
  command: string | null
  options: string[]
  selectedIndex: number
  callId?: string | null
  commandParts?: string[]
  workdir?: string | null
}

export type ClaudeCondition =
  | {
      kind: 'claude.trust-dialog'
      state: ClaudeTrustDialogState
      actions: ConditionAction[]
    }
  | {
      kind: 'claude.resume-prompt'
      state: ClaudeResumePromptState
      actions: ConditionAction[]
    }
  | {
      kind: 'claude.permission-prompt'
      state: ClaudePermissionPromptState
      actions: ConditionAction[]
    }
  | {
      kind: 'claude.compaction'
      state: ClaudeCompactionState
      actions: ConditionAction[]
    }
  | {
      kind: 'claude.slash-picker'
      state: ClaudeSlashPickerState
      actions: ConditionAction[]
    }
  | {
      kind: 'claude.ask-user-question'
      state: ClaudeAskUserQuestionState
      actions: ConditionAction[]
    }

export type ClaudeConditionKind = ClaudeCondition['kind']

export type ClaudeConditionMap = Partial<{
  [K in ClaudeConditionKind]: Extract<ClaudeCondition, { kind: K }>
}>

export type ClaudeConditionSnapshot = {
  provider: 'claude'
  conditions: ClaudeConditionMap
  ts: number
}

export type CodexCondition =
  | {
      kind: 'codex.trust-dialog'
      state: CodexTrustDialogState
      actions: ConditionAction[]
    }
  | {
      kind: 'codex.approval'
      state: CodexApprovalState
      actions: ConditionAction[]
    }

// ── OpenCode condition states (#406 step 6) ─────────────────────────────────
//
// OpenCode surfaces two interactive conditions over its HTTP/SSE bus (NOT a
// TUI): a tool-permission request and an ask-user question. Because there is no
// PTY, every action on these is a `custom` action resolved over HTTP
// (OpencodeSession.resolveCondition → PermissionService.reply / rejectQuestion),
// never a `pty` keystroke — this is why OPENCODE_CONDITION_POLICY's actionKinds
// set is permanently empty. The state shapes mirror the headless
// ScreenPermissionEvent / ScreenQuestionEvent payloads (channels/types.ts) that
// OpencodeSession folds into the snapshot.

export type OpencodePermissionState = {
  visible: boolean
  requestID?: string
  title?: string
  metadata?: unknown
}

export type OpencodeQuestionState = {
  visible: boolean
  questionID?: string
  text?: string
  metadata?: unknown
}

export type OpencodeCondition =
  | {
      kind: 'opencode.permission'
      state: OpencodePermissionState
      actions: ConditionAction[]
    }
  | {
      kind: 'opencode.question'
      state: OpencodeQuestionState
      actions: ConditionAction[]
    }

export type OpencodeConditionKind = OpencodeCondition['kind']

export type OpencodeConditionMap = Partial<{
  [K in OpencodeConditionKind]: Extract<OpencodeCondition, { kind: K }>
}>

export type OpencodeConditionSnapshot = {
  provider: 'opencode'
  conditions: OpencodeConditionMap
  ts: number
}

export type CodexConditionKind = CodexCondition['kind']

export type CodexConditionMap = Partial<{
  [K in CodexConditionKind]: Extract<CodexCondition, { kind: K }>
}>

export type CodexConditionSnapshot = {
  provider: 'codex'
  conditions: CodexConditionMap
  ts: number
}

/**
 * The OPEN provider condition snapshot (#394 phase 3).
 *
 * WHY this is no longer the closed `ClaudeConditionSnapshot |
 * CodexConditionSnapshot` union: the closed union meant a third
 * provider could not even TYPE a snapshot without editing this file,
 * and every consumer that narrowed on `snapshot.provider === 'claude'`
 * was a hand-maintained provider fork (#394 §5). Condition kinds are
 * globally namespaced (`<provider>.<kind>`), so kind-keyed access —
 * `snapshot.conditions['claude.compaction']` — is already
 * provider-safe without narrowing the whole snapshot; the union bought
 * nothing except closure.
 *
 * The shape mirrors conditions-core's generic `ConditionSnapshot<P>`
 * (contract.ts:87-92) with Partial-valued map access, which is what
 * the per-provider condition maps produce. The per-provider
 * specializations below remain as the types the provider SESSION event
 * maps emit — both are assignable to this open shape by construction,
 * and the wire format is unchanged (nothing inspects the map beyond
 * kind-keyed access; see docs/design/conditions-system.md).
 */
export type ProviderConditionSnapshot = {
  provider: AgentProviderKind
  conditions: Partial<Record<string, ProviderConditionRecord>>
  ts: number
}

/** Generic per-kind record — the erased form of the per-provider
 *  condition unions above. `state` is provider/kind-specific; use
 *  `conditionStateByKind` for typed access. */
export type ProviderConditionRecord = {
  kind: string
  state: unknown
  actions: ConditionAction[]
}

/**
 * Typed kind-keyed state lookup. The ONE sanctioned way to read a
 * specific condition's state off the open snapshot — kinds are
 * globally namespaced, so presence of `claude.ask-user-question`
 * already implies the claude provider; no snapshot-level narrowing
 * needed. The cast is the caller declaring which state shape that
 * kind carries (the same trust the old closed-union indexing
 * provided, made explicit).
 */
export function conditionStateByKind<S>(
  snapshot: ProviderConditionSnapshot | null | undefined,
  kind: string,
): S | null {
  const record = snapshot?.conditions?.[kind]
  return record ? (record.state as S) : null
}
