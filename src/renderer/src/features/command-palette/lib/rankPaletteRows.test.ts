import { describe, expect, it } from 'vitest'

import { rankPaletteRows } from '@renderer/features/command-palette/lib/rankPaletteRows'
import type { ResolvedCommand } from '@renderer/features/command-palette/types'
import type { PromptTemplate } from '@renderer/features/prompt-templates/types'

function command(id: string, title: string, keywords: string[] = []): ResolvedCommand {
  return {
    id,
    title,
    description: `${title} description`,
    surface: 'app',
    keywords,
    keepPaletteOpen: false,
    state: null,
    run: () => {},
  }
}

function template(
  id: string,
  title: string,
  description: string,
  body = 'Body text',
): PromptTemplate {
  return {
    id,
    title,
    description,
    body,
    scope: 'custom',
    insertMode: 'replace',
    variables: [],
  }
}

const BASE_OPTIONS = {
  historyScore: new Map<string, number>(),
  starred: {} as Record<string, boolean>,
  sortMode: 'catalog' as const,
}

const rowLabels = (rows: ReturnType<typeof rankPaletteRows>['rows']): string[] =>
  rows.map(row => row.kind === 'command' ? row.command.title : row.template.title)

describe('rankPaletteRows', () => {
  const commands = [command('settings', 'Open Settings'), command('project', 'Read Project')]
  const templates = [
    template('review', 'Review Changes', 'Inspect the current diff'),
    template('bootstrap', 'Bootstrap Repository', 'Read this project carefully', 'secret body token'),
  ]

  it('preserves command-only behavior while disabled and while browsing', () => {
    const disabled = rankPaletteRows({
      ...BASE_OPTIONS,
      commands,
      promptTemplates: templates,
      query: 'review',
      includePromptTemplates: false,
    })
    expect(disabled.rows).toEqual([])

    const commandSearch = rankPaletteRows({
      ...BASE_OPTIONS,
      commands,
      promptTemplates: templates,
      query: 'project',
      includePromptTemplates: false,
    })
    expect(rowLabels(commandSearch.rows)).toEqual(['Read Project'])
    expect(commandSearch.rows.every(row => row.kind === 'command')).toBe(true)

    const browsing = rankPaletteRows({
      ...BASE_OPTIONS,
      commands,
      promptTemplates: templates,
      query: '',
      includePromptTemplates: true,
    })
    expect(rowLabels(browsing.rows)).toEqual(['Open Settings', 'Read Project'])
    expect(browsing.rows.every(row => row.kind === 'command')).toBe(true)
  })

  it('matches opted-in templates by title and description but never by body', () => {
    const byTitle = rankPaletteRows({
      ...BASE_OPTIONS,
      commands,
      promptTemplates: templates,
      query: 'review',
      includePromptTemplates: true,
    })
    expect(rowLabels(byTitle.rows)).toEqual(['Review Changes'])

    const byDescription = rankPaletteRows({
      ...BASE_OPTIONS,
      commands,
      promptTemplates: templates,
      query: 'carefully',
      includePromptTemplates: true,
    })
    expect(rowLabels(byDescription.rows)).toEqual(['Bootstrap Repository'])

    const byBody = rankPaletteRows({
      ...BASE_OPTIONS,
      commands,
      promptTemplates: templates,
      query: 'secret body token',
      includePromptTemplates: true,
    })
    expect(byBody.rows).toEqual([])
  })

  it('orders commands and templates together by relevance', () => {
    const result = rankPaletteRows({
      ...BASE_OPTIONS,
      commands: [command('weak', 'Open Project Review')],
      promptTemplates: [template('strong', 'Review Project', 'Inspect the project')],
      query: 'review',
      includePromptTemplates: true,
    })

    // The template is a primary-field prefix (tier 5); the command only has a
    // mid-title substring (tier 4). Appending templates after ranked commands
    // would produce the opposite order and make the setting feel bolted on.
    expect(rowLabels(result.rows)).toEqual(['Review Project', 'Open Project Review'])
    expect(result.headers.size).toBe(0)
  })
})
