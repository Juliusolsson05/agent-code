// The host-owned loading shell for extension views.
//
// WHY a sized, animated shell instead of the old text line: an extension's
// first paint can trail its open by hundreds of milliseconds (bundle fetch +
// module activation + the extension's own scene construction). A bare
// "Loading…" text sliver starts the modal at text height and then VISIBLY
// jumps when the frame reports its stage — users read that jump as slowness.
// A steady, motion-bearing, fixed-size placeholder reads as "working" for the
// same elapsed time. Host-owned so every extension gets it for free; an
// extension's own branded first paint simply replaces it when ready.

export function ExtensionLoadingShell({ displayName }: { displayName: string }) {
  return (
    <div
      role="status"
      aria-label={`Loading ${displayName}`}
      className="flex h-[min(560px,72vh)] w-[min(880px,80vw)] flex-col items-center justify-center gap-4"
    >
      <span className="extension-loading-ring" aria-hidden />
      <div className="text-[13px] text-ink">{displayName}</div>
      <div className="text-[12px] text-muted">Starting…</div>
    </div>
  )
}
