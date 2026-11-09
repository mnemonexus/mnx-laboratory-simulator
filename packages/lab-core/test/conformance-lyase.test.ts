// A C-S β-lyase followed with Ellman's reagent: specificity constants from Michaelis–Menten series,
// and time-dependent inactivation by L-cycloserine seen by pre-incubation and dilution.
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { loadAllPacks, PACKAGES, readJson } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { compile } from '../src/compile/compile.ts'
import type { ExperimentDefinition } from '../src/format/types.ts'

const { catalogue } = Catalogue.build(loadAllPacks())
const lyase = readJson(join(PACKAGES, 'pack-biochemistry', 'definitions', 'bio18-lyase-specificity-inactivation.labx.json')) as ExperimentDefinition

describe('conformance: lyase specificity and inactivation', () => {
  it('rehearses for several seeds: benzyl preferred, cycloserine inactivates', () => {
    for (const seed of [1, 2, 3]) {
      const r = compile(lyase, catalogue, { seed })
      expect(r.rehearsal!.ok).toBe(true)
      expect(r.rehearsal!.goals.every((g) => g.passed)).toBe(true)
      expect(r.rehearsal!.expectedObservations.every((e) => e.passed)).toBe(true)
    }
  }, 600000)

  it('were cycloserine only a competitive inhibitor, pre-incubation would cost nothing', () => {
    const packs = loadAllPacks()
    for (const p of packs) for (const s of p.substances ?? []) if (s.enzyme?.inactivators) delete s.enzyme.inactivators
    const { catalogue: reversible } = Catalogue.build(packs)
    const r = compile(lyase, reversible, { seed: 1 })
    expect(r.run!.decisions['mechanism']).toBe('competitive')
    expect(r.rehearsal!.expectedObservations.find((e) => e.id === 'e-decay')!.passed).toBe(false)
  }, 300000)
})
