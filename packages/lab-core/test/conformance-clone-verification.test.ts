// Checking clones by restriction digestion: BamHI releases the insert from either clone, and an
// off-centre EcoRI site in the insert tells the two orientations apart. A sucrose loading dye
// sinks the samples as glycerol does; without a dense dye they float out of the wells.
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { loadAllPacks, PACKAGES, readJson } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { compile } from '../src/compile/compile.ts'
import type { ExperimentDefinition } from '../src/format/types.ts'

const { catalogue } = Catalogue.build(loadAllPacks())
const clones = readJson(join(PACKAGES, 'pack-molecular-biology', 'definitions', 'molbio7-clone-verification.labx.json')) as ExperimentDefinition
type Result = ReturnType<typeof compile>
const sizes = (r: Result, key: string) => r.kernel!.world.notebook.find((e) => e.field === `sizes-${key}`)?.value as number[]

describe('conformance: clone verification', () => {
  it('rehearses for several seeds: insert released from both clones, orientations distinct', () => {
    for (const seed of [1, 2, 3]) {
      const r = compile(clones, catalogue, { seed })
      expect(r.rehearsal!.ok).toBe(true)
      expect(r.rehearsal!.expectedObservations.every((o) => o.passed)).toBe(true)
      expect(Math.min(...sizes(r, 'c2-ecori'))).toBeLessThan(1300)
      expect(Math.min(...sizes(r, 'c1-ecori'))).toBeGreaterThan(3500)
    }
  }, 120000)

  it('without loading dye the digests float out of the wells and no bands are seen', () => {
    const def = structuredClone(clones)
    def.procedure!.steps = def.procedure!.steps!.filter((s) => s.id !== 'dye')
    const r = compile(def, catalogue, { seed: 1 })
    expect(sizes(r, 'c2-ecori') ?? []).toEqual([])
  }, 60000)
})
