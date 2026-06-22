// Conditions - dev-debug module for the conditions-framework stack.
//
// WHY this module exists:
// The conditions pipeline crosses too many layers to debug from one ordinary
// UI symptom: headless screen parsers emit a snapshot, renderer state derives
// legacy pending fields, feed rendering uses semantic tool blocks, composer
// keybinds use selector decisions, and dispatch mode uses attention labels.
// When AskUserQuestion falls back to a plain "RUNNING" tool row, the useful
// question is not "did React render wrong?" but which link in that chain is
// missing. This module intentionally dumps the whole chain in one place,
// including the exact detection predicates/signals we expect to see.

import { useMemo } from 'react'
import type { ReactNode } from 'react'

import type {
  DevDebugCopyMode,
  DevDebugModule,
  DevDebugModuleProps,
} from '@renderer/features/debug/devModules/types'
import {
  dispatchAttentionLabelFromConditions,
  hasActionCondition,
  slashPickerFromConditions,
} from '@renderer/workspace/conditions/selectors'
import type {
  FeedDebugEntry,
  SemanticLiveBlock,
  SemanticLiveTurn,
} from '@renderer/workspace/workspaceState'
import type { ProviderConditionSnapshot } from '@shared/types/providerConditions'

export const conditionsDebugModule: DevDebugModule = {
  id: 'conditions',
  title: 'Conditions',
  description: 'Condition snapshots, derived runtime state, AUQ render gates, exact probes, and raw screens.',
  Component: ConditionsDebug,
  buildCopyText: buildConditionsCopyText,
}

const CONDITION_CATALOG = [
  {
    provider: 'claude',
    kind: 'claude.trust-dialog',
    signal: 'snapshot.conditions["claude.trust-dialog"] exists and state.visible is true',
    derived: 'runtime.pendingTrustDialog',
    consumer: 'modal outlet + dispatch attention TRUST',
  },
  {
    provider: 'claude',
    kind: 'claude.permission-prompt',
    signal: 'snapshot.conditions["claude.permission-prompt"] exists and state.visible is true',
    derived: 'runtime.pendingPermissionPrompt',
    consumer: 'modal outlet + action key routing + dispatch attention ACTION',
  },
  {
    provider: 'claude',
    kind: 'claude.resume-prompt',
    signal: 'snapshot.conditions["claude.resume-prompt"] exists and state.visible is true',
    derived: 'runtime.pendingResumePrompt',
    consumer: 'modal outlet + action key routing + dispatch attention RESUME',
  },
  {
    provider: 'claude',
    kind: 'claude.compaction',
    signal: 'snapshot.conditions["claude.compaction"] exists and state.visible/phase are set',
    derived: 'runtime.pendingCompaction',
    consumer: 'inline compaction strip; ERROR attention when phase=error',
  },
  {
    provider: 'claude',
    kind: 'claude.slash-picker',
    signal: 'snapshot.conditions["claude.slash-picker"] exists while picker.visible is true',
    derived: 'runtime.picker',
    consumer: 'composer slash command dropdown',
  },
  {
    provider: 'claude',
    kind: 'claude.ask-user-question',
    signal: 'snapshot.conditions["claude.ask-user-question"] exists while AUQ picker is on screen',
    derived: 'Feed AskUserQuestionConditionContext side channel',
    consumer: 'feed AskUserQuestionRow resolver + action key routing + dispatch attention QUESTION',
  },
  {
    provider: 'codex',
    kind: 'codex.trust-dialog',
    signal: 'snapshot.conditions["codex.trust-dialog"] exists and state.visible is true',
    derived: 'runtime.pendingTrustDialog',
    consumer: 'modal outlet + dispatch attention TRUST',
  },
  {
    provider: 'codex',
    kind: 'codex.approval',
    signal: 'snapshot.conditions["codex.approval"] exists',
    derived: 'runtime.pendingApproval',
    consumer: 'approval strip + action key routing + dispatch attention ACTION',
  },
] as const

const AUQ_SCREEN_PROBES = [
  {
    label: 'footer: Enter to select',
    pattern: /Enter to select/i,
    why: 'AskUserQuestionParser anchors on the picker footer/fingerprint, not only numbered rows.',
  },
  {
    label: 'footer: navigate hint',
    pattern: /navigate/i,
    why: 'The footer should include navigation wording near the selection instructions.',
  },
  {
    label: 'numbered option row',
    pattern: /^\s*(?:[>\u276f]\s*)?\d+\.\s+/im,
    why: 'Options are parsed from numbered rows; composer echo lines must not count.',
  },
  {
    label: 'type something row',
    pattern: /^\s*(?:[>\u276f]\s*)?\d+\.\s+.*type something/im,
    why: "Free-text support depends on detecting Claude's injected Other row.",
  },
  {
    label: 'multi checkbox row',
    pattern: /^\s*(?:[>\u276f]\s*)?\d+\.\s+\[[ x\u2713\u2714]\]/im,
    why: 'Multi-select toggle state comes from checkbox rows.',
  },
  {
    label: 'submit row',
    pattern: /^\s*(?:[>\u276f]\s*)?Submit\s*$/im,
    why: 'Multi-select submit driving needs to know when focus is on Submit.',
  },
]

function ConditionsDebug({ sessionId, runtime, kind }: DevDebugModuleProps) {
  const snapshot = runtime.conditions
  const conditionKeys = snapshot ? Object.keys(snapshot.conditions) : []
  const attention = dispatchAttentionLabelFromConditions(snapshot)
  const actionCondition = hasActionCondition(snapshot)
  const slashFromConditions = slashPickerFromConditions(snapshot)
  const auqFromConditions =
    snapshot?.provider === 'claude'
      ? snapshot.conditions['claude.ask-user-question']?.state ?? null
      : null
  const auqBlocks = useMemo(
    () => collectAskUserQuestionBlocks(runtime.semantic.currentTurn, runtime.semantic.history),
    [runtime.semantic.currentTurn, runtime.semantic.history],
  )
  const screenProbeRows = useMemo(
    () => AUQ_SCREEN_PROBES.map(probe => ({
      ...probe,
      result: summarizeMatch(runtime.screen, probe.pattern),
    })),
    [runtime.screen],
  )
  const conditionDebugEvents = runtime.feedDebugLog
    .filter(entry => entry.kind === 'conditions' || entry.layer === 'SEM')
    .slice(-10)
    .reverse()
  const semanticEvents = runtime.semantic.log.slice(-10).reverse()

  return (
    <Panel title="conditions">
      <div className="grid grid-cols-2 gap-2">
        <Metric label="session" value={sessionId} wide />
        <Metric label="kind" value={kind} />
        <Metric label="snapshot provider" value={snapshot?.provider ?? 'none'} tone={snapshot ? 'good' : 'bad'} />
        <Metric label="snapshot age" value={snapshot ? `${Date.now() - snapshot.ts}ms` : 'none'} />
        <Metric label="condition keys" value={conditionKeys.length ? conditionKeys.join(', ') : 'none'} wide tone={conditionKeys.length ? 'good' : 'bad'} />
        <Metric label="has action condition" value={String(actionCondition)} tone={actionCondition ? 'good' : 'neutral'} />
        <Metric label="attention label" value={attention ?? 'none'} tone={attention ? 'warn' : 'neutral'} />
      </div>

      <Section title="what this module expects">
        <div className="overflow-auto border border-[#222] bg-[#0b0b0b]">
          <table className="w-full text-[10px]">
            <thead className="text-muted">
              <tr className="border-b border-[#222]">
                <th className="px-2 py-1 text-left font-normal">provider</th>
                <th className="px-2 py-1 text-left font-normal">kind</th>
                <th className="px-2 py-1 text-left font-normal">condition signal</th>
                <th className="px-2 py-1 text-left font-normal">derived state</th>
                <th className="px-2 py-1 text-left font-normal">consumer</th>
                <th className="px-2 py-1 text-left font-normal">now</th>
              </tr>
            </thead>
            <tbody>
              {CONDITION_CATALOG.map(row => {
                const present = conditionPresent(snapshot, row.kind)
                return (
                  <tr key={row.kind} className="border-b border-[#181818] align-top">
                    <td className="px-2 py-1 text-muted">{row.provider}</td>
                    <td className="px-2 py-1 text-ink-dim">{row.kind}</td>
                    <td className="px-2 py-1 text-muted">{row.signal}</td>
                    <td className="px-2 py-1 text-muted">{row.derived}</td>
                    <td className="px-2 py-1 text-muted">{row.consumer}</td>
                    <td className={present ? 'px-2 py-1 text-green-300' : 'px-2 py-1 text-red-300'}>
                      {present ? 'present' : 'absent'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="derived renderer state">
        <div className="grid grid-cols-2 gap-2">
          <Metric label="pending trust" value={runtime.pendingTrustDialog ? 'present' : 'null'} tone={runtime.pendingTrustDialog ? 'warn' : 'neutral'} />
          <Metric label="pending permission" value={runtime.pendingPermissionPrompt ? 'present' : 'null'} tone={runtime.pendingPermissionPrompt ? 'warn' : 'neutral'} />
          <Metric label="pending resume" value={runtime.pendingResumePrompt ? 'present' : 'null'} tone={runtime.pendingResumePrompt ? 'warn' : 'neutral'} />
          <Metric label="pending compaction" value={runtime.pendingCompaction ? runtime.pendingCompaction.phase : 'null'} tone={runtime.pendingCompaction ? 'warn' : 'neutral'} />
          <Metric label="pending approval" value={runtime.pendingApproval ? 'present' : 'null'} tone={runtime.pendingApproval ? 'warn' : 'neutral'} />
          <Metric label="runtime.picker" value={`${runtime.picker.visible ? 'visible' : 'hidden'} / ${runtime.picker.items.length} items`} tone={runtime.picker.visible ? 'good' : 'neutral'} />
          <Metric label="slash from conditions" value={slashFromConditions ? `${slashFromConditions.visible ? 'visible' : 'hidden'} / ${slashFromConditions.items.length} items` : 'null'} />
          <Metric label="slash parity" value={jsonEqual(runtime.picker, slashFromConditions ?? { visible: false, items: [] }) ? 'same' : 'different'} tone={jsonEqual(runtime.picker, slashFromConditions ?? { visible: false, items: [] }) ? 'good' : 'bad'} />
        </div>
      </Section>

      <Section title="AskUserQuestion pipeline">
        <div className="grid grid-cols-2 gap-2">
          <Metric label="condition state" value={auqFromConditions ? 'present' : 'absent'} tone={auqFromConditions ? 'good' : 'bad'} />
          <Metric label="semantic AUQ blocks" value={String(auqBlocks.length)} tone={auqBlocks.length ? 'good' : 'bad'} />
          <Metric label="unresolved AUQ blocks" value={String(auqBlocks.filter(block => block.resultAt == null).length)} tone={auqBlocks.some(block => block.resultAt == null) ? 'warn' : 'neutral'} />
          <Metric label="would native row have input" value={auqBlocks.some(block => hasParsedQuestions(block)) ? 'yes' : 'no'} tone={auqBlocks.some(block => hasParsedQuestions(block)) ? 'good' : 'bad'} />
        </div>
        {auqFromConditions ? (
          <JsonBlock title="live claude.ask-user-question state" value={auqFromConditions} />
        ) : (
          <EmptyLine text="no live AUQ condition in runtime.conditions" />
        )}
        <div className="flex flex-col gap-1">
          {auqBlocks.length === 0 ? (
            <EmptyLine text="no AskUserQuestion semantic blocks in current/history semantic state" />
          ) : (
            auqBlocks.map(block => (
              <div key={`${block.turnId}:${block.blockIndex}`} className="border border-border bg-canvas px-2 py-1">
                <div className="grid grid-cols-2 gap-2">
                  <Metric label="turn/block" value={`${block.turnId}:${block.blockIndex}`} />
                  <Metric label="resultAt" value={block.resultAt == null ? 'unresolved' : formatTime(block.resultAt)} tone={block.resultAt == null ? 'warn' : 'good'} />
                  <Metric label="input valid" value={String(block.inputJsonValid ?? 'unknown')} />
                  <Metric label="parsed questions" value={String(readQuestionCount(block.parsedInput))} tone={hasParsedQuestions(block) ? 'good' : 'bad'} />
                </div>
                <JsonBlock title="parsedInput" value={block.parsedInput ?? null} compact />
              </div>
            ))
          )}
        </div>
      </Section>

      <Section title="AUQ screen detection probes">
        <div className="grid grid-cols-2 gap-2">
          <Metric label="plain screen bytes" value={String(runtime.screen.length)} />
          <Metric label="markdown screen bytes" value={String(runtime.screenMarkdown.length)} />
        </div>
        <div className="grid grid-cols-2 gap-2">
          {screenProbeRows.map(row => (
            <div key={row.label} className="border border-border bg-canvas px-2 py-1">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] text-ink-dim">{row.label}</span>
                <span className={row.result.matched ? 'text-green-300' : 'text-red-300'}>
                  {row.result.matched ? `match @${row.result.index}` : 'no'}
                </span>
              </div>
              <div className="mt-1 text-[10px] text-muted">{row.why}</div>
              <code className="mt-1 block break-all text-[9px] text-muted">
                {String(row.pattern)}
              </code>
              <div className="mt-1 break-all text-[10px] text-ink-dim">
                {row.result.matched ? row.result.text : '(no matched text)'}
              </div>
            </div>
          ))}
        </div>
        <Snapshot title="plain screen" value={runtime.screen || '(empty)'} />
        <Snapshot title="markdown screen" value={runtime.screenMarkdown || '(empty)'} />
      </Section>

      <Section title="raw condition snapshot">
        <JsonBlock title="runtime.conditions" value={snapshot} />
      </Section>

      <Section title="recent condition / semantic events">
        <EventList entries={conditionDebugEvents} />
        <JsonBlock title="semantic log tail" value={semanticEvents} compact />
      </Section>
    </Panel>
  )
}

function buildConditionsCopyText(
  { sessionId, runtime, kind }: DevDebugModuleProps,
  mode: DevDebugCopyMode,
): string {
  const snapshot = runtime.conditions
  const conditionKeys = snapshot ? Object.keys(snapshot.conditions) : []
  const attention = dispatchAttentionLabelFromConditions(snapshot)
  const actionCondition = hasActionCondition(snapshot)
  const slashFromConditions = slashPickerFromConditions(snapshot)
  const auqFromConditions =
    snapshot?.provider === 'claude'
      ? snapshot.conditions['claude.ask-user-question']?.state ?? null
      : null
  const auqBlocks = collectAskUserQuestionBlocks(runtime.semantic.currentTurn, runtime.semantic.history)
  const full = mode === 'full'
  const payload = {
    module: {
      id: 'conditions',
      title: 'Conditions',
      copyMode: mode,
      copiedAt: new Date().toISOString(),
    },
    session: {
      sessionId,
      kind,
    },
    summary: {
      snapshotProvider: snapshot?.provider ?? null,
      snapshotTs: snapshot?.ts ?? null,
      snapshotAgeMs: snapshot ? Date.now() - snapshot.ts : null,
      conditionKeys,
      hasActionCondition: actionCondition,
      attentionLabel: attention,
    },
    expectedConditions: CONDITION_CATALOG.map(row => ({
      ...row,
      present: conditionPresent(snapshot, row.kind),
    })),
    derivedRendererState: {
      pendingTrustDialog: runtime.pendingTrustDialog,
      pendingPermissionPrompt: runtime.pendingPermissionPrompt,
      pendingResumePrompt: runtime.pendingResumePrompt,
      pendingCompaction: runtime.pendingCompaction,
      pendingApproval: runtime.pendingApproval,
      runtimePicker: runtime.picker,
      slashFromConditions,
      slashParity: jsonEqual(runtime.picker, slashFromConditions ?? { visible: false, items: [] }),
    },
    askUserQuestion: {
      liveConditionState: auqFromConditions,
      semanticBlockCount: auqBlocks.length,
      unresolvedSemanticBlockCount: auqBlocks.filter(block => block.resultAt == null).length,
      anyParsedQuestions: auqBlocks.some(block => hasParsedQuestions(block)),
      semanticBlocks: auqBlocks.map(block => ({
        turnId: block.turnId,
        blockIndex: block.blockIndex,
        resultAt: block.resultAt ?? null,
        inputJsonValid: block.inputJsonValid ?? null,
        parsedQuestionCount: readQuestionCount(block.parsedInput),
        parsedInput: block.parsedInput ?? null,
        inputJson: full ? block.inputJson ?? null : undefined,
      })),
    },
    screenDetectionProbes: AUQ_SCREEN_PROBES.map(probe => ({
      label: probe.label,
      why: probe.why,
      pattern: String(probe.pattern),
      result: summarizeMatch(runtime.screen, probe.pattern),
    })),
    raw: {
      conditions: snapshot,
      plainScreen: full ? runtime.screen : runtime.screen.slice(-2400),
      markdownScreen: full ? runtime.screenMarkdown : runtime.screenMarkdown.slice(-2400),
      conditionAndSemanticEvents: full
        ? runtime.feedDebugLog.filter(entry => entry.kind === 'conditions' || entry.layer === 'SEM')
        : runtime.feedDebugLog
            .filter(entry => entry.kind === 'conditions' || entry.layer === 'SEM')
            .slice(-20),
      semanticLog: full ? runtime.semantic.log : runtime.semantic.log.slice(-20),
    },
  }
  return [
    '# Conditions',
    '',
    '```json',
    JSON.stringify(payload, null, 2),
    '```',
  ].join('\n')
}

type AskUserQuestionBlockSummary = SemanticLiveBlock & {
  turnId: string
}

function collectAskUserQuestionBlocks(
  current: SemanticLiveTurn | null,
  history: SemanticLiveTurn[],
): AskUserQuestionBlockSummary[] {
  const turns = [
    ...(current ? [current] : []),
    ...history.slice(-8).reverse(),
  ]
  const blocks: AskUserQuestionBlockSummary[] = []
  for (const turn of turns) {
    for (const index of turn.blockOrder) {
      const block = turn.blocks[index]
      if (block?.toolName === 'AskUserQuestion') {
        blocks.push({ ...block, turnId: turn.turnId })
      }
    }
  }
  return blocks
}

function conditionPresent(snapshot: ProviderConditionSnapshot | null, kind: string): boolean {
  if (!snapshot) return false
  return Boolean((snapshot.conditions as Record<string, unknown>)[kind])
}

function readQuestionCount(parsedInput: Record<string, unknown> | undefined): number {
  return Array.isArray(parsedInput?.questions) ? parsedInput.questions.length : 0
}

function hasParsedQuestions(block: SemanticLiveBlock): boolean {
  return readQuestionCount(block.parsedInput) > 0
}

function summarizeMatch(value: string, regex: RegExp): { matched: boolean; index: number | null; text: string } {
  // WHY reset lastIndex even though these probes are not currently global:
  // this module is meant to be a copy/pasteable debugging workbench. If a
  // future probe adds `g` or `y`, retaining the previous exec position would
  // turn a deterministic screen predicate into a stateful one and make the
  // debug panel lie on every other render.
  regex.lastIndex = 0
  const match = regex.exec(value)
  if (!match) return { matched: false, index: null, text: '' }
  return {
    matched: true,
    index: match.index,
    text: match[0],
  }
}

function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function formatTime(ts: number | null | undefined): string {
  if (!ts) return 'none'
  return new Date(ts).toLocaleTimeString()
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="border border-border bg-[#101010]">
      <div className="border-b border-border px-3 py-2 text-[10px] text-red-300 uppercase tracking-[0.12em]">
        {title}
      </div>
      <div className="p-3 flex flex-col gap-3">{children}</div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <Header label={title} />
      <div className="flex flex-col gap-2">{children}</div>
    </section>
  )
}

function Header({ label }: { label: string }) {
  return (
    <div className="mb-1 text-[9px] text-muted uppercase tracking-[0.12em]">
      {label}
    </div>
  )
}

function Metric({
  label,
  value,
  tone = 'neutral',
  wide = false,
}: {
  label: string
  value: string
  tone?: 'neutral' | 'good' | 'warn' | 'bad'
  wide?: boolean
}) {
  const toneClass =
    tone === 'good'
      ? 'text-green-300'
      : tone === 'warn'
        ? 'text-yellow-300'
        : tone === 'bad'
          ? 'text-red-300'
          : 'text-ink-dim'
  return (
    <div className={`border border-border bg-canvas px-2 py-1 min-w-0 ${wide ? 'col-span-2' : ''}`}>
      <div className="text-[9px] text-muted uppercase tracking-[0.12em]">{label}</div>
      <div className={`mt-0.5 truncate text-[10px] ${toneClass}`} title={value}>
        {value}
      </div>
    </div>
  )
}

function JsonBlock({
  title,
  value,
  compact = false,
}: {
  title: string
  value: unknown
  compact?: boolean
}) {
  const json = JSON.stringify(value, null, 2) ?? 'undefined'
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-[9px] text-muted uppercase tracking-[0.12em]">{title}</span>
        <button
          type="button"
          onClick={() => void navigator.clipboard.writeText(json)}
          className="border border-border/80 px-1.5 py-0.5 text-[10px] text-ink-dim hover:border-border-hi hover:text-ink"
        >
          copy
        </button>
      </div>
      <pre className={`${compact ? 'max-h-[130px]' : 'max-h-[300px]'} overflow-auto whitespace-pre-wrap break-words border border-[#222] bg-[#0b0b0b] px-2 py-1 text-[10px] leading-[1.45] text-ink-dim`}>
        {json}
      </pre>
    </div>
  )
}

function Snapshot({ title, value }: { title: string; value: string }) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-[9px] text-muted uppercase tracking-[0.12em]">{title}</span>
        <button
          type="button"
          onClick={() => void navigator.clipboard.writeText(value)}
          className="border border-border/80 px-1.5 py-0.5 text-[10px] text-ink-dim hover:border-border-hi hover:text-ink"
        >
          copy
        </button>
      </div>
      <pre className="max-h-[220px] overflow-auto whitespace-pre-wrap break-words border border-[#222] bg-[#0b0b0b] px-2 py-1 text-[10px] leading-[1.45] text-ink-dim">
        {value}
      </pre>
    </div>
  )
}

function EventList({ entries }: { entries: FeedDebugEntry[] }) {
  if (entries.length === 0) return <EmptyLine text="no recent condition/semantic debug events" />
  return (
    <div className="flex flex-col gap-1">
      {entries.map(entry => (
        <div key={entry.id} className="border border-border bg-canvas px-2 py-1">
          <div className="flex items-center justify-between gap-2 text-[9px] uppercase tracking-[0.12em]">
            <span className="text-muted">{entry.layer} / {entry.kind}</span>
            <span className="text-muted tabular-nums">{formatTime(entry.ts)}</span>
          </div>
          <div className="mt-0.5 text-[10px] text-ink-dim">{entry.summary}</div>
          {entry.data !== undefined && (
            <pre className="mt-1 max-h-[92px] overflow-auto whitespace-pre-wrap break-words text-[10px] text-muted">
              {JSON.stringify(entry.data, null, 2)}
            </pre>
          )}
        </div>
      ))}
    </div>
  )
}

function EmptyLine({ text }: { text: string }) {
  return (
    <div className="border border-border bg-canvas px-2 py-1 text-[11px] text-muted">
      {text}
    </div>
  )
}
