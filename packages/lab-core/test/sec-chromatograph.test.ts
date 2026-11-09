// Analytical size-exclusion chromatography with a UV monitor: peaks in order of size on a log-linear
// calibration, absorbance by wavelength, the injection loop; and the SEC and EMSA practicals.
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { loadAllPacks, PACKAGES, readJson } from '../../../apps/cli/fs-packs.ts'
import { fitLinear } from '../src/analysis/analysis.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { compile } from '../src/compile/compile.ts'
import type { ExperimentDefinition } from '../src/format/types.ts'
import { addEquipment, addSupply, createKernel, emptyWorld, type Kernel } from '../src/kernel/index.ts'

const { catalogue: cat } = Catalogue.build(loadAllPacks())

function system(samples: Record<string, Array<{ substance: string; conc: string }>>): Kernel {
  const w = emptyWorld(1)
  addEquipment(w, cat, 'uv', 'core:uv-monitor')
  for (const [id, components] of Object.entries(samples)) addSupply(w, cat, { id, label: id, container: 'core:microtube-1.5ml', amount: '1 mL', components })
  const k = createKernel(cat, w, { noise: 0 })
  k.execute({ op: 'core:fetch', params: { equipment: 'core:sec-column-analytical', id: 'col', label: 'col' } })
  return k
}
type Run = { apex: Record<string, number>; peaks: Record<string, number[]> }
const inject = (k: Kernel, sample: string, extra: Record<string, unknown> = {}) => k.execute({ op: 'core:chromatograph', params: { column: 'col', sample, volume: '100 uL', detector: 'uv', wavelengths: [280, 254], ...extra } })

describe('analytical size-exclusion chromatography', () => {
  it('a mixture comes off largest first, each peak where a log-linear calibration puts it', () => {
    const k = system({ mix: [{ substance: 'bio:thyroglobulin', conc: '3 mg/mL' }, { substance: 'bio:transferrin', conc: '3 mg/mL' }, { substance: 'bio:myoglobin', conc: '3 mg/mL' }] })
    const r = inject(k, 'mix')
    expect(r.ok).toBe(true)
    const peaks = (r.ok ? (r.outputs as Run) : { peaks: { A280: [] } }).peaks.A280
    expect(peaks).toHaveLength(3)
    expect(peaks[0]).toBeGreaterThan(8)
    expect(peaks[0] < peaks[1] && peaks[1] < peaks[2]).toBe(true)
    const f = fitLinear([669000, 81000, 17000].map(Math.log), peaks)
    expect(f.slope).toBeLessThan(0)
    expect(f.r2).toBeGreaterThan(0.99)
  })

  it('a protein absorbs less at 254 than at 280 nm, at the same elution volume', () => {
    const k = system({ ova: [{ substance: 'bio:ovalbumin', conc: '4 mg/mL' }] })
    inject(k, 'ova')
    const rec = k.world.measurements[k.world.measurements.length - 1]
    expect(Math.max(...rec.series!.A254)).toBeLessThan(Math.max(...rec.series!.A280))
    expect(rec.peaks!.A254[0]).toBeCloseTo(rec.peaks!.A280[0], 1)
  })

  it('refuses more than the loop holds, and wavelengths the monitor does not have', () => {
    const k = system({ ova: [{ substance: 'bio:ovalbumin', conc: '4 mg/mL' }] })
    const big = inject(k, 'ova', { volume: '0.8 mL' })
    expect(big.ok ? '' : big.refusal.code).toBe('INJECTION')
    const nm = inject(k, 'ova', { wavelengths: [405] })
    expect(nm.ok ? '' : nm.refusal.code).toBe('WAVELENGTH')
  })
})

describe('conformance: native mass by SEC, and a binding isotherm by EMSA', () => {
  for (const [pack, file] of [['pack-biochemistry', 'bio23-sec-oligomeric-state'], ['pack-molecular-biology', 'molbio13-emsa-binding-isotherm']]) {
    it(`${file} rehearses for several seeds`, () => {
      const def = readJson(join(PACKAGES, pack, 'definitions', `${file}.labx.json`)) as ExperimentDefinition
      for (const seed of [1, 2]) {
        const r = compile(def, cat, { seed })
        expect(r.rehearsal!.ok).toBe(true)
        expect(r.rehearsal!.goals.every((g) => g.passed)).toBe(true)
        expect(r.rehearsal!.expectedObservations.every((e) => e.passed)).toBe(true)
      }
    }, 300000)
  }
})
