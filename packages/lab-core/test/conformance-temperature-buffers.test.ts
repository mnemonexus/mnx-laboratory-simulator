// An enzyme's apparent temperature optimum (catalysis speeding up against unfolding above its Tm)
// and buffer capacity (Henderson–Hasselbalch, and capacity set by concentration).
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { loadAllPacks, PACKAGES, readJson } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { compile } from '../src/compile/compile.ts'
import type { ExperimentDefinition } from '../src/format/types.ts'
import { addSupply, emptyWorld } from '../src/kernel/index.ts'
import { layerPH } from '../src/models/acidbase.ts'

const { catalogue } = Catalogue.build(loadAllPacks())
const read = (name: string, pack: string) => readJson(join(PACKAGES, pack, 'definitions', name)) as ExperimentDefinition
const optimum = read('bio7-phosphatase-temperature-optimum.labx.json', 'pack-biochemistry')
const buffers = read('chem6-buffer-capacity.labx.json', 'pack-chemistry')
const values = (r: ReturnType<typeof compile>, field: string) => r.kernel!.world.notebook.filter((e) => e.field === field).map((e) => e.value as number)

describe('conformance: temperature optimum of alkaline phosphatase', () => {
  it('rehearses for several seeds: rising to an optimum near 45 °C, then destroyed; heat damage stays', () => {
    for (const seed of [1, 2, 3]) {
      const r = compile(optimum, catalogue, { seed })
      expect(r.rehearsal!.ok).toBe(true)
      expect(r.rehearsal!.expectedObservations.every((o) => o.passed)).toBe(true)
      expect(r.run!.decisions.reversible).toBe('irreversible')
    }
  }, 30000)

  it('the optimum is apparent: a longer assay moves it down, as unfolding has longer to act', () => {
    const long = structuredClone(optimum)
    long.procedure!.steps!.find((s) => s.id === 'runs')!.steps!.find((s) => s.id === 'react')!.params!.duration = '60 min'
    const a10 = values(compile(optimum, catalogue, { seed: 1 }), 'A405')
    const a60 = values(compile(long, catalogue, { seed: 1 }), 'A405')
    // Relative to 37 °C (index 2), the 55 °C tube (index 4) does worse over the longer time.
    expect(a60[4] / a60[2]).toBeLessThan(a10[4] / a10[2])
  }, 30000)
})

describe('conformance: buffer capacity', () => {
  it('rehearses for several seeds', () => {
    for (const seed of [1, 2, 3]) {
      const r = compile(buffers, catalogue, { seed })
      expect(r.rehearsal!.ok).toBe(true)
      expect(r.rehearsal!.expectedObservations.every((o) => o.passed)).toBe(true)
    }
  }, 30000)

  it('follows Henderson–Hasselbalch for other ratios, and dilution leaves the pH alone', () => {
    const pH = (acid: number, salt: number) => {
      const w = emptyWorld(1)
      const c = addSupply(w, catalogue, { id: 'b', label: 'Buffer', container: 'core:beaker-100ml', amount: '50 mL',
        components: [{ substance: 'core:acetic-acid', conc: `${acid} mol/L` }, { substance: 'core:sodium-acetate', conc: `${salt} mol/L` }] })
      return layerPH(catalogue, c.contents.layers[0], 298.15)!
    }
    expect(pH(0.08, 0.02)).toBeCloseTo(4.76 + Math.log10(0.02 / 0.08), 1)
    expect(pH(0.02, 0.08)).toBeCloseTo(4.76 + Math.log10(0.08 / 0.02), 1)
    expect(pH(0.005, 0.005)).toBeCloseTo(pH(0.05, 0.05), 1)
  })
})
