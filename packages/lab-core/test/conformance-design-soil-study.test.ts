// Designing a soil study: compare two microcosms that differ only in fertiliser, with replicate
// subsamples, and test the difference; the conclusion must follow from the test.
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { loadAllPacks, PACKAGES, readJson } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { compile } from '../src/compile/compile.ts'
import type { ExperimentDefinition } from '../src/format/types.ts'

const { catalogue } = Catalogue.build(loadAllPacks())
const study = readJson(join(PACKAGES, 'pack-microbiology', 'definitions', 'micro14-design-a-soil-study.labx.json')) as ExperimentDefinition

describe('conformance: designing a soil study', () => {
  it('rehearses for several seeds: fertiliser about triples the degrader on the fuel', () => {
    for (const seed of [1, 2, 3]) {
      const r = compile(study, catalogue, { seed })
      expect(r.rehearsal!.ok).toBe(true)
      expect(r.rehearsal!.goals.every((g) => g.passed)).toBe(true)
      expect(r.rehearsal!.expectedObservations.every((e) => e.passed)).toBe(true)
    }
  }, 600000)

  it('without the fertiliser in it, the "fertilised" soil is no different and the test finds nothing', () => {
    const def = structuredClone(study)
    const fert = def.materials!.samples!.find((s) => s.id === 'fert')!
    fert.contains = fert.contains!.filter((c) => !['core:ammonium-chloride', 'core:potassium-dihydrogen-phosphate'].includes(String(c.substance)))
    const r = compile(def, catalogue, { seed: 1 })
    expect(r.run!.decisions['conclude']).toBe('none')
    expect(r.rehearsal!.expectedObservations[0].passed).toBe(false)
  }, 300000)
})
