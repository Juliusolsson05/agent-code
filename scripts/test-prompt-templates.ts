import {
  PROMPT_TEMPLATES_STORAGE_KEY,
} from '@renderer/app-state/localStorageMigration'
import {
  deleteCustomPromptTemplate,
  loadCustomPromptTemplates,
  saveCustomPromptTemplate,
  updateCustomPromptTemplate,
} from '@renderer/features/prompt-templates/templates'

const CUSTOM_TEMPLATES_KEY = PROMPT_TEMPLATES_STORAGE_KEY

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

function createLocalStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() {
      return values.size
    },
    clear: () => values.clear(),
    getItem: key => values.get(key) ?? null,
    key: index => Array.from(values.keys())[index] ?? null,
    removeItem: key => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  }
}

;(globalThis as typeof globalThis & { window: { localStorage: Storage } }).window = {
  localStorage: createLocalStorage(),
}

const saved = saveCustomPromptTemplate(' Review Prompt ', 'body')
assert(saved.title === 'Review Prompt', 'save should trim the template title')
assert(loadCustomPromptTemplates().length === 1, 'save should persist one template')

const updated = updateCustomPromptTemplate(saved.id, 'Updated', 'new body')
assert(updated?.title === 'Updated', 'update should return the updated template')
assert(loadCustomPromptTemplates()[0]?.body === 'new body', 'update should persist the body')

deleteCustomPromptTemplate(saved.id)
assert(loadCustomPromptTemplates().length === 0, 'delete should remove the template')

window.localStorage.setItem(
  CUSTOM_TEMPLATES_KEY,
  JSON.stringify([
    { id: 'custom:one', title: 'One', body: 'first' },
    { id: 'custom:one', title: 'Duplicate', body: 'second' },
    { id: 'custom:bad', title: 'Missing body' },
    null,
  ]),
)

const normalized = loadCustomPromptTemplates()
assert(normalized.length === 1, 'load should drop invalid and duplicate entries')
assert(normalized[0]?.id === 'custom:one', 'load should keep the first duplicate entry')
assert(normalized[0]?.scope === 'custom', 'load should force custom scope')

console.log('prompt templates ok')
