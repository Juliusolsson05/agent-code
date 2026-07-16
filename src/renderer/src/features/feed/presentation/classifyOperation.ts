import type { AgentProviderKind } from '@shared/types/providerKind'

import { classifyUnifiedExecScript } from '@providers/codex/renderer/extractors'

import type {
  OperationClassification,
  OperationFamily,
} from '@renderer/features/feed/presentation/types'

export type ClassifyOperationInput = {
  provider: AgentProviderKind
  toolName: string
  rawInput?: string | null
  finalized?: boolean
}

const COMMAND_NAMES = new Set([
  'bash',
  'powershell',
  'exec_command',
  'local_shell',
  'local_shell_call',
  'shell',
])
const TERMINAL_NAMES = new Set(['write_stdin', 'wait', 'wait_terminal'])
const FILE_CHANGE_NAMES = new Set([
  'edit',
  'edit_file',
  'multiedit',
  'write',
  'write_file',
  'patch',
  'apply_patch',
])
const READ_NAMES = new Set(['read', 'fileread', 'read_file'])
const SEARCH_NAMES = new Set([
  'grep',
  'glob',
  'ls',
  'list_files',
  'toolsearch',
  'tool_search',
  'tool_search_call',
  'search_transcript',
  'read_transcript',
])
const WEB_NAMES = new Set([
  'web__run',
  'websearch',
  'webfetch',
  'web_search',
  'web_search_call',
  'open_page',
  'find_in_page',
])
const QUESTION_NAMES = new Set(['askuserquestion', 'request_user_input'])
const IMAGE_NAMES = new Set([
  'image_generation',
  'image_generation_call',
  'image_gen__imagegen',
  'imagegen',
  'view_image',
])
const MCP_NAMES = new Set([
  'read_mcp_resource',
  'list_mcp_resources',
  'list_mcp_resource_templates',
])
const NOTEBOOK_NAMES = new Set(['notebookedit', 'notebook_edit'])
const CODE_INTELLIGENCE_NAMES = new Set([
  'lsp',
  'go_to_definition',
  'find_references',
  'document_symbols',
])

const TASK_PLAN_PATTERN = /^(?:todo(?:write)?|update_plan|create_goal|update_goal|get_goal|task(?:create|update|list|get|output|stop)|schedulewakeup|sleep)$/
const COLLABORATION_PATTERN = /^(?:agent|task|teamcreate|teamdelete|sendmessage|spawn_agent|send_message|followup_task|wait_agent|list_agents|close_agent|orchestration_(?:create|read|send|wait|list|close)_?agents?)$/
const SKILL_PATTERN = /^(?:skill|workflow|artifact|reportfindings|monitor|list_available_plugins_to_install|request_plugin_install)$/
const WORKSPACE_PATTERN = /^(?:ai_workspace.*|enterworktree|exitworktree|config|enterplanmode|exitplanmode|enter_plan_mode|exit_plan_mode)$/

function result(
  family: OperationFamily,
  evidence: string,
  confidence: OperationClassification['confidence'] = 'final',
): OperationClassification {
  return { family, evidence, confidence }
}

/**
 * Classify a wire-level tool as user-visible work without parsing a provider's
 * whole protocol.
 *
 * WHY a boring finite table beats a detector framework here: the transcript
 * corpus has a long tail of names, but only a small stable set of user intents.
 * A total switch is easy to audit and every new special case must arrive with a
 * fixture.  A rules engine would merely hide the same conditionals behind a
 * second vocabulary and make precedence bugs much harder to see.
 */
export function classifyOperation({
  provider,
  toolName,
  rawInput = null,
  finalized = true,
}: ClassifyOperationInput): OperationClassification {
  const normalized = toolName.trim().toLowerCase()

  // Modern Codex's `exec` is a generated JavaScript wrapper, so the name says
  // nothing about intent.  Its narrow partial-safe scanner recognizes patch
  // literals before the eventual tools.apply_patch call is present.  Until a
  // structural clue exists we explicitly paint "Preparing" instead of leaking
  // raw wrapper JavaScript into the feed.
  if (provider === 'codex' && normalized === 'exec') {
    const action = classifyUnifiedExecScript(rawInput ?? '')
    if (action?.kind === 'apply_patch') {
      return result('file-change', 'decoded unified-exec patch literal', finalized ? 'final' : 'structural')
    }
    if (action?.kind === 'exec_command') {
      return result('command', 'decoded unified-exec command call', finalized ? 'final' : 'structural')
    }
    if (action?.kind === 'write_stdin' || action?.kind === 'wait') {
      return result('terminal-interaction', `decoded unified-exec ${action.kind}`, finalized ? 'final' : 'structural')
    }
    if (action?.kind === 'tool_call') {
      const nested = classifyOperation({
        provider,
        toolName: action.toolName,
        finalized,
      })
      return {
        ...nested,
        confidence: finalized ? 'final' : 'structural',
        evidence: `decoded unified-exec tools.${action.toolName} call`,
        displayToolName: action.toolName,
        structuredInput: action.input,
      }
    }
    return finalized
      ? result('generic', 'completed unified-exec wrapper had no known user-intent call')
      : result('preparing', 'unified-exec input has not exposed a structural intent yet', 'hint')
  }

  if (FILE_CHANGE_NAMES.has(normalized)) return result('file-change', `known file-change tool ${toolName}`)
  if (COMMAND_NAMES.has(normalized)) return result('command', `known command tool ${toolName}`)
  if (TERMINAL_NAMES.has(normalized)) return result('terminal-interaction', `known terminal continuation ${toolName}`)
  if (READ_NAMES.has(normalized)) return result('read', `known read tool ${toolName}`)
  if (SEARCH_NAMES.has(normalized)) return result('search', `known search/discovery tool ${toolName}`)
  if (WEB_NAMES.has(normalized)) return result('web', `known web tool ${toolName}`)
  if (QUESTION_NAMES.has(normalized)) return result('question', `known blocking question tool ${toolName}`)
  if (IMAGE_NAMES.has(normalized)) return result('image', `known image tool ${toolName}`)
  if (NOTEBOOK_NAMES.has(normalized)) return result('notebook', `known notebook edit tool ${toolName}`)
  if (CODE_INTELLIGENCE_NAMES.has(normalized)) return result('code-intelligence', `known code-intelligence tool ${toolName}`)
  if (
    COLLABORATION_PATTERN.test(normalized) ||
    /(?:^|__)orchestration_(?:create|read|send|wait|list|close)_?agents?$/.test(normalized)
  ) {
    return result('collaboration', `known collaboration tool ${toolName}`)
  }
  if (TASK_PLAN_PATTERN.test(normalized)) return result('task-plan', `known task/plan tool ${toolName}`)
  if (SKILL_PATTERN.test(normalized)) return result('skill-workflow', `known skill/workflow tool ${toolName}`)
  if (WORKSPACE_PATTERN.test(normalized)) return result('workspace', `known workspace tool ${toolName}`)

  // MCP is intentionally checked after Agent Code's orchestration vocabulary:
  // a prefixed orchestration call is still collaboration from the user's point
  // of view.  All other MCP calls share one structured rich-output family.
  if (normalized.startsWith('mcp__') || MCP_NAMES.has(normalized)) {
    return result('mcp', `MCP tool ${toolName}`)
  }

  return result('generic', toolName ? `unrecognized tool name ${toolName}` : 'missing tool name')
}
