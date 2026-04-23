import { useMemo } from 'react'
import { useAppStore } from '../../../state/hooks'
import { emptySemanticRuntime } from '../../../workspace/workspaceState'

// ProxyDebugPanel — live inspector for the semantic stream and any
// provider transport attribution that survives into the shared runtime.
// Toggled via "Toggle Proxy Debug Panel" in the command palette.
//
//   - For Claude, flows show proxy attribution over `/v1/messages`.
//   - For Codex, flows may be empty; the panel still exposes the
//     folded semantic turn/block/tool state from rollout + proxy-backed
//     transport where available.
//   - Current turn: cumulative text + stop reason if seen.
//   - Block state: per-content-block accumulator for text / thinking /
//     tool_use.
//   - Usage: input/output tokens + cache counters from
//     `usage_updated`.
//   - Event tail: last N raw SemanticEvent lines for copy-paste
//     into a debugger.
//
// WHY this panel has NO local reducer:
//   It used to maintain its own parallel reducer over SemanticEvent,
//   duplicating the logic that lives in `foldSemanticEvent` inside
//   workspaceStore. That violated the "one session => one semantic
//   reducer" invariant (see workspaceStore.ts comment) and caused
//   divergence during refactors. Now the panel is a pure view over
//   `workspaceRuntimes[sessionId].semantic`; the store's reducer is
//   the single source of truth for turn/flow/block/errors/log.
//
// LOG_CAP lives here only because it's part of the rendered header
// label ("event tail (X/LOG_CAP)"). The store enforces its own cap
// on the log array — keep them consistent if either changes.
const LOG_CAP = 200

// Frozen sentinel for sessions that have never emitted a semantic
// event. It's shared across every pane that reads `.semantic` fall-back,
// so any accidental mutation (e.g. a reducer that pushes into
// `state.log` in place) would corrupt state for every session at once.
// Object.freeze is a cheap tripwire: a mis-use throws in dev rather
// than silently poisoning other panes. We intentionally freeze SHALLOWLY
// — the nested arrays/objects are already logically immutable in this
// codebase (foldSemanticEvent always returns fresh references), so a
// deep freeze is overkill and would pay a visible cost on the hot path.
const EMPTY_STATE = Object.freeze(emptySemanticRuntime())


// ---------------------------------------------------------------------------

type Props = {
  sessionId: string
  kind: string
  onClose: () => void
}

export function ProxyDebugPanel({ sessionId, kind, onClose }: Props) {
  const state = useAppStore(store => store.workspaceRuntimes[sessionId]?.semantic ?? EMPTY_STATE)

  const sortedFlows = useMemo(() => {
    return Object.values(state.flows).sort((a, b) => b.lastSeen - a.lastSeen)
  }, [state.flows])

  const blocks = useMemo(() => {
    if (!state.currentTurn) return []
    return Object.values(state.currentTurn.blocks).sort((a, b) => a.blockIndex - b.blockIndex)
  }, [state.currentTurn])

  return (
    <div className="
      h-full w-[440px] flex-shrink-0
      border-l border-border bg-[#0c0c0c]
      flex flex-col
      overflow-hidden
      text-[10px] font-code
    ">
      {/* Header — same chrome as DebugPanel. Kept red title for
          uniformity across debug-family panels (they are all
          diagnostic tools that read session state, not user-facing
          UI). */}
      <div className="
        flex items-center justify-between
        px-3 py-2
        border-b border-border
        text-[9px] text-red-400 uppercase tracking-wider
        select-none flex-shrink-0
      ">
        <span>proxy debug — {kind} semantic stream</span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onClose}
            className="text-muted hover:text-ink text-[14px] leading-none"
          >
            ×
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-3">
        {/* Flow attribution */}
        <Section title={`flows seen (${sortedFlows.length})`}>
          {sortedFlows.length === 0 && (
            <Pre>{kind === 'codex' ? 'no provider flow attribution recorded' : 'no proxy flows yet'}</Pre>
          )}
          {sortedFlows.map(flow => (
            <div
              key={flow.flowId}
              className="bg-[#111] border border-[#222] px-2 py-1 mb-1"
            >
              <div className="flex items-center gap-2">
                <Flag
                  label="attribution"
                  value={flow.attribution}
                  on={flow.attribution === 'active'
                    ? true
                    : flow.attribution === 'ignored'
                    ? false
                    : undefined}
                />
                <span className="text-ink-dim">{flow.flowId}</span>
              </div>
              <div className="text-muted text-[9px]">
                {flow.reason}
              </div>
              {flow.turnId && (
                <div className="text-ink-dim text-[9px]">
                  turn: {flow.turnId}
                </div>
              )}
            </div>
          ))}
        </Section>

        {/* Current turn */}
        <Section title="current turn">
          {!state.currentTurn && <Pre>(no active turn)</Pre>}
          {state.currentTurn && (
            <>
              <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 mb-1">
                <Flag label="turnId" value={state.currentTurn.turnId.slice(0, 18) + '…'} />
                <Flag label="text.length" value={String(state.currentTurn.text.length)} />
                <Flag label="blocks" value={String(Object.keys(state.currentTurn.blocks).length)} />
                <Flag label="stopReason" value={state.currentTurn.stopReason ?? '…'} />
              </div>
              <Pre>{state.currentTurn.text || '(no text yet)'}</Pre>
            </>
          )}
        </Section>

        {/* Per-block state */}
        {blocks.length > 0 && (
          <Section title={`blocks (${blocks.length})`}>
            {blocks.map(block => (
              <div
                // Composite key: blockIndex alone would collide if two
                // sources (rollout + proxy) both minted blocks for the
                // same index into the same turn, or across
                // turn-transitions where block indices restart at 0.
                // Adding toolUseId (when present) and kind gives us
                // a stable-but-unique identity that React can reconcile.
                key={`${block.blockIndex}:${block.kind}:${block.toolUseId ?? 'x'}`}
                className="bg-[#111] border border-[#222] px-2 py-1 mb-1"
              >
                <div className="flex items-center gap-2 mb-0.5 text-ink-dim">
                  <span>#{block.blockIndex}</span>
                  <span>{block.kind}</span>
                  {block.toolName && <span>{block.toolName}</span>}
                  {block.finalized && <span className="text-muted">[finalized]</span>}
                </div>
                {block.kind === 'text' && (
                  <Pre>{block.text || '(empty)'}</Pre>
                )}
                {block.kind === 'thinking' && (
                  <Pre>{block.thinking || '(empty)'}</Pre>
                )}
                {(block.kind === 'tool_use' ||
                  block.kind === 'server_tool_use' ||
                  block.kind === 'mcp_tool_use') && (
                  <Pre>
                    {(block.inputJson || '(pending)') +
                      (block.inputJsonValid === false
                        ? '\n\n[parse: invalid JSON]'
                        : block.inputJsonValid === true
                        ? '\n\n[parse: ok]'
                        : '')}
                  </Pre>
                )}
              </div>
            ))}
          </Section>
        )}

        {/* Usage */}
        {state.currentTurn?.usage && (
          <Section title="usage">
            <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
              {Object.entries(state.currentTurn.usage).map(([k, v]) => (
                <Flag key={k} label={k} value={String(v ?? '?')} />
              ))}
            </div>
          </Section>
        )}

        {/* Errors */}
        {state.errors.length > 0 && (
          <Section title={`errors (${state.errors.length})`}>
            {state.errors.slice(-10).map((err, i) => (
              <div
                key={i}
                className="bg-[#111] border border-[#222] px-2 py-1 mb-1"
              >
                <div className="text-[9px] uppercase text-red-400">{err.kind}</div>
                <div className="text-ink-dim">{err.message}</div>
              </div>
            ))}
          </Section>
        )}

        {/* Turn history */}
        {state.history.length > 0 && (
          <Section title={`recent turns (${state.history.length})`}>
            {state.history.slice(-5).reverse().map(turn => (
              <div
                key={turn.turnId}
                className="bg-[#111] border border-[#222] px-2 py-1 mb-1"
              >
                <div className="text-ink-dim text-[9px]">
                  {turn.turnId.slice(0, 18)}…
                  {' · '}
                  {turn.stopReason ?? 'closed'}
                  {' · '}
                  {turn.text.length} chars
                </div>
                <Pre>{turn.text.slice(0, 300)}</Pre>
              </div>
            ))}
          </Section>
        )}

        {/* Event tail */}
        <Section title={`event tail (${state.log.length}/${LOG_CAP})`}>
          <Pre>
            {state.log.length === 0
              ? '(no events yet)'
              : state.log
                  .slice(-50)
                  .map(
                    e =>
                      `${new Date(e.ts).toLocaleTimeString()}  ${e.summary}`,
                  )
                  .join('\n')}
          </Pre>
        </Section>
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[9px] text-muted uppercase tracking-wider mb-1 select-none">
        {title}
      </div>
      {children}
    </div>
  )
}

function Pre({ children }: { children: React.ReactNode }) {
  return (
    <pre className="
      bg-[#111] border border-[#222] px-2 py-1
      text-[10px] leading-[1.4] text-ink-dim
      whitespace-pre-wrap break-all
      max-h-[220px] overflow-auto
      m-0
    ">
      {children}
    </pre>
  )
}

// Flag — mirrors DebugPanel.Flag exactly: red/green only when the
// boolean `on` is explicit; otherwise muted. No invented palette.
function Flag({
  label,
  value,
  on,
}: { label: string; value?: string; on?: boolean }) {
  const display = value ?? (on ? 'true' : 'false')
  const color =
    on === true ? 'text-green-400' : on === false ? 'text-red-400' : 'text-ink-dim'
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-muted">{label}</span>
      <span className={color}>{display}</span>
    </div>
  )
}
