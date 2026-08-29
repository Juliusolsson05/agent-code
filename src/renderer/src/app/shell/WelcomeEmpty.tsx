// Shown when there are zero tabs — either first launch before the
// default session spawns, or the user closed everything.
// (Moved verbatim from App.tsx by #494.)
export function WelcomeEmpty({ onNewTabRequest }: { onNewTabRequest: () => void }) {
  return (
    <div className="h-full flex items-center justify-center">
      <div className="flex flex-col items-center gap-3">
        <div className="text-muted text-[12px]">no tabs open</div>
        <button
          type="button"
          onClick={onNewTabRequest}
          className="rounded-control
            px-4 py-2 text-[12px]
            bg-accent text-accent-fg
            border border-accent
            hover:brightness-110
            transition-all duration-120
          "
        >
          new tab (⌘T)
        </button>
      </div>
    </div>
  )
}
