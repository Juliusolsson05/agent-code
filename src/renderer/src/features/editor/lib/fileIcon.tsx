import {
  DEFAULT_FILE,
  DEFAULT_FOLDER,
  DEFAULT_FOLDER_OPENED,
  getIconForFile,
  getIconForFolder,
  getIconForOpenFolder,
} from 'vscode-icons-js'

// File / folder icon glue.
//
// WHY a thin wrapper instead of inlining the calls everywhere:
//   - `vscode-icons-js` only exposes the *filename* (e.g. `file_type_ts.svg`)
//     for a given name. The actual SVGs live in the upstream `vscode-icons`
//     repo, which we serve through jsDelivr. Centralising the URL builder
//     lets us flip to a bundled copy later by changing one constant.
//   - We rely on the renderer's CSP allowing `https://cdn.jsdelivr.net` for
//     `img-src`. See src/renderer/index.html.
//
// The component intentionally degrades gracefully: if the lookup returns
// `undefined` (rare extensions, weird filenames) we fall back to the
// vscode-icons default file/folder glyphs so we never render a broken image.

const ICON_BASE_URL = 'https://cdn.jsdelivr.net/gh/vscode-icons/vscode-icons@latest/icons'

function iconUrl(filename: string): string {
  return `${ICON_BASE_URL}/${filename}`
}

type FileIconProps = {
  name: string
  className?: string
}

export function FileIcon({ name, className }: FileIconProps) {
  const icon = getIconForFile(name) ?? DEFAULT_FILE
  return (
    <img
      src={iconUrl(icon)}
      alt=""
      aria-hidden="true"
      draggable={false}
      className={className}
      width={16}
      height={16}
    />
  )
}

type FolderIconProps = {
  name: string
  open: boolean
  className?: string
}

export function FolderIcon({ name, open, className }: FolderIconProps) {
  const icon = open
    ? getIconForOpenFolder(name) ?? DEFAULT_FOLDER_OPENED
    : getIconForFolder(name) ?? DEFAULT_FOLDER
  return (
    <img
      src={iconUrl(icon)}
      alt=""
      aria-hidden="true"
      draggable={false}
      className={className}
      width={16}
      height={16}
    />
  )
}
