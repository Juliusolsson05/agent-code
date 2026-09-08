export type TerminalPasteTarget = {
  isActive(): boolean
  paste(text: string): Promise<boolean>
}

// Only the mounted xterm knows whether the application enabled bracketed
// paste, and only its leaf knows whether attach/replay has finished. A raw
// sendInput from a command bypasses both. Register that existing owner rather
// than adding a second terminal parser or inferring readiness from agent state.
const targets = new Map<string, Set<TerminalPasteTarget>>()

export function registerTerminalPasteTarget(sessionId: string, target: TerminalPasteTarget): () => void {
  const group = targets.get(sessionId) ?? new Set<TerminalPasteTarget>()
  group.add(target)
  targets.set(sessionId, group)
  return () => {
    group.delete(target)
    if (!group.size && targets.get(sessionId) === group) targets.delete(sessionId)
  }
}

export function getTerminalPasteTarget(sessionId: string): TerminalPasteTarget | null {
  return [...(targets.get(sessionId) ?? [])].find(target => target.isActive()) ?? null
}

export function encodeTerminalPaste(text: string, bracketed: boolean): string {
  const normalized = text.replace(/\r\n?/g, '\n')
  // Embedded ESC can close a bracketed paste; other control bytes can invoke
  // terminal actions. Refuse rather than silently change a credential/prompt.
  if (/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(normalized) || (!bracketed && normalized.includes('\t'))) {
    throw new Error('Paste contains terminal control characters; no input was sent.')
  }
  if (!bracketed && normalized.includes('\n')) {
    throw new Error('This terminal program has not enabled bracketed paste; multiline input was not sent.')
  }
  return bracketed ? `\x1b[200~${normalized}\x1b[201~` : normalized
}
