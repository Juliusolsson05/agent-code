// The generic wire ACTION primitives now live in conditions-core/contract.ts
// (the provider-agnostic source of truth for the registry framework). We
// import them here so the provider condition unions below can keep referencing
// `ConditionAction`, AND re-export them so every existing import of these names
// from '@shared/types/providerConditions' keeps working byte-for-byte — this
// file remains the home of the provider-SPECIFIC state shapes + condition
// unions below. A bare `export type { … } from` would NOT bind these names into
// this module's local scope, so the unions below (which use `ConditionAction`)
// would fail to resolve; importing first is what keeps them visible here.
// See docs/design/conditions-system.md.
import type {
  ConditionPtyAction,
  ConditionCustomAction,
  ConditionAction,
} from '@shared/conditions-core/contract'

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
  | {
      kind: 'codex.switch-model-prompt'
      state: {
        visible: true
        message: string
        selectedIndex?: number
        options?: string[]
      }
      actions: ConditionAction[]
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

export type ProviderConditionSnapshot =
  | ClaudeConditionSnapshot
  | CodexConditionSnapshot
