import { z } from 'zod'
import { ControlError, defineCapability, pageInput, pageSchema, paginate } from '@control-sdk'
import { useAppStore } from '@renderer/app-state/store'
import type { Workspace } from '@renderer/workspace/hook'
import { inspectAgentDraft } from '@renderer/workspace/control/drafts'
import { resolveTabSessions } from '@renderer/workspace/queries'
import { allPromptTemplates } from './templates'
import { createSavedPromptTemplate, updateSavedPromptTemplate } from './savedPromptTemplates'
import { fillPromptTemplateBody, applyPromptTemplateInsertMode } from './interpolate'
import type { PromptTemplate } from './types'

const variable = z.object({ name: z.string(), label: z.string(), description: z.string(), defaultValue: z.string(), required: z.boolean() })
const template = z.object({ id: z.string(), title: z.string(), description: z.string(), scope: z.enum(['builtin', 'custom']),
  insertMode: z.enum(['replace', 'append']), variables: z.array(variable), dynamic: z.boolean(), revision: z.string() })
const savedInput = z.object({ title: z.string().trim().min(1).max(200), description: z.string().max(4000).default(''), body: z.string().min(1).max(1_000_000),
  insertMode: z.enum(['replace', 'append']).default('replace'), variables: z.array(variable).max(100).default([]) }).strict()
export function templateControlCapabilities(getWorkspace: () => Workspace) {
  const list = () => allPromptTemplates(useAppStore.getState().settings.savedPromptTemplates)
  const describe = (value: PromptTemplate) => ({ id: value.id, title: value.title, description: value.description, scope: value.scope,
    insertMode: value.insertMode, variables: value.variables, dynamic: Boolean(value.buildBody), revision: paginate([value], { limit: 1 }, `template:${value.id}`).revision })
  const find = (id: string) => { const value = list().find(item => item.id === id); if (!value) throw new ControlError('unavailable', 'Template no longer exists'); return value }
  return [
    defineCapability({ id: 'templates.list', title: 'Find reusable prompt templates', execution: 'window', effect: 'read',
      description: 'List built-in and saved templates with variables, insertion mode and revision. dynamic means the body collects current workspace context when inserted; its static body is only a placeholder. Listing never runs that context collection or changes a draft.',
      input: z.object({ query: z.string().default(''), ...pageInput }).strict(), output: pageSchema(template),
      handler: input => paginate(list().map(describe).filter(row => `${row.title} ${row.description}`.toLowerCase().includes(input.query.toLowerCase())), input, `templates:${input.query}`),
    }),
    defineCapability({ id: 'templates.read', title: 'Read a template body', execution: 'window', effect: 'read',
      description: 'Read a template’s stored body in bounded text pages, with its variables and revision. Dynamic templates return their documented placeholder; templates.insert collects their real context. Keep revision on nonzero offsets.',
      input: z.object({ templateId: z.string(), offset: z.number().int().min(0).default(0), revision: z.string().optional(), maxChars: z.number().int().min(256).max(24000).default(8000) }).strict(),
      output: template.extend({ body: z.string(), offset: z.number(), nextOffset: z.number().nullable(), totalChars: z.number() }),
      handler: input => {
        const value = find(input.templateId), summary = describe(value)
        if ((input.offset && !input.revision) || (input.revision && input.revision !== summary.revision)) throw new ControlError('stale_cursor', 'Template changed; start at offset zero')
        if (input.offset > value.body.length) throw new ControlError('invalid_cursor', 'Offset is outside the template')
        let end = Math.min(value.body.length, input.offset + input.maxChars)
        if (end < value.body.length && /[\uD800-\uDBFF]/.test(value.body[end - 1])) end--
        return { ...summary, body: value.body.slice(input.offset, end), offset: input.offset, nextOffset: end < value.body.length ? end : null, totalChars: value.body.length }
      },
    }),
    defineCapability({ id: 'templates.insert', title: 'Insert a template into an exact unsent draft', execution: 'window', effect: 'mutation', target: { kind: 'session', field: 'sessionId' },
      description: 'Fill a template through the existing variable/interpolation policy and insert into one Agent Code draft, preserving attachments. Requires both the template revision and agents.draftGet revision. Dynamic context uses the explicitly named project and agent, never current focus. Rechecks after context collection and refuses concurrent edits. Does not submit; inspect agents.draftGet before sending.',
      input: z.object({ sessionId: z.string(), tabId: z.string(), templateId: z.string(), templateRevision: z.string(), draftRevision: z.string(), values: z.record(z.string(), z.string()).default({}), mode: z.enum(['replace', 'append']).optional() }).strict(),
      output: z.object({ sessionId: z.string(), revision: z.string(), totalChars: z.number() }),
      handler: async input => {
        const check = () => {
          if (getWorkspace().restoreStatus === 'pending') throw new ControlError('unavailable', 'Wait for workspace restoration')
          if (!resolveTabSessions(useAppStore.getState().workspaceState, input.tabId).includes(input.sessionId)) throw new ControlError('unavailable', 'Agent is not in the named project')
          if (describe(find(input.templateId)).revision !== input.templateRevision || inspectAgentDraft(input.sessionId).summary.revision !== input.draftRevision) throw new ControlError('stale_cursor', 'Template or draft changed; inspect both again')
        }
        check()
        const value = find(input.templateId), state = useAppStore.getState().workspaceState
        const workspace = { ...getWorkspace(), state, activeTab: state.tabs.find(tab => tab.id === input.tabId)!, focusedSessionId: input.sessionId }
        const body = value.buildBody ? await value.buildBody({ workspace, sessionId: input.sessionId }) : value.body
        check()
        const filled = fillPromptTemplateBody({ body, variables: value.variables, values: input.values })
        const draft = inspectAgentDraft(input.sessionId).runtime.draftInput
        getWorkspace().setDraftInput(input.sessionId, applyPromptTemplateInsertMode(draft, filled, input.mode ?? value.insertMode))
        return inspectAgentDraft(input.sessionId).summary
      },
    }),
    defineCapability({ id: 'templates.save', title: 'Create or update a saved template', execution: 'window', effect: 'mutation',
      description: 'Save a custom prompt template using the normal normalization/variable synchronization policy. Omit templateId to create; updating requires that custom template’s current revision. Built-in templates cannot be overwritten. Saving does not insert or send anything.',
      input: z.object({ templateId: z.string().optional(), revision: z.string().optional(), template: savedInput }).strict(), output: template,
      handler: input => {
        const previous = input.templateId ? find(input.templateId) : null
        if (previous && (previous.scope !== 'custom' || describe(previous).revision !== input.revision)) throw new ControlError('stale_cursor', 'Choose a custom template with its current revision')
        const value = previous ? updateSavedPromptTemplate(previous, input.template) : createSavedPromptTemplate(input.template)
        const saved = useAppStore.getState().settings.savedPromptTemplates
        useAppStore.getState().setSettings({ savedPromptTemplates: [value, ...saved.filter(item => item.id !== value.id)] })
        return describe(value)
      },
    }),
    defineCapability({ id: 'templates.delete', title: 'Delete an exact custom template', execution: 'window', effect: 'mutation',
      description: 'Remove one saved custom template using its current revision. Built-ins cannot be removed. Existing agent drafts are unaffected.',
      input: z.object({ templateId: z.string(), revision: z.string() }).strict(), output: z.object({ deleted: z.literal(true) }),
      handler: input => {
        const value = find(input.templateId)
        if (value.scope !== 'custom') throw new ControlError('unavailable', 'Built-in templates cannot be deleted')
        if (describe(value).revision !== input.revision) throw new ControlError('stale_cursor', 'Template changed; read it again')
        useAppStore.getState().setSettings({ savedPromptTemplates: useAppStore.getState().settings.savedPromptTemplates.filter(item => item.id !== value.id) })
        return { deleted: true as const }
      },
    }),
  ]
}
