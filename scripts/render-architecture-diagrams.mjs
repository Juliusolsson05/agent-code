#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// WHY the source lives in the reference rather than separate .mmd files:
// reviewers need the explanation and the exact diagram in the same diff. The
// SVGs are derived previews because GitHub's runtime renderer failed on this
// long page even after every diagram passed local parse/render validation.
// Plain-text source disclosures keep GitHub from trying to render a second,
// hidden copy. Stable explicit IDs keep asset paths independent of section
// numbering when the architecture document is reorganized.
//
// WHY tools are supplied separately: Mermaid and a browser automation library
// are documentation build dependencies, not Agent Code runtime dependencies.
// A temporary npm prefix keeps them out of the app's lockfile and distribution.
// Pinning their versions here makes an accidental tool upgrade visible before
// it rewrites every SVG. See ARCHITECTURE.md, Appendix B, for the exact command.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const check = argv.includes('--check')
const value = flag => {
  const index = argv.indexOf(flag)
  return index < 0 ? undefined : argv[index + 1]
}
const toolingDir = value('--tooling-dir')
const browserPath = value('--browser')
if (!toolingDir || !browserPath) {
  throw new Error('Usage: node scripts/render-architecture-diagrams.mjs --tooling-dir <npm-prefix> --browser <Chrome executable> [--check]')
}

const toolRoot = resolve(toolingDir)
for (const [name, expected] of [['mermaid', '11.4.1'], ['puppeteer-core', '24.2.1']]) {
  const manifest = JSON.parse(await readFile(join(toolRoot, 'node_modules', name, 'package.json'), 'utf8'))
  if (manifest.version !== expected) throw new Error(`Expected ${name}@${expected}, found ${manifest.version}`)
}
const requireTool = createRequire(join(toolRoot, 'package.json'))
const puppeteer = requireTool('puppeteer-core')
const markdown = await readFile(join(root, 'ARCHITECTURE.md'), 'utf8')
const pattern = /<!-- architecture-diagram: ([a-z0-9-]+) -->\n([\s\S]*?)```text\n([\s\S]*?)```/g
const diagrams = [...markdown.matchAll(pattern)].map(match => ({ id: match[1], preview: match[2], source: match[3] }))
if (!diagrams.length) throw new Error('No architecture diagram sources found')
// A malformed disclosure must fail validation rather than quietly disappearing
// from the generated set. Crossed marker boundaries are also a malformed block.
if ((markdown.match(/<!-- architecture-diagram:/g) ?? []).length !== diagrams.length
    || diagrams.some(diagram => diagram.preview.includes('<!-- architecture-diagram:'))) {
  throw new Error('An architecture diagram marker has no valid source block')
}
if (new Set(diagrams.map(diagram => diagram.id)).size !== diagrams.length) throw new Error('Duplicate architecture diagram IDs')
for (const diagram of diagrams) {
  if (!diagram.preview.includes(`docs/architecture/diagrams/${diagram.id}.svg`)) {
    throw new Error(`Diagram ${diagram.id} does not reference its expected preview`)
  }
}

const outputDir = join(root, 'docs', 'architecture', 'diagrams')
if (!check) await mkdir(outputDir, { recursive: true })
const browser = await puppeteer.launch({ executablePath: resolve(browserPath), headless: true })
const failures = []
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 })
  await page.setContent('<!doctype html><html><body></body></html>')
  await page.addScriptTag({ path: join(toolRoot, 'node_modules', 'mermaid', 'dist', 'mermaid.min.js') })
  for (const diagram of diagrams) {
    try {
      // Each render starts with its own deterministic seed. Otherwise Mermaid
      // can retain counters/configuration from a preceding diagram, making a
      // harmless insertion earlier in the document churn unrelated assets.
      // Pure SVG text avoids foreignObject compatibility problems when GitHub
      // loads the result as an image rather than as an interactive HTML page.
      const rendered = await page.evaluate(async ({ id, source }) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: 'default',
          htmlLabels: false,
          flowchart: { htmlLabels: false },
          class: { htmlLabels: false },
          deterministicIds: true,
          deterministicIDSeed: id,
          // Class-box paths use RoughJS internally even with the classic
          // look. Its zero/default seed randomizes invisible control points,
          // so deterministicIds alone still produces a different file each run.
          handDrawnSeed: 42,
          themeVariables: { fontFamily: 'Arial, sans-serif' },
        })
        await mermaid.parse(source)
        return (await mermaid.render(`architecture-${id}`, source)).svg
      }, diagram)

      // The preview needs its own background: GitHub dark mode must not turn
      // dark SVG text into dark text on a transparent dark page. Cover exactly
      // the viewBox so negative origins or padding retain the same background.
      const box = rendered.match(/viewBox="([^"]+)"/)?.[1].split(/\s+/).map(Number)
      if (!box || box.length !== 4 || box.some(n => !Number.isFinite(n)) || box[2] <= 0 || box[3] <= 0) {
        throw new Error('Rendered SVG has no valid nonempty viewBox')
      }
      if (/<foreignObject\b|<script\b/.test(rendered)) throw new Error('Expected a standalone SVG without HTML or scripts')
      const background = `<rect x="${box[0]}" y="${box[1]}" width="${box[2]}" height="${box[3]}" fill="#ffffff"/>`
      const svg = '<!-- Generated from ARCHITECTURE.md by scripts/render-architecture-diagrams.mjs. Do not edit directly. -->\n'
        + rendered.replace(/(<svg\b[^>]*>)/, `$1${background}`) + '\n'
      const file = join(outputDir, `${diagram.id}.svg`)
      if (check) {
        const previous = await readFile(file, 'utf8').catch(() => null)
        if (previous !== svg) throw new Error('Preview is missing or differs from rendered source')
      } else {
        await writeFile(file, svg)
      }
    } catch (error) {
      failures.push(`${diagram.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
} finally {
  await browser.close()
}

for (const failure of failures) console.error(failure)
console.log(`${diagrams.length - failures.length}/${diagrams.length} architecture diagrams ${check ? 'verified' : 'rendered'}`)
if (failures.length) process.exitCode = 1
