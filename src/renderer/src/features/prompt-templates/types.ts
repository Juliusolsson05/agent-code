import type { Workspace } from '@renderer/workspace/workspaceStore'

export type PromptTemplateContext = {
  workspace: Workspace
  sessionId: string
}

export type PromptTemplateInsertMode = 'replace' | 'append'

export type PromptTemplateVariable = {
  name: string
  label: string
  description: string
  defaultValue: string
  required: boolean
}

export type PromptTemplate = {
  id: string
  title: string
  description: string
  body: string
  buildBody?: (context: PromptTemplateContext) => string | Promise<string>
  scope: 'builtin' | 'custom'
  insertMode: PromptTemplateInsertMode
  variables: PromptTemplateVariable[]
  createdAt?: number
  updatedAt?: number
}

export type SavedPromptTemplateInput = {
  title: string
  description: string
  body: string
  insertMode: PromptTemplateInsertMode
  variables: PromptTemplateVariable[]
}

export type PromptTemplateVariableValueMap = Record<string, string>
