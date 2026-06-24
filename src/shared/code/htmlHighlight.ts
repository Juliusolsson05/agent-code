import hljs from 'highlight.js'

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export function toHighlightLanguage(language: string): string | null {
  if (language === 'javascriptreact') return 'javascript'
  if (language === 'typescriptreact') return 'typescript'
  return hljs.getLanguage(language) ? language : null
}
