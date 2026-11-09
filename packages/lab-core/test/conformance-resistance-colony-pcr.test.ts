// Which bacteria carry a resistance gene? Colony PCR for blaTEM, a gel, and growth in ampicillin
// from the same suspension. Genotype and phenotype agree; the controls catch a failed PCR.
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { loadAllPacks, PACKAGES, readJson } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { compile } from '../src/compile/compile.ts'
import type { ExperimentDefinition } from '../src/format/types.ts'

const { catalogue } = Catalogue.build(loadAllPacks())
const colonyPcr = readJson(join(PACKAGES, 'pack-molecular-biology', 'definitions', 'molbio8-resistance-colony-pcr.labx.json')) as ExperimentDefinition
type Result = ReturnType<typeof compile>
const noted = (r: Result, field: string) => r.kernel!.world.notebook.find((e) => e.field === field)?.value

describe('conformance: resistance colony PCR', () => {
  it('rehearses for several seeds: controls right, carriers counted, genotype matching phenotype', () => {
    const counts = new Set<unknown>()
    for (const seed of [1, 2, 3, 4]) {
      const r = compile(colonyPcr, catalogue, { seed })
      expect(r.rehearsal!.ok).toBe(true)
      expect(r.rehearsal!.goals.every((g) => g.passed)).toBe(true)
      counts.add(noted(r, 'carriers'))
    }
    // Which colonies are picked differs between seeds.
    expect(counts.size).toBeGreaterThan(1)
  }, 240000)

  it('annealing far above the primers\' Tm gives no bands at all: the positive control shows the PCR failed', () => {
    const def = structuredClone(colonyPcr)
    const cycle = def.procedure!.steps!.find((s) => s.id === 'cycle')!
    cycle.params = { ...cycle.params, annealTemperature: '68 Cel' }
    const r = compile(def, catalogue, { seed: 1 })
    expect(noted(r, 'sizes-pos')).toEqual([])
    expect(r.rehearsal!.goals.find((g) => g.id === 'g-gel')!.passed).toBe(false)
  }, 120000)
})
