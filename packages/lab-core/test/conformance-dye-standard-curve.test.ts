// A dye standard curve from a weighed stock: the first practical to make a solution up to the mark
// in a volumetric flask. Skip that step and every standard is mislabelled, so the unknown is wrong
// however precise the readings.
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { loadAllPacks, PACKAGES, readJson } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { compile } from '../src/compile/compile.ts'
import { evaluate } from '../src/expr/evaluate.ts'
import type { ExperimentDefinition } from '../src/format/types.ts'
import { runEnv } from '../src/run/env.ts'

const { catalogue } = Catalogue.build(loadAllPacks())
const dye = readJson(join(PACKAGES, 'pack-core', 'definitions', 'core-dye-standard-curve.labx.json')) as ExperimentDefinition
type Result = ReturnType<typeof compile>
const noted = (r: Result, field: string) => r.kernel!.world.notebook.find((e) => e.field === field)?.value as number
const error = (r: Result) => {
  const truth = (evaluate("value(truth(conc, 'unknown', 'core:brilliant-blue-fcf'), 'mol/L')", runEnv(r.run!)) as number) * 792850
  return (noted(r, 'unknown-mg-per-L') - truth) / truth
}

describe('conformance: dye standard curve', () => {
  it('rehearses for several seeds: accurate and precise', () => {
    for (const seed of [1, 2, 3]) {
      const r = compile(dye, catalogue, { seed })
      expect(r.rehearsal!.ok).toBe(true)
      expect(Math.abs(error(r))).toBeLessThan(0.04)
      expect(noted(r, 'unknown-cv-%')).toBeLessThan(2)
    }
  }, 120000)

  it('without making up to the mark, every standard is mislabelled and the unknown reads far too low', () => {
    const def = structuredClone(dye)
    def.procedure!.steps = def.procedure!.steps!.filter((s) => s.id !== 'make-up')
    const r = compile(def, catalogue, { seed: 1 })
    // The stock holds 25 mL, not 50, so each standard is twice what is written, the slope per
    // written concentration doubles, and the unknown comes out at about half its true value.
    expect(error(r)).toBeLessThan(-0.3)
  }, 60000)
})
