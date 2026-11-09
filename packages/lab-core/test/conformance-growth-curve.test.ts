// A growth curve read as turbidity (OD600): cells scatter light, and the exponential phase gives
// the doubling time the growth model was given.
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { loadAllPacks, PACKAGES, readJson } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { compile } from '../src/compile/compile.ts'
import type { ExperimentDefinition } from '../src/format/types.ts'
import { odPerCell } from '../src/models/measurement.ts'

const { catalogue } = Catalogue.build(loadAllPacks())
const gc = readJson(join(PACKAGES, 'pack-microbiology', 'definitions', 'micro4-growth-curve.labx.json')) as ExperimentDefinition

describe('conformance: growth curve', () => {
  it('rehearses for several seeds: lag, exponential and stationary phases; doubling time near 20 min', () => {
    for (const seed of [1, 2, 3, 4]) {
      const r = compile(gc, catalogue, { seed })
      expect(r.rehearsal!.ok).toBe(true)
      expect(r.rehearsal!.expectedObservations.every((o) => o.passed)).toBe(true)
      const od = r.kernel!.world.notebook.filter((n) => n.field === 'od').map((n) => n.value as number)
      for (let i = 1; i < od.length; i++) expect(od[i]).toBeGreaterThanOrEqual(od[i - 1] - 0.01)
    }
  }, 30000)

  it('at 30 °C the culture grows more slowly', () => {
    const def = structuredClone(gc)
    def.equipment!.roles = def.equipment!.roles!.map((r) => (r.id === 'incubator' ? { ...r, requires: { ...r.requires, temperature: '30 Cel' } } : r))
    const r = compile(def, catalogue, { seed: 1 })
    const td = r.kernel!.world.notebook.find((n) => n.field === 'doubling-time')!.value as number
    expect(td).toBeGreaterThan(26)
  })

  it('turbidity: OD 1 at about 8 × 10⁸ bacteria per mL, scattering falling with wavelength', () => {
    expect(odPerCell(catalogue, 'micro:escherichia-coli-k12', 600) * 8e8).toBeCloseTo(1, 1)
    expect(odPerCell(catalogue, 'micro:escherichia-coli-k12', 450)).toBeGreaterThan(odPerCell(catalogue, 'micro:escherichia-coli-k12', 600))
    expect(odPerCell(catalogue, 'core:water', 600)).toBe(0)
  })
})
