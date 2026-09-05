import { z } from 'zod'
import { ControlError, defineCapability, featureReferenceSchema, pageInput, pageSchema, paginate } from '@control-sdk'
import { appGuideSections } from '@renderer/app/controlGuide'
import { featureReferences } from './featureReference'
import { commandReference } from '@renderer/features/command-palette/control'
import { getSettingsRegistry, settingMetadata } from '@renderer/features/settings/lib/settingsRegistry'
import { primary, body, rankEntries } from '@renderer/features/command-palette/lib/rankEntries'

const sectionSchema = z.object({ id: z.string(), title: z.string(), markdown: z.string() })

export function documentationCapabilities() {
  return [
    defineCapability({
      id: 'app.describe', title: 'Agent Code crash course and full UI guide',
      description: 'Start here. Learn what Agent Code is, the whole UI, layouts, agents, prompts, output, files, settings and hybrid MCP/computer operation. Default: a complete crash course. Full mode adds every feature page; section and pagination retrieve the entire documentation through this one capability.',
      execution: 'window', effect: 'read',
      input: z.object({ mode: z.enum(['crash_course', 'overview', 'full']).default('crash_course'), section: z.string().optional(), ...pageInput }).strict(),
      output: pageSchema(sectionSchema).extend({ mode: z.string(), sectionIndex: z.array(z.object({ id: z.string(), title: z.string() })), featureCount: z.number(), commandCount: z.number() }),
      handler: input => {
        const all = [...appGuideSections, ...featureReferences.map(feature => ({
          id: `feature:${feature.id}`, title: feature.title,
          markdown: `${feature.purpose}\n\nWhere: ${feature.ui}\n\nPrerequisites: ${feature.prerequisites}\n\nWorkflow:\n${feature.workflow.map((step, index) => `${index + 1}. ${step}`).join('\n')}\n\nOutcome: ${feature.outcome}\n\nConventions and limits: ${feature.cautions}\n\nCommands: ${feature.commandIds.join(', ') || 'Use the described UI route; inspect the command catalog for related actions.'}`,
        }))]
        const sections = input.section ? all.filter(section => section.id === input.section)
          : input.mode === 'full' ? all : input.mode === 'overview' ? appGuideSections.slice(0, 2) : [...appGuideSections]
        if (input.section && !sections.length) throw new ControlError('unavailable', `Unknown guide section: ${input.section}`)
        return {
          ...paginate(sections, input, `guide:${input.mode}:${input.section ?? ''}`), mode: input.mode,
          sectionIndex: all.map(({ id, title }) => ({ id, title })), featureCount: featureReferences.length,
          commandCount: commandReference().length,
        }
      },
    }),
    defineCapability({
      id: 'features.list', title: 'Search all application features',
      description: 'List or search the complete feature guide, including functionality operated through the UI. Reference entries do not imply a direct automation tool exists.',
      execution: 'window', effect: 'read', input: z.object({ query: z.string().default(''), ...pageInput }).strict(),
      output: pageSchema(featureReferenceSchema),
      handler: input => paginate(rankEntries(featureReferences, input.query, feature => [primary(feature.title), body(feature.purpose), body(feature.ui)]), input, `features:${input.query}`),
    }),
    defineCapability({
      id: 'features.describe', title: 'Read a feature guide',
      description: 'Explain a feature’s purpose, UI location, prerequisites, workflow, outcome and limitations, with live descriptions and bindings for its related commands.',
      execution: 'window', effect: 'read', input: z.object({ featureId: z.string() }).strict(),
      output: featureReferenceSchema.extend({ commands: z.array(z.object({ id: z.string(), title: z.string(), description: z.string(), bindings: z.array(z.string()) })) }),
      handler: ({ featureId }) => {
        const feature = featureReferences.find(entry => entry.id === featureId)
        if (!feature) throw new ControlError('unavailable', `Unknown feature: ${featureId}`)
        return { ...feature, commands: commandReference().filter(command => feature.commandIds.includes(command.id)).map(({ id, title, description, bindings }) => ({ id, title, description, bindings })) }
      },
    }),
    defineCapability({
      id: 'settings.reference', title: 'Read the settings reference',
      description: 'Enumerate all settings UI entries with descriptions, categories, control types and scope/apply/storage metadata. Does not reveal stored credentials or change settings.',
      execution: 'window', effect: 'read', input: z.object({ query: z.string().default(''), ...pageInput }).strict(),
      output: pageSchema(z.object({ id: z.string(), title: z.string(), description: z.string(), category: z.string(), controlType: z.string(), scope: z.string(), apply: z.string(), storage: z.string() })),
      handler: input => {
        const entries = getSettingsRegistry().map(setting => {
          const metadata = settingMetadata(setting)
          return { id: setting.id, title: setting.title, description: setting.description, category: setting.category, controlType: setting.control.type, scope: metadata.scope, apply: metadata.apply, storage: metadata.storage }
        })
        return paginate(rankEntries(entries, input.query, setting => [primary(setting.title), body(setting.description)]), input, `settings-reference:${input.query}`)
      },
    }),
  ]
}
