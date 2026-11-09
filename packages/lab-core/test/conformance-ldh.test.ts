// Conformance experiment: LDH Michaelis–Menten kinetics from a definition alone.
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { loadAllPacks, PACKAGES, readJson } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { compile } from '../src/compile/compile.ts'
import type { ExperimentDefinition } from '../src/format/types.ts'
import type { StoredFit } from '../src/kernel/ops-data.ts'

const { catalogue } = Catalogue.build(loadAllPacks())
const ldh = readJson(join(PACKAGES, 'pack-biochemistry', 'definitions', 'bio2-ldh-michaelis-menten.labx.json')) as ExperimentDefinition
const fitOf = (r: ReturnType<typeof compile>) => r.run!.outputs.mm.fit as StoredFit

describe('conformance: LDH Michaelis–Menten kinetics', () => {
  it('validates without findings', () => {
    const r = compile(ldh, catalogue, { rehearse: false })
    expect(r.validation.findings.filter((f) => f.severity !== 'info')).toEqual([])
  })

  for (const seed of [1, 2, 3, 4]) {
    it(`recovers Km and saturating kinetics (seed ${seed})`, () => {
      const r = compile(ldh, catalogue, { seed })
      expect(r.rehearsal!.issues).toEqual([])
      expect(r.rehearsal!.ok).toBe(true)
      expect(r.rehearsal!.expectedObservations.every((o) => o.passed)).toBe(true)
      expect(fitOf(r).params.km).toBeGreaterThan(0.09)
      expect(fitOf(r).params.km).toBeLessThan(0.21)
    })
  }

  it('without noise or handling error, only the depletion bias remains', () => {
    const r = compile(ldh, catalogue, { seed: 1, realism: 'ideal' })
    expect(fitOf(r).params.km).toBeGreaterThan(0.15)
    expect(fitOf(r).params.km).toBeLessThan(0.165)
  })

  it('a competitive inhibitor in the buffer raises the apparent Km, not Vmax', () => {
    const inhibited = structuredClone(ldh)
    const buffer = inhibited.materials!.supplies!.find((s) => s.id === 'buffer')!
    delete buffer.preparation
    buffer.contains = [
      { substance: 'core:tris', conc: '50 mM' },
      { substance: 'core:hydrochloric-acid', conc: '39.4 mM' },
      { substance: 'bio:oxamate', conc: '0.105 mM' },
    ]
    inhibited.goals!.predicates = []
    delete inhibited.context!.objectives!.find((o) => o.id === 'o-fit')!.goal
    const plain = compile(ldh, catalogue, { seed: 1, realism: 'ideal' })
    const r = compile(inhibited, catalogue, { seed: 1, realism: 'ideal' })
    expect(r.validation.findings.filter((f) => f.severity === 'error')).toEqual([])
    expect(r.rehearsal!.issues).toEqual([])
    // Oxamate is 0.105 mM × 150/200 in the well = 0.079 mM: Km × (1 + 0.079/0.04) ≈ 2.97 × Km.
    const ratio = fitOf(r).params.km / fitOf(plain).params.km
    expect(ratio).toBeGreaterThan(2.5)
    expect(ratio).toBeLessThan(3.4)
    expect(Math.abs(fitOf(r).params.vmax / fitOf(plain).params.vmax - 1)).toBeLessThan(0.1)
  })
})
