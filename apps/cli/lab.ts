// The headless CLI (integration and hosting §5): validate, rehearse and inspect definitions,
// export the capability manifest and the published schemas. No 3D, no UI, no host.
//
//   npm run lab -- validate <def.json> [--rehearse] [--seed N] [--json]
//   npm run lab -- rehearse <def.json> [--seed N] [--json]
//   npm run lab -- manifest [--out file]
//   npm run lab -- schema [--out-dir dir]       (npm run lab:generate)
//   npm run lab -- check                        (npm run lab:check: packs and curated definitions)
//   npm run lab -- coverage [files…] [--corpus] [--json]   (gap report and unlock analysis)
//   npm run lab -- check-draft <draft.json> [--source id=file …] [--seeds N] [--json]
//                                               (the generator kit's repair-loop check: V1–V4 over
//                                                several seeds, then every quote against its source)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { analyseCoverage, Catalogue, compile, type CoverageReport, expandDefinition, type Finding, FRAMEWORK_VERSION, gapReport, schemaDepth, unlockAnalysis } from '../../packages/lab-core/src/index.ts'
import { curatedDefinitions, definitionFiles, docExamples, loadAllPacks, readJson, REPO_ROOT } from './fs-packs.ts'
import { generatedFiles, manifestText, SCHEMA_DIR, transportSchema } from './generated.ts'
import { verifySources } from '../../packages/lab-core/src/generate/sources.ts'
import { initialiseRustScience } from '../../src/runtime/rustScience.ts'

// The production Rust/Wasm numerics, as in the add-on and the tests (some kernels exist only there).
await initialiseRustScience()

const args = process.argv.slice(2)
const flag = (name: string) => args.includes(`--${name}`)
const option = (name: string) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}

let built: Catalogue | undefined
function catalogue(): Catalogue {
  if (built) return built
  const { catalogue: cat, findings } = Catalogue.build(loadAllPacks())
  const errors = findings.filter((f) => f.severity === 'error')
  if (errors.length) {
    printFindings(errors)
    process.exit(2)
  }
  built = cat
  return cat
}

function printFindings(findings: Finding[]): void {
  for (const f of findings) {
    const mark = f.severity === 'error' ? 'ERROR' : f.severity === 'warning' ? 'warn ' : 'info '
    console.log(`  ${mark} ${f.code.padEnd(34)} ${f.path || '/'}  ${f.message}`)
  }
}

/** Validate (and optionally rehearse) a definition file: each of its variants, if it has any. */
function validateCommand(file: string, rehearse: boolean): number {
  const { definitions, problems } = expandDefinition(readJson(file))
  for (const p of problems) console.log(`  ERROR ED-VARIANT                         ${p.path}  ${p.message}`)
  let failed = problems.length ? 1 : 0
  for (const d of definitions) failed |= validateOne(d.variant ? `${relative(REPO_ROOT, file)} [${d.variant}]` : relative(REPO_ROOT, file), d.json, rehearse)
  return failed
}

function validateOne(name: string, def: unknown, rehearse: boolean): number {
  const cat = catalogue()
  const seed = Number(option('seed') ?? 1)
  const r = compile(def, cat, { seed, rehearse })
  if (flag('json')) {
    console.log(JSON.stringify({ validation: r.validation, coverage: r.coverage, rehearsal: r.rehearsal }, null, 2))
    return r.validation.summary.errors > 0 ? 1 : 0
  }
  const s = r.validation.summary
  console.log(`${name}: ${s.errors} error(s), ${s.warnings} warning(s), ${s.info} info (levels ${r.validation.levels.join(', ')})`)
  printFindings(r.validation.findings)
  if (r.coverage) console.log(`  coverage: ${r.coverage.verdict}; ${r.coverage.gaps.length} gap(s)`)
  if (r.rehearsal) {
    const h = r.rehearsal
    console.log(`  rehearsal (seed ${seed}): ${h.ok ? 'ok' : 'FAILED'}; ${h.events} events, ${h.refusals} refusals, ${(h.simulatedTimeS / 60).toFixed(1)} min simulated; validity ${h.validity}`)
    for (const g of h.goals) console.log(`    goal ${g.passed ? 'met    ' : 'NOT MET'} ${g.statement}`)
    for (const o of h.expectedObservations) console.log(`    expect ${o.passed === null ? 'n/a    ' : o.passed ? 'seen   ' : 'MISSING'} ${o.statement}`)
  }
  return s.errors > 0 || (r.rehearsal && !r.rehearsal.ok) ? 1 : 0
}

function manifestCommand(): number {
  const text = manifestText(catalogue())
  const out = option('out')
  if (out) {
    writeFileSync(out, text)
    console.log(`wrote ${out}`)
  } else console.log(text)
  return 0
}

function schemaCommand(): number {
  const dir = option('out-dir') ?? SCHEMA_DIR
  mkdirSync(dir, { recursive: true })
  const files = generatedFiles()
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
  console.log(`wrote ${Object.keys(files).join(', ')} in ${relative(REPO_ROOT, dir)} (transport depth ${schemaDepth(transportSchema())})`)
  return 0
}

function checkCommand(): number {
  const { findings } = Catalogue.build(loadAllPacks())
  const problems = findings.filter((f) => f.severity !== 'info')
  console.log(`catalogue: ${problems.length} problem(s)`)
  printFindings(problems)
  let failed = problems.some((f) => f.severity === 'error') ? 1 : 0
  for (const file of definitionFiles()) failed |= validateCommand(file, true)
  return failed
}

function coverageCommand(files: string[]): number {
  const cat = catalogue()
  const inputs: Array<{ name: string; json: unknown }> = files.map((f) => ({ name: relative(REPO_ROOT, f), json: readJson(f) }))
  if (flag('corpus') || files.length === 0) {
    for (const d of curatedDefinitions()) inputs.push({ name: d.name, json: d.json })
    for (const d of docExamples()) inputs.push({ name: `${d.source}: ${d.title}`, json: d.json })
  }
  const coverages: CoverageReport[] = []
  for (const input of inputs) {
    const { coverage, findings } = analyseCoverage(input.json, cat)
    if (!coverage) {
      console.log(`${input.name}: not analysable (${findings.filter((f) => f.severity === 'error').length} structural errors)`)
      continue
    }
    coverages.push(coverage)
    if (!flag('json')) console.log(`${coverage.verdict.padEnd(27)} ${coverage.gaps.length} gap(s)  ${input.name}`)
  }
  const report = gapReport(coverages, `lab-core-${FRAMEWORK_VERSION}`)
  const unlock = unlockAnalysis(coverages)
  if (flag('json')) {
    console.log(JSON.stringify({ gaps: report, unlock }, null, 2))
    return 0
  }
  console.log(`
Unlock analysis over ${coverages.length} definitions (implement in this order):`)
  console.log('  rank  defs  central  alone  unlocked  gap')
  for (const r of unlock) {
    console.log(`  ${String(r.rank).padStart(4)}  ${String(r.definitions).padStart(4)}  ${String(r.objectiveCentral).padStart(7)}  ${String(r.unlocksAlone).padStart(5)}  ${String(r.unlockedCumulative).padStart(8)}  ${r.fingerprint}`)
  }
  return 0
}

/** Every `--source id=file` pair, read as text. */
function sourceTexts(): Record<string, string> {
  const out: Record<string, string> = {}
  args.forEach((a, i) => {
    if (a !== '--source') return
    const [id, path] = (args[i + 1] ?? '').split(/=(.*)/s)
    if (!id || !path) {
      console.log('--source takes id=file')
      process.exit(2)
    }
    out[id] = readFileSync(path, 'utf8')
  })
  return out
}

/** A generator's draft: valid, rehearsing on several seeds, and true to its sources. */
function checkDraftCommand(file: string): number {
  const cat = catalogue()
  const def = readJson(file)
  const seeds = Number(option('seeds') ?? 3)
  const runs = Array.from({ length: seeds }, (_, i) => compile(def, cat, { seed: i + 1, rehearse: true }))
  const first = runs[0]
  const sources = first.definition ? verifySources(first.definition, sourceTexts()) : undefined
  const findings = [...first.validation.findings, ...(sources?.findings ?? [])]
  for (const [i, r] of runs.entries()) {
    if (i === 0 || !r.rehearsal || r.rehearsal.ok) continue
    findings.push({ code: 'ED-V4-SEED-FAILED', level: 'V4', severity: 'error', path: '/rehearsal', message: `The rehearsal fails on seed ${i + 1}` })
  }
  const errors = findings.filter((f) => f.severity === 'error').length + (first.rehearsal && !first.rehearsal.ok ? 1 : 0)
  if (flag('json')) {
    console.log(JSON.stringify({
      ok: errors === 0,
      findings,
      coverage: first.coverage ? { verdict: first.coverage.verdict, gaps: first.coverage.gaps } : null,
      rehearsals: runs.map((r, i) => ({ seed: i + 1, ok: r.rehearsal?.ok ?? false, goals: r.rehearsal?.goals.map((g) => ({ id: g.id, passed: g.passed })) })),
      provenance: sources ? { counts: sources.counts, verified: sources.verified } : null,
    }, null, 2))
    return errors === 0 ? 0 : 1
  }
  console.log(`${relative(REPO_ROOT, file)}: ${errors === 0 ? 'OK' : `${errors} problem(s)`}`)
  printFindings(findings)
  if (first.coverage) console.log(`  coverage: ${first.coverage.verdict}; ${first.coverage.gaps.length} gap(s)`)
  console.log(`  rehearsals: ${runs.map((r, i) => `seed ${i + 1} ${r.rehearsal?.ok ? 'ok' : 'FAILED'}`).join(', ')}`)
  if (first.rehearsal) for (const g of first.rehearsal.goals) console.log(`    goal ${g.passed ? 'met    ' : 'NOT MET'} ${g.statement}`)
  if (sources) console.log(`  provenance: ${Object.entries(sources.counts).map(([k, n]) => `${n} ${k}`).join(', ') || 'none'}; ${sources.verified} quote(s) verified`)
  return errors === 0 ? 0 : 1
}

const [command, file] = args
let code = 0
if ((command === 'validate' || command === 'rehearse' || command === 'check-draft') && (!file || file.startsWith('--'))) {
  console.log(`usage: lab ${command} <definition.labx.json> [--seed N] [--json]`)
  process.exit(2)
}
switch (command) {
  case 'validate':
    code = validateCommand(file, flag('rehearse'))
    break
  case 'rehearse':
    code = validateCommand(file, true)
    break
  case 'manifest':
    code = manifestCommand()
    break
  case 'schema':
    code = schemaCommand()
    break
  case 'check':
    code = checkCommand()
    break
  case 'coverage':
    code = coverageCommand(args.slice(1).filter((a) => !a.startsWith('--')))
    break
  case 'check-draft':
    code = checkDraftCommand(file)
    break
  default:
    console.log('usage: lab <validate|rehearse|check-draft|manifest|schema|check|coverage> [file] [--rehearse] [--seed N] [--seeds N] [--source id=file] [--json] [--out file] [--out-dir dir]')
    code = command ? 2 : 0
}
process.exit(code)
