import { cwdBasename, providerGlyph } from '@renderer/features/workspace/lib/sessionDisplay'
import { relativeTime } from '@renderer/lib/relativeTime'
import { isFallbackLabel } from '@shared/types/sessionDisplayIdentity'
import type { SessionDisplayIdentity } from '@shared/types/sessionDisplayIdentity'

// SessionPickerRow — the one way a past conversation is identified in the UI.
//
// WHY this exists (#96)
// ---------------------
// Three surfaces let a user pick a past session — the PathPicker resume list,
// the command palette, and prompt search — and each rendered its own identity
// for the same conversation. The resume list led with a flattened `summary` and
// permanently showed `sessionId.slice(0, 8)` underneath; the palette used a
// `summary || firstPrompt || sessionId` chain that could fall through to a full
// untruncated uuid; prompt search led with a provider glyph and cwd basename.
// A user who remembered a conversation by what they typed was shown a hex id.
//
// This component is the display half of the fix. It is deliberately dumb: it
// renders a `SessionDisplayIdentity` and makes NO decision about what a session
// is called. That decision belongs to the ladder in main
// (@shared/types/sessionDisplayIdentity), and duplicating any part of it here
// would recreate the divergence — a second opinion about identity is exactly
// what #96 is.
//
// WHY the fallback is visually marked rather than silently rendered: the
// difference between "the user titled this conversation `agent-code`" and "we
// gave up and used the folder name" is the difference between a name and a
// shrug. Showing both as plain text is what made the old surfaces feel
// arbitrary. `labelSource` carries that distinction across the process boundary
// precisely so this row can honour it.
//
// Composition, not replacement: prompt search keeps its prompt-list body and
// mounts this as its header via `trailing`/`children`. The goal is one identity
// everywhere, not one layout everywhere.

export function SessionPickerRow({
  identity,
  trailing,
  compact = false,
}: {
  identity: SessionDisplayIdentity
  /** Right-aligned slot for surface-specific affordances (match counts,
   *  "resuming…", a branch chip). Kept as a slot so a surface never has to
   *  fork the component to add one badge. */
  trailing?: React.ReactNode
  /** Single-line variant for dense lists (the command palette). The identity
   *  and its fallback marking are identical; only the metadata line is
   *  dropped. */
  compact?: boolean
}) {
  const fallback = isFallbackLabel(identity.labelSource)
  const project = cwdBasename(identity.cwd ?? '')

  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-baseline gap-2 min-w-0">
        <span
          className="text-accent font-semibold select-none w-4 text-center flex-shrink-0"
          aria-hidden="true"
        >
          {providerGlyph(identity.kind)}
        </span>
        <span
          className={
            'truncate text-[12px] ' + (fallback ? 'italic text-ink-dim' : 'text-ink')
          }
          // The fallback rungs are not names the conversation chose, so a
          // sighted user gets italics and everyone else gets it said out loud.
          title={
            fallback
              ? `No title recorded — showing ${
                  identity.labelSource === 'cwd' ? 'the project folder' : 'the session id'
                }`
              : identity.label
          }
        >
          {identity.label}
        </span>
        {trailing ? <span className="ml-auto flex-shrink-0">{trailing}</span> : null}
      </div>

      {compact ? null : (
        <div className="mt-0.5 flex items-center gap-2 text-[10px] text-muted min-w-0">
          {/* The project is dropped when it IS the label — repeating a folder
              name on both lines reads as a rendering bug rather than context. */}
          {project && identity.labelSource !== 'cwd' ? (
            <>
              <span className="truncate max-w-[160px]">{project}</span>
              <span className="opacity-40">·</span>
            </>
          ) : null}
          {identity.gitBranch ? (
            <>
              <span className="truncate max-w-[140px]">{identity.gitBranch}</span>
              <span className="opacity-40">·</span>
            </>
          ) : null}
          <span className="tabular-nums">{relativeTime(identity.lastActivityAt)}</span>
        </div>
      )}
    </div>
  )
}
