import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { cpus } from 'node:os'
import { Catalogue, compile } from '../../packages/lab-core/src/index.ts'
import { loadAllPacks, readJson } from '../../apps/cli/fs-packs.ts'
import { distribution } from '../../src/three/lab/performance.ts'

const built = Catalogue.build(loadAllPacks())
if (built.findings.some(f => f.severity === 'error')) throw new Error('Invalid catalogue')
const reference = process.argv.includes('--reference')
if (!reference) await (await import('../../src/runtime/rustScience.ts')).initialiseRustScience()
const files = []
let label = ''
for (let i = 2; i < process.argv.length; i++) {
  const argument = process.argv[i]
  if (argument === '--reference') continue
  if (argument === '--label') {
    label = process.argv[++i] ?? ''
    if (!/^[a-z0-9-]+$/i.test(label)) throw new Error('Benchmark label must contain letters, numbers or hyphens')
  } else if (argument.startsWith('--')) throw new Error(`Unknown benchmark option: ${argument}`)
  else files.push(argument)
}
if (!files.length) files.push('packages/pack-chemistry/definitions/chem6-buffer-capacity.labx.json', 'packages/pack-microbiology/definitions/micro4-growth-curve.labx.json')
const results = []
for (const file of files) {
  const definition = readJson(file), durations = [], runs = []
  for (let i = 0; i < 6; i++) {
    const started = performance.now()
    const result = compile(definition, built.catalogue, { seed: 1, rehearse: true })
    const elapsed = performance.now() - started
    if (!result.rehearsal?.ok || result.validation.summary.errors) throw new Error(`Rehearsal failed: ${file}`)
    if (i) { durations.push(elapsed); runs.push({ elapsedMs: elapsed, events: result.rehearsal.events, simulatedTimeS: result.rehearsal.simulatedTimeS }) }
  }
  results.push({ file, seed: 1, warmupRuns: 1, compilationAndRehearsalMs: distribution(durations), runs })
}
mkdirSync('output/performance', { recursive: true })
const sources = ['src/runtime/rustScience.ts', 'packages/lab-core/src/analysis/analysis.ts', 'packages/lab-core/src/models/acidbase.ts', 'packages/lab-core/src/models/complexation.ts', 'packages/lab-core/src/models/redox.ts', 'packages/lab-core/src/models/thermochem.ts', 'packages/lab-core/src/models/numerics.ts', 'packages/lab-science-rust/src/lib.rs', 'packages/lab-science-rust/src/complexation.rs', 'packages/lab-science-rust/src/complex_abi.rs', 'packages/lab-science-rust/src/redox.rs', 'packages/lab-science-rust/src/thermochem.rs', 'packages/lab-science-rust/src/fitting.rs']
const sourceSha256 = createHash('sha256')
for (const path of sources) sourceSha256.update(path).update(readFileSync(path))
const wasmSha256 = reference ? null : (await import('../../src/runtime/science.wasm.gen.ts')).SCIENCE_WASM_SHA256
const report = { schema: 'lab-science-baseline/1', implementation: reference ? 'typescript-reference' : 'rust-wasm', createdAt: new Date().toISOString(), node: process.version, cpu: cpus()[0]?.model, sourceSha256: sourceSha256.digest('hex'), wasmSha256, results, limitations: ['Includes compiler and reference-agent work; not a per-kernel profile.', 'No browser or rendering is included; Rust mode includes actual Wasm interop.'] }
writeFileSync(`output/performance/science-${reference ? 'reference' : 'rust'}${label ? `-${label}` : ''}.json`, JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
