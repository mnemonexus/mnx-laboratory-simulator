// Local proof tooling for the generator kit (no course content is stored in the repository).
// Gathers one course case's cited sources from the locally extracted course material into
// output/course-translation/<case>/ (git-ignored), as a host's retrieval step would, so a
// generator can draft a definition and `lab check-draft` can verify it against the same text.
//
//   node scripts/generator/course-case.mjs list
//   node scripts/generator/course-case.mjs bundle <case id or title words>
//
// Reads docs/course-reference/catalogue.json and output/course-research/text/<source>.txt
// (both produced by the local course inventory; see docs/course-reference/coverage-and-limits.md).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const catalogue = JSON.parse(readFileSync(join(root, 'docs/course-reference/catalogue.json'), 'utf8'))
const textDir = join(root, 'output/course-research/text')
const [command, ...rest] = process.argv.slice(2)
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)

if (command === 'list') {
  for (const c of catalogue.cases) console.log(`${c.id}  ${c.kind.padEnd(19)} ${c.title}`)
  process.exit(0)
}
if (command !== 'bundle' || rest.length === 0) {
  console.log('usage: node scripts/generator/course-case.mjs list | bundle <case id or title words>')
  process.exit(2)
}
const query = rest.join(' ').toLowerCase()
const matches = catalogue.cases.filter((c) => c.id.toLowerCase() === query || c.title.toLowerCase().includes(query))
if (matches.length !== 1) {
  console.log(matches.length ? `"${query}" matches ${matches.length} cases:\n${matches.map((c) => `  ${c.id}  ${c.title}`).join('\n')}` : `No case matches "${query}"`)
  process.exit(1)
}
const c = matches[0]
const dir = join(root, 'output/course-translation', slug(c.title))
mkdirSync(join(dir, 'sources'), { recursive: true })
const ids = [...new Set(c.sourceRefs.map((r) => r.id))]
const manifest = { case: c.id, title: c.title, module: c.module, kind: c.kind, summary: c.summary, capabilities: c.capabilities, missing: c.missing, sources: [] }
for (const id of ids) {
  const src = catalogue.sources.find((s) => s.id === id)
  const file = join(textDir, `${id}.txt`)
  const refs = c.sourceRefs.filter((r) => r.id === id).map((r) => ({ locator: r.locator, lines: r.lines }))
  if (!existsSync(file)) {
    manifest.sources.push({ id, path: src?.relativePath, refs, text: null })
    continue
  }
  writeFileSync(join(dir, 'sources', `${id}.txt`), readFileSync(file, 'utf8'))
  manifest.sources.push({ id, path: src?.relativePath, refs, text: `sources/${id}.txt` })
}
writeFileSync(join(dir, 'case.json'), JSON.stringify(manifest, null, 2))
console.log(`${c.title}\n  ${dir}`)
for (const s of manifest.sources) console.log(`  ${s.id}  ${s.text ? 'text' : 'NO TEXT'}  ${s.path ?? ''}  ${s.refs.map((r) => `${r.locator} ${r.lines ? r.lines.join('–') : ''}`).join('; ')}`)
