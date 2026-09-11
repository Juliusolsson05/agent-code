import { ipcMain } from 'electron'
import { createHmac, randomBytes } from 'node:crypto'
import { resolve as resolvePath } from 'node:path'

import type {
  ConversationChildrenRequest, ConversationListRequest, ConversationPromptsRequest,
} from '@shared/conversations/types.js'
import type { ConversationService } from '@main/conversations/service.js'
import type { AppRunJournal } from '@main/incident/AppRunJournal.js'

// The one IPC surface for conversations: the picker, the path picker's
// session list, View Prompts and Rewind all read through these three
// channels. The old surface had one channel per lister (sessions:list,
// session:resume-list, history:*) and each returned a different row shape.
//
// One secret per app process, as in session.ts: the breadcrumb answers
// "did two listings target the same cwd in THIS run" without retaining the
// cwd, and cross-run joins are deliberately unsupported.
const TARGET_FINGERPRINT_KEY = randomBytes(32)
function fingerprint(cwd: string): string {
  return createHmac('sha256', TARGET_FINGERPRINT_KEY).update('conversations.list.target\0').update(resolvePath(cwd)).digest('hex')
}

export function registerConversationsIpc(service: ConversationService, appRunJournal?: AppRunJournal): void {
  ipcMain.handle('conversations:list', async (_evt, request: ConversationListRequest) => {
    const targetFingerprint = fingerprint(request.cwd)
    const providers = (request.providers ?? []).join(',')
    try {
      const response = await service.list(request)
      appRunJournal?.record({
        area: 'conversations.list',
        name: 'conversations.list.complete',
        data: { scope: request.scope, providers, targetFingerprint, resultCount: response.rows.length, hiddenChildren: response.hiddenChildren, total: response.total, ms: response.timing.ms, outcome: 'success' },
      })
      return response
    } catch (error) {
      // WHY reject instead of returning an empty response: an empty list
      // means the stores were read and held nothing. Collapsing a read
      // failure into that erased the only distinction #718 needed. The
      // renderer keeps its surface usable and shows the failure.
      // eslint-disable-next-line no-console
      console.warn('[conversations:list] failed:', error)
      appRunJournal?.record({
        area: 'conversations.list',
        name: 'conversations.list.error',
        severity: 'warn',
        data: { scope: request.scope, providers, targetFingerprint, outcome: 'error' },
      })
      throw error
    }
  })

  ipcMain.handle('conversations:prompts', (_evt, request: ConversationPromptsRequest) => service.prompts(request))
  ipcMain.handle('conversations:children', (_evt, request: ConversationChildrenRequest) => service.children(request))
}
