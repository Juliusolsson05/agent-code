import { parse } from 'acorn'

import { stripCodexTransportEnvelope, codexTransportEnvelopeStatus } from '@providers/codex/renderer/adapters/command'
import { toolResultContentText } from '@providers/shared/renderer/rows/toolResultContent'
import { asRecord } from '@shared/lib/asRecord'
import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'

const MAX_SCRIPT_CHARS = 256 * 1024
const MAX_LITERAL_DEPTH = 8
const MAX_LITERAL_FIELDS = 64
const MAX_AST_NODES = 20_000
const MAX_WAIT_NUMBER = Number.MAX_SAFE_INTEGER

export type CodexEmbeddedOperationModel = {
  operationId: string
  toolName: string
  action: string
  subject: string | null
  input: Record<string, unknown>
  exactScript: string
  resultPresent: boolean
  finalized: boolean
  failed: boolean
}

export type CodexWaitStatus =
  | 'waiting'
  | 'running'
  | 'completed'
  | 'request completed'
  | 'response received'
  | 'terminated'
  | 'failed'

export type CodexWaitOperationModel = {
  operationId: string
  cellId: string
  yieldTimeMs: number | null
  maxTokens: number | null
  terminate: boolean
  status: CodexWaitStatus
  resultPresent: boolean
  finalized: boolean
  failed: boolean
}

const ACTIONS: Record<string, string> = {
  workflow_run: 'Run workflow',
  workflow_resume: 'Resume workflow',
  workflow_run_status: 'Check workflow status',
  workflow_run_events: 'Read workflow events',
  workflow_run_cancel: 'Cancel workflow',
  workflow_result_read: 'Read workflow result',
  orchestration_create_agent: 'Create agent',
  orchestration_send_prompt: 'Send agent prompt',
  orchestration_list_agents: 'List agents',
  orchestration_read_agent: 'Read agent',
  orchestration_read_run_outputs: 'Read run outputs',
  orchestration_wait_agents: 'Wait for agents',
  orchestration_close_agent: 'Close agent',
  orchestration_close_run: 'Close run',
}

type AstNode = {
  type: string
  [key: string]: unknown
}

type StaticLiteralState = {
  fields: number
}

const INVALID = Symbol('invalid-literal')

/**
 * Recover the meaningful Agent Code operation from Codex's unified `exec`
 * transport without evaluating general JavaScript.
 *
 * WHY this uses a real JavaScript parser instead of a token scanner: the card
 * collapses the raw script by default, so admission is a truth claim about the
 * complete executable program. A scanner that recognizes only dot-form calls
 * can miss `tools["mcp__agent_code__workflow_run_cancel"](...)`, and parsing
 * only one argument list can specialize a program that V8 rejects later. The
 * AST proves whole-program syntax and lets one uniqueness rule cover dot and
 * computed member access. We still interpret only a tiny static-literal subset;
 * parsing source is not permission to evaluate it.
 *
 * WHY identity and result ownership remain separate: a script may call one
 * proven MCP tool and then project, filter, or annotate its result. The literal
 * call is still the honest user-visible operation, but absorbing arbitrary
 * projection output would hide bytes whose provenance is unproven.
 */
export function fromCodexEmbeddedOperation(input: {
  toolUse: ToolUseBlock
  result: ToolResultBlock | null
  finalized?: boolean
}): CodexEmbeddedOperationModel | null {
  if (input.toolUse.name !== 'exec') return null
  const raw = asRecord(input.toolUse.input)?.raw
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_SCRIPT_CHARS) return null

  const call = directAgentCodeCall(raw)
  if (!call) return null
  const action = ACTIONS[call.operation] ?? humanizeOperation(call.operation)
  return {
    operationId: input.toolUse.id,
    toolName: `mcp__agent_code__${call.operation}`,
    action,
    subject: operationSubject(call.input),
    input: call.input,
    exactScript: raw,
    resultPresent: input.result !== null,
    finalized: input.finalized === true,
    failed: input.result?.is_error === true,
  }
}

export function fromCodexWaitOperation(input: {
  toolUse: ToolUseBlock
  result: ToolResultBlock | null
  finalized?: boolean
}): CodexWaitOperationModel | null {
  if (input.toolUse.name !== 'wait') return null
  const value = asRecord(input.toolUse.input)
  if (!value || typeof value.cell_id !== 'string' || !/\S/.test(value.cell_id)) return null
  if (!onlyKeys(value, ['cell_id', 'yield_time_ms', 'max_tokens', 'terminate'])) return null
  if (value.terminate !== undefined && typeof value.terminate !== 'boolean') return null
  const yieldTimeMs = optionalBoundedInteger(value.yield_time_ms)
  const maxTokens = optionalBoundedInteger(value.max_tokens)
  if (value.yield_time_ms !== undefined && yieldTimeMs === null) return null
  if (value.max_tokens !== undefined && maxTokens === null) return null
  const finalized = input.finalized === true
  const failed = input.result?.is_error === true
  return {
    operationId: input.toolUse.id,
    cellId: value.cell_id,
    yieldTimeMs,
    maxTokens,
    terminate: value.terminate === true,
    status: waitStatus(input.result, finalized, failed),
    resultPresent: input.result !== null,
    finalized,
    failed,
  }
}

function directAgentCodeCall(source: string): {
  operation: string
  input: Record<string, unknown>
} | null {
  let program: AstNode
  try {
    program = parse(source, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowAwaitOutsideFunction: true,
    }) as unknown as AstNode
  } catch {
    return null
  }

  const toolCalls: Array<{ call: AstNode; operation: string | null }> = []
  let agentCodeMemberCount = 0
  let nodeCount = 0
  const stack: AstNode[] = [program]
  while (stack.length > 0) {
    const node = stack.pop()!
    nodeCount += 1
    if (nodeCount > MAX_AST_NODES) return null

    if (node.type === 'MemberExpression' && identifierName(node.object) === 'tools') {
      const property = memberPropertyName(node)
      // WHY a dynamic `tools[name]` access fails closed: the renderer cannot
      // prove that `name` is not an Agent Code operation hidden beside the one
      // it plans to summarize. Static non-Agent-Code tool calls are also
      // counted below so the card never conceals a second tool side effect.
      if (property === null) return null
      if (property.startsWith('mcp__agent_code__')) agentCodeMemberCount += 1
    }

    if (node.type === 'CallExpression') {
      const callee = astNode(node.callee)
      if (callee?.type === 'MemberExpression' && identifierName(callee.object) === 'tools') {
        const property = memberPropertyName(callee)
        if (property === null) return null
        toolCalls.push({
          call: node,
          operation: property.startsWith('mcp__agent_code__')
            ? property.slice('mcp__agent_code__'.length)
            : null,
        })
      }
    }

    pushChildNodes(node, stack)
  }

  // WHY exactly one `tools` call, not merely one Agent Code call: a collapsed
  // “Check workflow status” card must not conceal a second exec/cancel/send
  // side effect. Global projection helpers such as text()/image() remain legal.
  if (toolCalls.length !== 1 || agentCodeMemberCount !== 1) return null
  const selected = toolCalls[0]
  if (!selected.operation || !isTopLevelAwaitedCall(program, selected.call)) return null

  const args = Array.isArray(selected.call.arguments) ? selected.call.arguments : []
  if (args.length !== 1) return null
  const value = staticLiteral(astNode(args[0]), 0, { fields: 0 })
  const record = value === INVALID ? null : asRecord(value)
  return record ? { operation: selected.operation, input: record } : null
}

function isTopLevelAwaitedCall(program: AstNode, call: AstNode): boolean {
  const statements = Array.isArray(program.body) ? program.body : []
  for (const value of statements) {
    const statement = astNode(value)
    if (!statement) continue
    if (statement.type === 'ExpressionStatement') {
      const expression = astNode(statement.expression)
      if (expression?.type === 'AwaitExpression' && expression.argument === call) return true
    }
    if (statement.type !== 'VariableDeclaration') continue
    const declarations = Array.isArray(statement.declarations) ? statement.declarations : []
    if (declarations.length !== 1) continue
    const declaration = astNode(declarations[0])
    const id = astNode(declaration?.id)
    const init = astNode(declaration?.init)
    if (
      id?.type === 'Identifier' &&
      init?.type === 'AwaitExpression' &&
      init.argument === call
    ) return true
  }
  return false
}

function staticLiteral(
  node: AstNode | null,
  depth: number,
  state: StaticLiteralState,
): unknown | typeof INVALID {
  if (!node || depth > MAX_LITERAL_DEPTH) return INVALID
  if (node.type === 'Literal') {
    const value = node.value
    return value === null || typeof value === 'string' || typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))
      ? value
      : INVALID
  }
  if (node.type === 'UnaryExpression' && node.operator === '-') {
    const argument = astNode(node.argument)
    if (argument?.type !== 'Literal' || typeof argument.value !== 'number') return INVALID
    const value = -argument.value
    return Number.isFinite(value) ? value : INVALID
  }
  if (node.type === 'ArrayExpression') {
    const elements = Array.isArray(node.elements) ? node.elements : []
    const result: unknown[] = []
    for (const element of elements) {
      state.fields += 1
      if (state.fields > MAX_LITERAL_FIELDS) return INVALID
      const value = staticLiteral(astNode(element), depth + 1, state)
      if (value === INVALID) return INVALID
      result.push(value)
    }
    return result
  }
  if (node.type !== 'ObjectExpression') return INVALID

  // WHY a null prototype remains necessary even with an AST: assigning a
  // parsed `__proto__` key to `{}` invokes the legacy setter. The renderer is
  // interpreting data, not reproducing ambient object-prototype behavior.
  const result = Object.create(null) as Record<string, unknown>
  const properties = Array.isArray(node.properties) ? node.properties : []
  for (const rawProperty of properties) {
    const property = astNode(rawProperty)
    if (
      !property ||
      property.type !== 'Property' ||
      property.kind !== 'init' ||
      property.method === true ||
      property.shorthand === true ||
      property.computed === true
    ) return INVALID
    const keyNode = astNode(property.key)
    const key = keyNode?.type === 'Identifier'
      ? identifierName(keyNode)
      : keyNode?.type === 'Literal' && typeof keyNode.value === 'string'
        ? keyNode.value
        : null
    if (
      key === null ||
      key === '__proto__' ||
      Object.prototype.hasOwnProperty.call(result, key)
    ) return INVALID
    state.fields += 1
    if (state.fields > MAX_LITERAL_FIELDS) return INVALID
    const value = staticLiteral(astNode(property.value), depth + 1, state)
    if (value === INVALID) return INVALID
    result[key] = value
  }
  return result
}

function pushChildNodes(node: AstNode, stack: AstNode[]): void {
  for (const [key, value] of Object.entries(node)) {
    if (key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue
    const child = astNode(value)
    if (child) {
      stack.push(child)
      continue
    }
    if (!Array.isArray(value)) continue
    for (const item of value) {
      const arrayChild = astNode(item)
      if (arrayChild) stack.push(arrayChild)
    }
  }
}

function astNode(value: unknown): AstNode | null {
  return typeof value === 'object' && value !== null &&
    typeof (value as { type?: unknown }).type === 'string'
    ? value as AstNode
    : null
}

function identifierName(value: unknown): string | null {
  const node = astNode(value)
  return node?.type === 'Identifier' && typeof node.name === 'string' ? node.name : null
}

function memberPropertyName(member: AstNode): string | null {
  const property = astNode(member.property)
  if (member.computed === true) {
    return property?.type === 'Literal' && typeof property.value === 'string'
      ? property.value
      : null
  }
  return identifierName(property)
}

function waitStatus(
  result: ToolResultBlock | null,
  finalized: boolean,
  failed: boolean,
): CodexWaitStatus {
  if (failed) return 'failed'
  if (result) {
    const text = toolResultContentText(result.content)
    const transport = codexTransportEnvelopeStatus(text)
    if (transport === 'failed') return 'failed'
    if (transport === 'running') return 'running'
    if (transport === 'completed') return 'completed'
    if (transport === 'terminated') return 'terminated'
    // Result presence proves only that this polling request returned. It does
    // not prove that the underlying command exited.
    return 'response received'
  }
  // A finalized semantic function_call proves the wait request itself closed,
  // but without a result it says nothing about the underlying exec cell.
  return finalized ? 'request completed' : 'waiting'
}

export function codexResultHasVisibleOutput(result: ToolResultBlock): boolean {
  if (result.is_error === true) return true
  return stripCodexTransportEnvelope(toolResultContentText(result.content)).trim().length > 0
}

function operationSubject(input: Record<string, unknown>): string | null {
  for (const key of ['title', 'name', 'runId', 'sessionId', 'cwd']) {
    const value = input[key]
    if (typeof value === 'string' && /\S/.test(value)) return value.slice(0, 240)
  }
  return null
}

function humanizeOperation(operation: string): string {
  return operation
    .replace(/^(?:workflow|orchestration|ai_workspace)_/, '')
    .split('_')
    .filter(Boolean)
    .map(word => word[0]?.toUpperCase() + word.slice(1))
    .join(' ')
}

function onlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  const allowedSet = new Set(allowed)
  return Object.keys(value).every(key => allowedSet.has(key))
}

function optionalBoundedInteger(value: unknown): number | null {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_WAIT_NUMBER
    ? value
    : null
}
