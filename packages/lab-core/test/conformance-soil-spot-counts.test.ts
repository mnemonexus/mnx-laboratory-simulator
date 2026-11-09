// Fuel in the soil: soil microcosms with or without an alkane, kept cold or on the bench, spot
// plated; the degrader multiplies only where it is both fed and warm.
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { loadAllPacks, PACKAGES, readJson } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { compile } from '../src/compile/compile.ts'
import type { ExperimentDefinition } from '../src/format/types.ts'

const { catalogue } = Catalogue.build(loadAllPacks())
const soil = readJson(join(PACKAGES, 'pack-microbiology', 'definitions', 'micro13-soil-spot-counts.labx.json')) as ExperimentDefinition

describe('conformance: soil spot counts', () => {
  it('rehearses for several seeds: only the warm, fuel-fed microcosm grows', () => {
    for (const seed of [1, 2, 3]) {
      const r = compile(soil, catalogue, { seed })
      expect(r.rehearsal!.ok).toBe(true)
      expect(r.rehearsal!.goals.every((g) => g.passed)).toBe(true)
      expect(r.rehearsal!.expectedObservations.every((e) => e.passed)).toBe(true)
    }
  }, 300000)

  it('left on the bench instead of in the fridge, the fuel-fed "cold" microcosm grows as well', () => {
    const def = structuredClone(soil)
    const settle = def.procedure!.steps!.find((s) => s.id === 'settle')!
    delete settle.params
    const r = compile(def, catalogue, { seed: 1 })
    const perG = (s: string) => r.kernel!.world.notebook.find((e) => e.field === `per-g-${s}`)?.value as number
    expect(perG('cold-oil')).toBeGreaterThan(1000 * perG('cold-clean'))
    expect(r.rehearsal!.expectedObservations.find((e) => e.id === 'e-cold')!.passed).toBe(false)
  }, 180000)
})
