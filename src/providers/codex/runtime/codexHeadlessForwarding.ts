import type {
  CodexRolloutEntryObservation,
  CodexRolloutLine,
} from 'codex-headless'

type CodexRolloutSource = {
  on(
    event: 'rollout-entry',
    listener: (
      line: CodexRolloutLine,
      file: string,
      observation: CodexRolloutEntryObservation,
    ) => void,
  ): unknown
  off(
    event: 'rollout-entry',
    listener: (
      line: CodexRolloutLine,
      file: string,
      observation: CodexRolloutEntryObservation,
    ) => void,
  ): unknown
}

type CodexRolloutSink = {
  emit(
    event: 'jsonl-entry',
    line: CodexRolloutLine,
    file: string,
    observation: CodexRolloutEntryObservation,
  ): unknown
}

/**
 * Join codex-headless's authoritative rollout event to Agent Code's provider
 * event contract.
 *
 * WHY this tiny bridge is named and exported: transcript continuity spans a
 * pinned submodule and the app wrapper. Leaving the only join as an anonymous
 * callback inside `CodexSession.start()` made it impossible for a parent-level
 * regression to exercise the exact production forwarding code without
 * launching a real Codex PTY. The disposer also makes ownership explicit for
 * system harnesses; production still relies on the headless instance lifetime.
 */
export function forwardCodexRolloutEntries(
  source: CodexRolloutSource,
  sink: CodexRolloutSink,
): () => void {
  const listener = (
    line: CodexRolloutLine,
    file: string,
    observation: CodexRolloutEntryObservation,
  ): void => {
    sink.emit('jsonl-entry', line, file, observation)
  }
  source.on('rollout-entry', listener)
  return () => source.off('rollout-entry', listener)
}
