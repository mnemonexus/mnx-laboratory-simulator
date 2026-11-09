// RT-PCR across gene junctions: lac is one inducible polycistronic mRNA; end-point PCR at too
// many cycles hides the difference that induction makes.
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { loadAllPacks, PACKAGES, readJson } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { compile } from '../src/compile/compile.ts'
import type { ExperimentDefinition } from '../src/format/types.ts'

const { catalogue } = Catalogue.build(loadAllPacks())
const operon = readJson(join(PACKAGES, 'pack-molecular-biology', 'definitions', 'molbio10-operon-rt-pcr.labx.json')) as ExperimentDefinition

describe('conformance: operon RT-PCR', () => {
  it('rehearses for several seeds: both junctions from induced cDNA, nothing from the no-RT control', () => {
    for (const seed of [1, 2, 3]) {
      const r = compile(operon, catalogue, { seed })
      expect(r.rehearsal!.ok).toBe(true)
      expect(r.rehearsal!.goals.every((g) => g.passed)).toBe(true)
      expect(r.rehearsal!.expectedObservations.every((e) => e.passed)).toBe(true)
    }
  }, 300000)

  it('at 35 cycles the uninduced trace amplifies to full strength and induction no longer shows', () => {
    const def = structuredClone(operon)
    const cycle = def.procedure!.steps!.find((s) => s.id === 'cycle')!
    cycle.params!.cycles = 35
    const r = compile(def, catalogue, { seed: 1 })
    expect(r.run!.decisions['induction']).toBe('same')
    expect(r.rehearsal!.expectedObservations.find((e) => e.id === 'e-induced')!.passed).toBe(false)
  }, 180000)
})
