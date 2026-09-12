import { ipcRenderer } from 'electron'

import type {
  Conversation, ConversationChildrenRequest, ConversationListRequest, ConversationListResponse,
  ConversationPrompt, ConversationPromptsRequest,
} from '@shared/conversations/types.js'

// The Conversations picker, the path picker's session list, View Prompts and
// Rewind all read through these three calls. Types come from @shared so the
// renderer and main cannot drift apart (the old listing row type lived twice).
export const conversationsApi = {
  listConversations: (request: ConversationListRequest): Promise<ConversationListResponse> =>
    ipcRenderer.invoke('conversations:list', request),
  listConversationPrompts: (request: ConversationPromptsRequest): Promise<ConversationPrompt[]> =>
    ipcRenderer.invoke('conversations:prompts', request),
  listConversationChildren: (request: ConversationChildrenRequest): Promise<Conversation[]> =>
    ipcRenderer.invoke('conversations:children', request),
}
