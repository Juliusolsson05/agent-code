// Phone chrome icon pipeline.
//
// WHY this module exists: the v1 chrome reached for emoji glyphs (🎤 ⏺ …)
// for the mic states — the one place the phone visibly broke the app's
// visual language. The desktop's canonical icon pipeline
// (features/editor/lib/fileIcon.tsx) bundles @iconify-json/vscode-icons
// bodies — but that set is FILE artwork: it has no mic, stop, send, or
// chevron glyphs at all (verified against the package's icons.json). So
// the phone authors the few chrome glyphs it needs as inline SVG and
// adopts the app's own marker vocabulary (❯ ⎿ ●) everywhere a marker can
// do the job:
//
//   - Send keeps its text label; the composer's ❯ identity already says
//     "send" in this app's language — a paper-plane icon would be the
//     foreign object.
//   - Stop keeps its labeled danger button (text is the clearest affordance
//     for a destructive action on a phone).
//   - Back stays the typographic ‹ (punctuation, not emoji).
//   - The mic is the one true icon need → IconMic below.
//
// All glyphs render as inline SVG with currentColor so they inherit theme
// tokens, are bundled at build time (no CDN — the CSP story stays
// img-src 'self'), and are aria-hidden decorative elements whose meaning
// the surrounding labeled control already carries.

type IconProps = {
  className?: string
}

/** Microphone glyph. `active` fills the capsule for the recording state —
 *  a state change expressed through the same shape, so idle→recording is
 *  a color/fill transition the user can track mid-glance, not two
 *  different emoji they have to re-recognize. */
export function IconMic({ active = false, className }: IconProps & { active?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill={active ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={active ? 0 : 2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      {/* Capsule (the mic body) */}
      <rect x="9" y="3" width="6" height="11" rx="3" />
      {/* Cradle arc + stand */}
      <path d="M6 11a6 6 0 0 0 12 0" fill="none" />
      <path d="M12 17v4" fill="none" />
    </svg>
  )
}
