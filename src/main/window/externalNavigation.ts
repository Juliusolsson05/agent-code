import { shell } from 'electron'

import { normalizeAllowedExternalUrl } from '@shared/renderedContent/targets.js'

export type ExternalOpenResult =
  | { ok: true; url: string }
  | { ok: false; error: string }

export async function openAllowedExternalUrl(rawUrl: string): Promise<ExternalOpenResult> {
  const url = normalizeAllowedExternalUrl(rawUrl)
  if (!url) return { ok: false, error: 'unsupported external URL' }

  // WHY main validates again even though renderer links are classified first:
  // assistant/provider markdown is untrusted input, and the renderer is not
  // the security boundary in an Electron app. Keeping the allow-list beside
  // shell.openExternal means a future raw <a>, window.open, or compromised
  // renderer path still cannot ask the OS to open file:, javascript:, data:,
  // or custom-scheme payloads through Agent Code's privileged main process.
  await shell.openExternal(url)
  return { ok: true, url }
}
