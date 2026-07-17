import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { FileIcon, FolderIcon } from './fileIcon'

describe('bundled VS Code file icons', () => {
  it('renders the familiar language-specific artwork without a network URL', () => {
    const markup = renderToStaticMarkup(createElement(FileIcon, { name: 'example.ts' }))

    expect(markup).toContain('<svg')
    expect(markup).toContain('#007acc')
    expect(markup).not.toContain('http:')
    expect(markup).not.toContain('https:')
  })

  it('retains named open-folder artwork instead of a generic folder', () => {
    const source = renderToStaticMarkup(createElement(FolderIcon, { name: 'src', open: true }))
    const generic = renderToStaticMarkup(
      createElement(FolderIcon, { name: 'ordinary-folder', open: true }),
    )

    expect(source).not.toBe(generic)
    expect(source).toContain('#06cc14')
  })
})
