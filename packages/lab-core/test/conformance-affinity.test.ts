// Affinity chromatography: a His-tagged protein held on nickel and released by imidazole, host
// proteins washed off by a little imidazole, followed by A488 and SDS-PAGE.
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { loadAllPacks, PACKAGES, readJson } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { compile } from '../src/compile/compile.ts'
import type { ExperimentDefinition } from '../src/format/types.ts'

const { catalogue } = Catalogue.build(loadAllPacks())
const his = readJson(join(PACKAGES, 'pack-biochemistry', 'definitions', 'bio11-his-tag-purification.labx.json')) as ExperimentDefinition
const value = (r: ReturnType<typeof compile>, f: string) => r.kernel!.world.notebook.find((e) => e.field === f)!.value as number
const supply = (def: ExperimentDefinition, id: string) => def.materials!.supplies!.find((s) => s.id === id)!

describe('conformance: His-tag purification', () => {
  it('rehearses for several seeds: most GFP in the eluates, eluate 1 pure', () => {
    for (const seed of [1, 2, 3, 4]) {
      const r = compile(his, catalogue, { seed })
      expect(r.rehearsal!.ok).toBe(true)
      expect(r.rehearsal!.expectedObservations.every((o) => o.passed)).toBe(true)
      expect(r.run!.decisions.purity).toBe('pure')
    }
  }, 60000)

  it('washing without imidazole leaves host proteins to come off with the GFP', () => {
    const def = structuredClone(his)
    Object.assign(supply(def, 'wash'), { preparation: undefined, contains: [{ substance: 'core:sodium-chloride', conc: '300 mM' }], solvent: 'core:water' })
    delete supply(def, 'wash').preparation
    const r = compile(def, catalogue, { seed: 1 })
    expect(r.run!.decisions.purity).toBe('contaminated')
    expect(r.rehearsal!.goals.find((g) => g.id === 'g-pure')!.passed).toBe(false)
  }, 30000)

  it('50 mM imidazole is not enough to elute', () => {
    const def = structuredClone(his)
    delete supply(def, 'elution').preparation
    Object.assign(supply(def, 'elution'), { contains: [{ substance: 'bio:imidazole', conc: '50 mM' }, { substance: 'core:sodium-chloride', conc: '300 mM' }], solvent: 'core:water' })
    const r = compile(def, catalogue, { seed: 1 })
    expect(value(r, 'yield-%')).toBeLessThan(40)
  }, 30000)
})
