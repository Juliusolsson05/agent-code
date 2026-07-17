type FileIconProps = {
  name: string
  className?: string
}

const EXTENSION_BADGES: Record<string, { label: string; color: string }> = {
  ts: { label: 'TS', color: 'text-blue-400' },
  tsx: { label: 'TX', color: 'text-blue-300' },
  js: { label: 'JS', color: 'text-yellow-300' },
  jsx: { label: 'JX', color: 'text-yellow-200' },
  py: { label: 'PY', color: 'text-green-300' },
  rs: { label: 'RS', color: 'text-orange-300' },
  go: { label: 'GO', color: 'text-cyan-300' },
  json: { label: '{}', color: 'text-yellow-200' },
  md: { label: 'M↓', color: 'text-sky-300' },
  css: { label: '#', color: 'text-violet-300' },
  html: { label: '<>', color: 'text-orange-300' },
  sh: { label: '>_', color: 'text-green-300' },
}

function extensionOf(name: string): string {
  const index = name.lastIndexOf('.')
  return index > 0 ? name.slice(index + 1).toLowerCase() : ''
}

// The previous icon layer fetched unpinned SVGs from a CDN for every file.
// That made the explorer blank offline, leaked filenames-by-extension timing
// to a third party, and let upstream visuals change without a release. These
// compact code-native glyphs are deterministic, CSP-local, and intentionally
// legible at the tree's real 16px size.
export function FileIcon({ name, className }: FileIconProps) {
  const badge = EXTENSION_BADGES[extensionOf(name)] ?? {
    label: '·',
    color: 'text-muted',
  }
  return (
    <span
      aria-hidden="true"
      className={`flex h-4 w-3.5 items-center justify-center rounded-[2px] border border-current/40 bg-surface-hi font-code text-[6px] font-semibold leading-none ${badge.color} ${className ?? ''}`}
    >
      {badge.label}
    </span>
  )
}

type FolderIconProps = {
  name: string
  open: boolean
  className?: string
}

export function FolderIcon({ open, className }: FolderIconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      aria-hidden="true"
      className={`text-amber-300/90 ${className ?? ''}`}
      fill="none"
    >
      <path
        d={open ? 'M1.5 5.25h13l-1.35 7H2.85l-1.35-7Z' : 'M1.5 3.25h4l1.25 1.5h7.75v7.5h-13v-9Z'}
        fill="currentColor"
        fillOpacity={open ? 0.72 : 0.58}
        stroke="currentColor"
        strokeWidth="0.8"
        strokeLinejoin="round"
      />
    </svg>
  )
}
