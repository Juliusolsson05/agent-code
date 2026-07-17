import { tryExtractJson } from '@providers/shared/renderer/rows/jsonToolPresentation'
import { asRecord } from '@shared/lib/asRecord'
import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'

// Agent Code owns these MCP schemas in createBuiltInMcpServer.ts. That source
// contract—not a name resemblance in a captured third-party server—is what
// permits a custom renderer. Provider adapters decide whether a wire name is
// genuinely in the Agent Code namespace before calling this parser.
export const AGENT_CODE_WORKSPACE_TOOLS = [
  'ai_workspace_create',
  'ai_workspace_attach_file',
  'ai_workspace_detach_file',
  'ai_workspace_list_files',
  'ai_workspace_list_workspaces',
  'ai_workspace_open',
  'ai_workspace_clear',
  'ai_workspace_delete',
] as const

export type AgentCodeWorkspaceTool = typeof AGENT_CODE_WORKSPACE_TOOLS[number]

export type AgentCodeWorkspaceModel = {
  operationId: string
  tool: AgentCodeWorkspaceTool
  action: string
  subject: string | null
  workspaceId: string | null
  path: string | null
  input: Record<string, unknown>
}

export type AgentCodeWorkspaceResult = {
  ok: boolean
  value: Record<string, unknown>
  source: string
  summary: string | null
}

const ACTIONS: Record<AgentCodeWorkspaceTool, string> = {
  ai_workspace_create: 'Create workspace',
  ai_workspace_attach_file: 'Attach file',
  ai_workspace_detach_file: 'Detach file',
  ai_workspace_list_files: 'List files',
  ai_workspace_list_workspaces: 'List workspaces',
  ai_workspace_open: 'Open workspace',
  ai_workspace_clear: 'Clear workspace',
  ai_workspace_delete: 'Delete workspace',
}

const TOOL_SET = new Set<string>(AGENT_CODE_WORKSPACE_TOOLS)

export function isAgentCodeWorkspaceTool(value: string): value is AgentCodeWorkspaceTool {
  return TOOL_SET.has(value)
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && /\S/.test(value) ? value : null
}

export function fromAgentCodeWorkspaceUse(
  block: ToolUseBlock,
  tool: AgentCodeWorkspaceTool,
): AgentCodeWorkspaceModel | null {
  const input = asRecord(block.input)
  if (!input || !/\S/.test(block.id)) return null

  const workspaceId = nonEmptyString(input.workspaceId)
  const path = nonEmptyString(input.path)
  const name = nonEmptyString(input.name)

  // Required fields mirror the registered Zod schemas. Prefixes and drifted
  // inputs must fall through visibly; a workspace card that silently invents
  // an identity is less truthful than the generic JSON row.
  if (tool === 'ai_workspace_create' && !name) return null
  if (tool === 'ai_workspace_attach_file' && (!workspaceId || !path)) return null
  if (
    tool !== 'ai_workspace_create' &&
    tool !== 'ai_workspace_list_workspaces' &&
    !workspaceId
  ) return null

  const subject = tool === 'ai_workspace_create'
    ? name
    : tool === 'ai_workspace_attach_file'
      ? nonEmptyString(input.title) ?? path
      : tool === 'ai_workspace_detach_file'
        ? path ?? nonEmptyString(input.entryId) ?? workspaceId
        : workspaceId

  return {
    operationId: block.id,
    tool,
    action: ACTIONS[tool],
    subject,
    workspaceId,
    path,
    input,
  }
}

function resultText(result: ToolResultBlock): string | null {
  if (typeof result.content === 'string') return result.content
  if (!Array.isArray(result.content) || result.content.length !== 1) return null
  const item = asRecord(result.content[0])
  return item?.type === 'text' && typeof item.text === 'string' ? item.text : null
}

function resultSummary(value: Record<string, unknown>): string | null {
  const workspace = asRecord(value.workspace)
  const entry = asRecord(value.entry)
  const workspaceName = nonEmptyString(workspace?.name)
  if (workspaceName) return workspaceName
  const entryTitle = nonEmptyString(entry?.title)
  if (entryTitle) return entryTitle
  const entryPath = nonEmptyString(entry?.path)
  if (entryPath) return entryPath
  if (Array.isArray(value.workspaces)) {
    return `${value.workspaces.length.toLocaleString()} ${value.workspaces.length === 1 ? 'workspace' : 'workspaces'}`
  }
  if (workspace && Array.isArray(workspace.entries)) {
    return `${workspace.entries.length.toLocaleString()} ${workspace.entries.length === 1 ? 'file' : 'files'}`
  }
  return nonEmptyString(value.message)
}

export function fromAgentCodeWorkspaceResult(
  result: ToolResultBlock,
  source: AgentCodeWorkspaceModel,
): AgentCodeWorkspaceResult | null {
  if (result.tool_use_id !== source.operationId) return null
  const text = resultText(result)
  if (text === null) return null
  const parsed = tryExtractJson(text)
  const value = asRecord(parsed)
  // Every source-controlled workspace result returns an explicit `ok`. This
  // gate is what makes absorption safe: future typed content or additional
  // transport blocks remain visible in the generic result row until modeled.
  if (!value || typeof value.ok !== 'boolean') return null
  return {
    ok: value.ok,
    value,
    source: text,
    summary: resultSummary(value),
  }
}
