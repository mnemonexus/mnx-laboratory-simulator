// Gravimetric pipette checks: a tool's hidden systematic error (an equipment role's `truth.bias`,
// or a fault), measured as the mean of weighed volumes, with the balance's own scatter.
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { loadAllPacks, PACKAGES, readJson } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { compile } from '../src/compile/compile.ts'
import type { ExperimentDefinition } from '../src/format/types.ts'

const { catalogue } = Catalogue.build(loadAllPacks())
const check = readJson(join(PACKAGES, 'pack-core', 'definitions', 'core-pipette-calibration.labx.json')) as ExperimentDefinition
const value = (r: ReturnType<typeof compile>, f: string) => r.kernel!.world.notebook.find((e) => e.field === f)!.value as number

describe('conformance: pipette calibration by weighing', () => {
  it('rehearses for several seeds: pipette B reads about 4 % high and is sent for recalibration', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const r = compile(check, catalogue, { seed })
      expect(r.rehearsal!.ok).toBe(true)
      expect(value(r, 'systematic-%-pb')).toBeGreaterThan(3)
      expect(value(r, 'systematic-%-pb')).toBeLessThan(5)
      expect(['b', 'both']).toContain(r.run!.decisions.which)
    }
  }, 30000)

  it('a 0.1 mg balance adds scatter that a 0.01 mg balance does not', () => {
    const coarse = structuredClone(check)
    coarse.equipment!.roles!.find((r) => r.id === 'balance')!.requires = { class: 'core:balance-4dp' }
    // Variances add: about 0.25 % from the pipette, and 0.14 % more per dispense from a 0.1 mg balance.
    const seeds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
    const meanVar = (def: ExperimentDefinition) => seeds.reduce((a, seed) => a + value(compile(def, catalogue, { seed }), 'cv-%-pa') ** 2, 0) / seeds.length
    expect(meanVar(coarse)).toBeGreaterThan(meanVar(check) * 1.1)
  }, 90000)

  it('a fault can put pipette A out of calibration too, and the data then show both', () => {
    const def = structuredClone(check)
    def.variation = { ...(def.variation ?? {}), faults: [{ id: 'a-low', probability: 1, apply: { role: 'pa', truth: { bias: '-3 %' } } }] }
    const r = compile(def, catalogue, { seed: 1 })
    expect(value(r, 'systematic-%-pa')).toBeLessThan(-2)
    expect(r.run!.decisions.which).toBe('both')
  })
})
