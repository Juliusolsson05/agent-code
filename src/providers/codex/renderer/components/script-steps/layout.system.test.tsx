import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { renderToStaticMarkup } from 'react-dom/server'
import { chromium } from 'playwright-core'
import { compile } from 'tailwindcss'
import { expect, it } from 'vitest'

import { chromiumExecutable } from '@main/browserPocket/testing/chromiumHarness'
import { CodexScriptStepsRow } from './index'

const require = createRequire(import.meta.url)

it.skipIf(!chromiumExecutable)('keeps Codex tool identity, argument and outcome inside narrow cards', { timeout: 20_000 }, async () => {
  const title = 'ac_agents_draft_get'
  const detail = 'B25 selected session'
  const html = renderToStaticMarkup(<CodexScriptStepsRow model={{
    steps: [{ kind: 'mcp', title, detail }], results: [{ kind: 'mcp', text: '{}', isError: true, index: 0 }],
    paired: true, wallSeconds: 15.2, status: 'completed', exactOutput: '{}', truncatedTokens: null,
  }} />)

  // jsdom cannot tell us that a hoverable argument is zero pixels wide. Use the
  // real component's Tailwind utilities and Chromium layout, without an app build.
  const theme = await readFile(require.resolve('tailwindcss/theme.css'), 'utf8')
  const utilities = await compile(theme + '\n@tailwind utilities;')
  const classes = Array.from(html.matchAll(/class="([^"]+)"/g), match => match[1]!).join(' ').split(/\s+/)
  const browser = await chromium.launch({ executablePath: chromiumExecutable })
  try {
    const page = await browser.newPage()
    await page.setContent(`<article style="font-family:monospace">${html}</article>`)
    await page.addStyleTag({ content: utilities.build(classes) })

    for (const width of [175, 340]) {
      await page.locator('article').evaluate((card, w) => { card.style.width = w + 'px' }, width)
      const card = (await page.locator('article').boundingBox())!
      const parts = [
        page.getByText(title, { exact: true }), page.getByTitle(detail), page.getByLabel('failed'), page.getByText('15.2 s'),
      ]
      const boxes = await Promise.all(parts.map(async part => (await part.boundingBox())!))
      for (const box of boxes) {
        expect(box.width).toBeGreaterThan(12)
        expect(box.x).toBeGreaterThanOrEqual(card.x - 1)
        expect(box.x + box.width).toBeLessThanOrEqual(card.x + width + 1)
      }
      // Wide rows retain the compact single-line presentation; narrow rows wrap.
      const [name, , , duration] = boxes
      if (width === 340) expect(Math.abs(name!.y - duration!.y)).toBeLessThan(5)
      else expect(duration!.y).toBeGreaterThan(name!.y + 5)
    }
  } finally {
    await browser.close()
  }
})
