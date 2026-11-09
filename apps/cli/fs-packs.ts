// Node-only loading of catalogue packs and definitions from disk (the core never does I/O).
// Used by the CLI, the tests and build scripts. Hosts load the same JSON as add-on assets.
import { expandDefinition } from '../../packages/lab-core/src/format/variants.ts'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PackContent } from '../../packages/lab-core/src/catalogue/types.ts'
import { ENTRY_KINDS } from '../../packages/lab-core/src/catalogue/types.ts'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const PACKAGES = join(REPO_ROOT, 'packages')

export function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** A pack directory: pack.json plus catalogue/<kind>.json files. */
export function loadPackDir(dir: string): PackContent {
  const content: Record<string, unknown> = { pack: readJson(join(dir, 'pack.json')) }
  for (const kind of ENTRY_KINDS) {
    const file = join(dir, 'catalogue', `${kind}.json`)
    if (existsSync(file)) content[kind] = readJson(file)
  }
  return content as unknown as PackContent
}

/** Every packages/pack-* directory, core first. */
export function packDirs(): string[] {
  return readdirSync(PACKAGES, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith('pack-') && existsSync(join(PACKAGES, d.name, 'pack.json')))
    .map((d) => join(PACKAGES, d.name))
    .sort((a, b) => (a.endsWith('pack-core') ? -1 : b.endsWith('pack-core') ? 1 : a.localeCompare(b)))
}

export function loadAllPacks(): PackContent[] {
  return packDirs().map(loadPackDir)
}

/**
 * Every curated practical, with each definition's variants expanded (format §23): one entry per
 * practical the add-on lists. `name` is the file, plus the variant id for a variant.
 */
export function curatedDefinitions(): Array<{ name: string; file: string; json: unknown; problems: string[] }> {
  const out: Array<{ name: string; file: string; json: unknown; problems: string[] }> = []
  for (const file of definitionFiles()) {
    const { definitions, problems } = expandDefinition(readJson(file))
    const messages = problems.map((p) => `${p.path}: ${p.message}`)
    for (const d of definitions) out.push({ name: d.variant ? `${basename(file)} [${d.variant}]` : basename(file), file, json: d.json, problems: messages })
  }
  return out
}

/** Curated definitions shipped with the packs (packages/pack-*\/definitions/*.labx.json). */
export function definitionFiles(): string[] {
  const out: string[] = []
  for (const dir of packDirs()) {
    const defs = join(dir, 'definitions')
    if (!existsSync(defs)) continue
    for (const f of readdirSync(defs)) if (f.endsWith('.labx.json')) out.push(join(defs, f))
  }
  return out.sort()
}

/** Complete definitions in the format spec and its examples (the benchmark corpus starts here). */
export function docExamples(): Array<{ source: string; title: string; json: unknown }> {
  const out: Array<{ source: string; title: string; json: unknown }> = []
  const dir = join(REPO_ROOT, 'docs', 'framework', 'specs')
  for (const file of ['experiment-definition.md', 'experiment-definition-examples.md']) {
    const lines = readFileSync(join(dir, file), 'utf8').split('\n')
    let heading = ''
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('#')) heading = lines[i].replace(/^#+\s*/, '')
      if (lines[i].trim() !== '```json') continue
      const body: string[] = []
      for (i++; i < lines.length && lines[i].trim() !== '```'; i++) body.push(lines[i])
      const src = body.join('\n')
      if (!src.includes('"format": "lab-experiment"') || src.includes('…')) continue
      out.push({ source: file, title: heading, json: JSON.parse(src) })
    }
  }
  return out
}
