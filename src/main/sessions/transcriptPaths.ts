import { existsSync } from 'fs'

import {
  findCodexRolloutPathBySessionId,
  getClaudeSessionFilePath,
} from '@main/providerSwitch/shared.js'

export type TranscriptPathRequest = {
  sessionId: string
  kind: 'claude' | 'codex'
  cwd: string
  providerSessionId: string
}

export type TranscriptPathResult = TranscriptPathRequest & {
  transcriptPath: string | null
  exists: boolean
}

/**
 * Resolve durable provider transcript locations for renderer prompt templates.
 *
 * WHY this lives in main instead of the command itself: Claude and
 * Codex deliberately store sessions in different layouts. Claude is
 * per-cwd under a sanitized project directory; Codex is global and
 * date-bucketed. The renderer already has enough metadata to identify
 * a transcript (`kind`, `cwd`, `providerSessionId`), but teaching it
 * the path math would create a second source of truth next to the
 * history loader, provider switch, and duplicate flows. Keeping the
 * resolution here means a future storage change gets fixed once.
 */
export async function resolveTranscriptPath(
  request: TranscriptPathRequest,
): Promise<TranscriptPathResult> {
  let transcriptPath: string | null
  if (request.kind === 'claude') {
    transcriptPath = await getClaudeSessionFilePath(
      request.cwd,
      request.providerSessionId,
    )
  } else {
    transcriptPath = await findCodexRolloutPathBySessionId(
      request.providerSessionId,
    )
  }

  return {
    ...request,
    transcriptPath,
    exists: transcriptPath ? existsSync(transcriptPath) : false,
  }
}

export async function resolveTranscriptPaths(
  requests: TranscriptPathRequest[],
): Promise<TranscriptPathResult[]> {
  return Promise.all(requests.map(request => resolveTranscriptPath(request)))
}
