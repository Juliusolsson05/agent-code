import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { ControlError, defineCapability, nativeInputOutput, terminalReadInput, terminalReadOutput, terminalInput, terminalInputOutput } from '@control-sdk'
import type { SessionManager } from '@main/sessionManager'

const ownership = { cwd: z.string(), provider: z.string() }
type FrozenReplay = { sessionId: string; sessionRunId: string; range: string; raw: string; capChars: number; revision: string; expires: number }

export function terminalBackendCapabilities(manager: Pick<SessionManager, 'getBackendSnapshot' | 'getRawOutputSnapshot' | 'write'>) {
  const snapshots = new Map<string, FrozenReplay>()
  let timer: ReturnType<typeof setTimeout> | undefined
  const prune = () => {
    for (const [id, value] of snapshots) if (value.expires <= Date.now()) snapshots.delete(id)
    timer = snapshots.size ? setTimeout(prune, 60_000) : undefined
    timer?.unref()
  }
  const current = (input: { sessionId: string; cwd: string; provider: string }) => {
    const backend = manager.getBackendSnapshot(input.sessionId)
    if (!backend?.sessionRunId || backend.cwd !== input.cwd || backend.kind !== input.provider) throw new ControlError('unavailable', 'No matching live backend; reads never wake it')
    return backend as typeof backend & { sessionRunId: string }
  }
  return [
    defineCapability({ id: 'sessions.inputInspect', visibility: 'application', title: 'Inspect native input knowledge', execution: 'main', effect: 'read',
      description: 'Backing input observation; never derives native draft emptiness from terminal transport or readiness.',
      input: z.object({ sessionId: z.string(), ...ownership }).strict(), output: nativeInputOutput,
      handler: input => {
        const backend = manager.getBackendSnapshot(input.sessionId)
        if (backend && (backend.cwd !== input.cwd || backend.kind !== input.provider)) throw new ControlError('unavailable', 'Backend identity changed')
        return { sessionId: input.sessionId, sessionRunId: backend?.sessionRunId ?? null, backendPresent: Boolean(backend), inputReady: backend?.input.ready ?? null,
          nativeDraft: { state: 'unknown' as const, text: null, reason: 'The provider port does not expose a complete native composer snapshot. Readiness and the terminal accessibility input value do not prove an empty draft. agents.draftGet reads only the separate Agent Code draft.' } }
      },
    }),
    defineCapability({
      id: 'sessions.terminalRead', visibility: 'application', title: 'Read retained raw output', execution: 'main', effect: 'read',
      description: 'Backing read without attach, resize, wake or subscription changes. Frozen pages retain the current backend identity.',
      input: terminalReadInput.extend(ownership), output: terminalReadOutput,
      handler: input => {
        const backend = current(input)
        let frozen: FrozenReplay
        let snapshotId: string
        let offset: number
        if (input.cursor) {
          const match = /^([a-f0-9-]+):(\d+)$/.exec(input.cursor)
          if (!match) throw new ControlError('invalid_cursor', 'Use the exact nextCursor from terminals.read')
          snapshotId = match[1]; offset = Number(match[2])
          const saved = snapshots.get(snapshotId)
          if (!saved || saved.expires <= Date.now() || saved.sessionId !== input.sessionId || saved.sessionRunId !== backend.sessionRunId || saved.range !== input.range) throw new ControlError('stale_cursor', 'Raw read expired or backend/range changed; start a fresh read')
          frozen = saved
          if (!Number.isSafeInteger(offset) || offset > frozen.raw.length || (offset > 0 && /[\uDC00-\uDFFF]/.test(frozen.raw[offset] ?? ''))) throw new ControlError('invalid_cursor', 'Cursor is outside this replay')
        } else {
          const replay = manager.getRawOutputSnapshot(input.sessionId)
          if (!replay) throw new ControlError('unavailable', 'This backend has no retained PTY output; use conversation reads or its UI')
          frozen = { ...replay, sessionId: input.sessionId, sessionRunId: backend.sessionRunId, range: input.range,
            revision: createHash('sha256').update(backend.sessionRunId).update(replay.raw).digest('hex'), expires: Date.now() + 5 * 60_000 }
          snapshotId = randomUUID()
          offset = input.range === 'tail' ? Math.max(0, frozen.raw.length - input.maxChars) : 0
          if (offset > 0 && /[\uDC00-\uDFFF]/.test(frozen.raw[offset])) offset++
        }
        let end = Math.min(frozen.raw.length, offset + input.maxChars)
        if (end < frozen.raw.length && /[\uD800-\uDBFF]/.test(frozen.raw[end - 1])) end--
        if (end < frozen.raw.length && !snapshots.has(snapshotId)) {
          while (snapshots.size >= 16) snapshots.delete(snapshots.keys().next().value!)
          snapshots.set(snapshotId, frozen)
          if (!timer) { timer = setTimeout(prune, 60_000); timer.unref() }
        }
        return { sessionId: input.sessionId, sessionRunId: frozen.sessionRunId, source: 'retained-pty-replay' as const,
          raw: frozen.raw.slice(offset, end), offset, totalChars: frozen.raw.length, capChars: frozen.capChars,
          hasEarlierRetainedText: offset > 0, nextCursor: end < frozen.raw.length ? `${snapshotId}:${end}` : null, revision: frozen.revision }
      },
    }),
    defineCapability({
      id: 'sessions.terminalInput', visibility: 'application', title: 'Write to an exact backend lifetime', execution: 'main', effect: 'mutation', completion: 'accepted',
      description: 'Backing raw input; compares the backend identity and lifetime immediately before the existing manager writer.',
      input: terminalInput.extend(ownership), output: terminalInputOutput,
      handler: input => {
        const backend = current(input)
        if (backend.sessionRunId !== input.sessionRunId) throw new ControlError('stale_owner', 'Backend restarted; read its output before writing again')
        // No await between identity check and write. This preserves the same
        // prompt-delivery reservations and provider input rules as UI typing.
        if (!manager.write(input.sessionId, input.data)) throw new ControlError('unavailable', 'Backend refused input; inspect its current state')
        return { sessionId: input.sessionId, sessionRunId: input.sessionRunId, delivered: true as const }
      },
    }),
  ]
}
