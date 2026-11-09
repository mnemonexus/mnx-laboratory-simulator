// Paired, warmed fit timings with actual Wasm interop included. This measures
// numerical fitting only, independently of experiment staging and rendering.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { cpus } from 'node:os'
import { fitFourPL, fitMichaelisMenten } from '../../packages/lab-core/src/analysis/analysis.ts'
import { installScientificNumerics } from '../../packages/lab-core/src/models/numerics.ts'
import { createRustScience } from '../../src/runtime/rustScience.ts'
import { SCIENCE_WASM_SHA256 } from '../../src/runtime/science.wasm.gen.ts'
import { distribution } from '../../src/three/lab/performance.ts'

installScientificNumerics(null)
const rust = await createRustScience()
const results = []
for (const model of ['four-pl', 'michaelis-menten']) {
  for (const n of model === 'four-pl' ? [16, 64, 512] : [8, 32, 256]) {
    const x = Array.from({ length: n }, (_, i) => 10 ** (-2 + 4 * i / (n - 1)))
    const y = x.map((v, i) => (model === 'four-pl' ? 2.3 + (0.03 - 2.3) / (1 + (v / 1.8) ** 1.35) : 52 * v / (0.18 + v)) + 0.003 * Math.sin(i * 2.3))
    const reference = model === 'four-pl' ? fitFourPL : fitMichaelisMenten
    const migrated = model === 'four-pl' ? rust.fitFourPL : rust.fitMichaelisMenten
    const original = reference(x, y), actual = migrated(x, y)
    assert.ok(Math.abs(actual.r2 - original.r2) < 1e-9)
    const timings = { reference: [], rust: [] }
    for (let i = 0; i < 35; i++) {
      // Alternate order so one implementation does not always run first.
      for (const key of i % 2 ? ['rust', 'reference'] : ['reference', 'rust']) {
        const start = performance.now()
        const fit = (key === 'rust' ? migrated : reference)(x, y)
        const elapsedMs = performance.now() - start
        assert.equal(fit.n, n)
        if (i >= 5) timings[key].push(elapsedMs)
      }
    }
    results.push({ model, observations: n, warmupFits: 5, measuredFits: 30, referenceMs: distribution(timings.reference), rustMs: distribution(timings.rust), samples: timings })
  }
}
const source = createHash('sha256')
for (const path of ['packages/lab-science-rust/src/fitting.rs', 'packages/lab-core/src/analysis/analysis.ts', 'packages/lab-core/src/models/numerics.ts', 'src/runtime/rustScience.ts']) source.update(path).update(readFileSync(path))
const report = { schema: 'lab-fit-performance/1', createdAt: new Date().toISOString(), node: process.version, cpu: cpus()[0]?.model, sourceSha256: source.digest('hex'), wasmSha256: SCIENCE_WASM_SHA256, results, limitations: ['Shared-machine warmed numerical fits; no rendering or full experiment work is measured.', 'Rust times include packing, Wasm interop, allocation and result copying.', 'These samples do not establish performance on physical mobile hardware.'] }
mkdirSync('output/performance', { recursive: true })
writeFileSync('output/performance/nonlinear-fitting.json', JSON.stringify(report, null, 2))
console.log(JSON.stringify(results.map(r => ({ model: r.model, n: r.observations, referenceMs: r.referenceMs.median, rustMs: r.rustMs.median })), null, 2))
