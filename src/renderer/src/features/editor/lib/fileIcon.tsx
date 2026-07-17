import { icons as bundledVsCodeIcons } from '@iconify-json/vscode-icons'
import {
  DEFAULT_FILE,
  DEFAULT_FOLDER,
  DEFAULT_FOLDER_OPENED,
  getIconForFile,
  getIconForFolder,
  getIconForOpenFolder,
} from 'vscode-icons-js'

type IconProps = {
  className?: string
}

type FileIconProps = IconProps & {
  name: string
}

type FolderIconProps = FileIconProps & {
  open: boolean
}

type BundledIcon = {
  body: string
  width?: number
  height?: number
}

function iconifyName(filename: string): string {
  // vscode-icons-js returns upstream asset filenames such as
  // `file_type_typescript.svg`; Iconify packages the same artwork under the
  // equivalent kebab-case key. Keeping this tiny adapter means the mature
  // filename/folder lookup remains the source of truth instead of maintaining
  // our own inevitably incomplete extension table.
  return filename.replace(/\.svg$/i, '').replace(/_/g, '-')
}

function bundledIcon(filename: string, fallback: string): BundledIcon {
  const icons = bundledVsCodeIcons.icons as Record<string, BundledIcon>
  return icons[iconifyName(filename)] ?? icons[iconifyName(fallback)]
}

function LocalVsCodeIcon({
  filename,
  fallback,
  className,
}: IconProps & { filename: string; fallback: string }) {
  const icon = bundledIcon(filename, fallback)
  const width = icon.width ?? bundledVsCodeIcons.width ?? 32
  const height = icon.height ?? bundledVsCodeIcons.height ?? 32
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={16}
      height={16}
      aria-hidden="true"
      focusable="false"
      className={className}
      // WHY trusted inner SVG is acceptable here: this body comes from the
      // exact, lockfile-pinned @iconify-json package at build time—not from a
      // filename, workspace, network response, or other runtime input. Parsing
      // 1,500 upstream SVGs into handwritten React trees would create a larger,
      // less auditable generated source surface without improving the trust
      // boundary. The package body is bundled into our renderer JavaScript and
      // remains covered by the existing `img-src 'self'` CSP.
      dangerouslySetInnerHTML={{ __html: icon.body }}
    />
  )
}

/** VS Code Icons artwork with local, deterministic delivery.
 *
 * `vscode-icons-js` chooses the same rich per-file icon users already know;
 * `@iconify-json/vscode-icons` supplies the matching SVG body inside the app
 * bundle. This deliberately restores the old visual language without bringing
 * back the old `@latest` CDN dependency or its offline/CSP failure mode.
 */
export function FileIcon({ name, className }: FileIconProps) {
  return (
    <LocalVsCodeIcon
      filename={getIconForFile(name) ?? DEFAULT_FILE}
      fallback={DEFAULT_FILE}
      className={className}
    />
  )
}

export function FolderIcon({ name, open, className }: FolderIconProps) {
  return (
    <LocalVsCodeIcon
      filename={
        open
          ? getIconForOpenFolder(name) ?? DEFAULT_FOLDER_OPENED
          : getIconForFolder(name) ?? DEFAULT_FOLDER
      }
      fallback={open ? DEFAULT_FOLDER_OPENED : DEFAULT_FOLDER}
      className={className}
    />
  )
}
