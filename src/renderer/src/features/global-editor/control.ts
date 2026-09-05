import { z } from 'zod'
import { ControlError, defineCapability, pageInput, pageSchema, paginate } from '@control-sdk'
import { useAppStore } from '@renderer/app-state/store'
import { hasAppInteractionOwner } from '@renderer/lib/interaction-ownership'
import { useGlobalEditorStore } from './store'
import { openFileInGlobalEditor } from './openFileInGlobalEditor'
import type { EditorFileBuffer } from '@renderer/features/editor/types'

const cwd = z.string().min(1).describe('Absolute editor project root, normally cwd from agents.search or an existing editor buffer.')
const bufferSchema = z.object({ cwd: z.string(), path: z.string(), absolutePath: z.string(), generation: z.number(), dirty: z.boolean(),
  conflict: z.boolean(), externalChange: z.string().nullable(), error: z.string().nullable(), selected: z.boolean(),
  selection: z.object({ line: z.number(), column: z.number() }).nullable() })
const reference = (cwd: string, buffer: EditorFileBuffer) => ({ cwd, path: buffer.path, absolutePath: buffer.absolutePath, generation: buffer.generation,
  dirty: buffer.dirty, conflict: buffer.conflict, externalChange: buffer.externalChange, error: buffer.error, selection: buffer.selection,
  selected: useGlobalEditorStore.getState().activeCwd === cwd && useGlobalEditorStore.getState().byCwd[cwd]?.activeFilePath === buffer.path })

export function editorControlCapabilities() {
  return [
    defineCapability({
      id: 'editor.buffers', title: 'Find open editor buffers', execution: 'window', effect: 'read',
      description: 'List open project-editor buffers and their dirty/conflict state, generation and requested cursor location. Includes background project roots; does not open files, read disk or expose file contents. Use editor.open to reveal a file while preserving unsaved edits.',
      input: z.object({ cwd: cwd.optional(), query: z.string().default('').describe('Case-insensitive substring of project root or relative file path; empty lists all open buffers.'), ...pageInput }).strict(),
      output: pageSchema(bufferSchema),
      handler: input => {
        const editor = useGlobalEditorStore.getState()
        const query = input.query.toLocaleLowerCase()
        const rows = Object.entries(editor.byCwd).filter(([root]) => !input.cwd || root === input.cwd)
          .flatMap(([root, state]) => state.fileOrder.flatMap(path => state.openFiles[path] ? [reference(root, state.openFiles[path])] : []))
          .filter(row => `${row.cwd}/${row.path}`.toLocaleLowerCase().includes(query))
        return paginate(rows, input, `editor-buffers:${input.cwd ?? ''}:${query}`)
      },
    }),
    defineCapability({
      id: 'editor.open', title: 'Reveal a file in the project editor', execution: 'window', effect: 'ui',
      description: 'Open or reveal a project-relative file at an optional one-based line and column through the normal editor navigation path. Rechecks disk while preserving dirty buffers and surfacing conflicts. Reveals the project editor, preserving hidden AI Workspace edits. Returns buffer state and requested location; inspect the UI for visual cursor placement. Never saves or overwrites a file.',
      input: z.object({ cwd, path: z.string().min(1).refine(path => !path.startsWith('/') && path.split('/').every(segment => segment !== '..' && segment !== '.' && segment !== ''), 'Use a normalized project-relative path').describe('Normalized path relative to cwd, for example src/main.ts; no absolute path or dot segments.'),
        line: z.number().int().positive().optional().describe('One-based line number; omitted preserves the existing location.'),
        column: z.number().int().positive().optional().describe('One-based column; defaults to 1 when line is supplied.') }).strict(),
      output: bufferSchema,
      handler: async input => {
        if (hasAppInteractionOwner()) throw new ControlError('unavailable', 'Another surface owns input; inspect or dismiss it first')
        const result = await openFileInGlobalEditor({ root: input.cwd, path: input.path, line: input.line, column: input.column })
        if (!result.ok) throw new ControlError('unavailable', result.error)
        const editor = useGlobalEditorStore.getState()
        const buffer = editor.byCwd[input.cwd]?.openFiles[input.path]
        // A later human navigation may have won while disk IO was pending.
        // The shared opener deliberately keeps its buffer in the background;
        // reporting it as visibly selected here would make the next click unsafe.
        if (!result.opened || !buffer || editor.activeCwd !== input.cwd || editor.byCwd[input.cwd]?.activeFilePath !== input.path || !useAppStore.getState().globalEditorOpen) {
          throw new ControlError('failed', 'File navigation was superseded or closed; inspect editor.buffers and the UI', 'unknown')
        }
        return reference(input.cwd, buffer)
      },
    }),
  ]
}
