import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { resolveWorkflowSearchLayout } from 'workflow-mcp'

/**
 * Resolve Claude custom-agent instructions using the same user/project layering as workflows.
 *
 * WHY the runtime injects only the Markdown body: `.claude/agents/*.md` frontmatter configures the
 * Claude Agent tool (name, description, model, tools). Passing those YAML bytes to Codex as prose
 * would teach the subagent configuration syntax instead of its role. Workflow-level schema/model
 * options remain authoritative at the portable runtime boundary; the body is the custom system
 * instruction that `agentType` is meant to select.
 */
export async function resolveClaudeAgentType(
  name: string,
  cwd: string,
): Promise<string | undefined> {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return undefined
  const layout = await resolveWorkflowSearchLayout({ cwd })
  const directories = [
    join(dirname(layout.userDirectory), 'agents'),
    ...layout.projectDirectories.map(directory => join(dirname(directory), 'agents')),
  ]

  let instructions: string | undefined
  for (const directory of directories) {
    const source = await readFile(join(directory, `${name}.md`), 'utf8').catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined
        throw error
      },
    )
    if (source === undefined) continue
    const body = markdownBody(source).trim()
    if (body.length > 0) instructions = body
  }
  return instructions
}

function markdownBody(source: string): string {
  if (!source.startsWith('---')) return source
  const firstLineEnd = source.indexOf('\n')
  if (firstLineEnd < 0 || source.slice(0, firstLineEnd).trim() !== '---') return source
  const closing = source.indexOf('\n---', firstLineEnd)
  if (closing < 0) return source
  const bodyStart = source.indexOf('\n', closing + 1)
  return bodyStart < 0 ? '' : source.slice(bodyStart + 1)
}
