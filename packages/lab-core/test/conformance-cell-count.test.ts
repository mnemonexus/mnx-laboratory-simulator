// Counting cells with a haemocytometer and trypan blue: Poisson counts per square, a vital stain
// that marks dead cells, and the arithmetic left to the learner.
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { loadAllPacks, PACKAGES, readJson } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { compile } from '../src/compile/compile.ts'
import { evaluate } from '../src/expr/evaluate.ts'
import type { ExperimentDefinition, StepDef } from '../src/format/types.ts'
import { poissonFrom } from '../src/models/counting.ts'
import { createRng } from '../src/rng/rng.ts'
import { runEnv } from '../src/run/env.ts'

const { catalogue } = Catalogue.build(loadAllPacks())
const count = readJson(join(PACKAGES, 'pack-microbiology', 'definitions', 'micro3-yeast-count.labx.json')) as ExperimentDefinition

function variant(change: (steps: StepDef[]) => void): ExperimentDefinition {
  const def = structuredClone(count)
  change(def.procedure!.steps!)
  return def
}

describe('conformance: haemocytometer count', () => {
  it('rehearses for several seeds within the Poisson and pipetting error', () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const r = compile(count, catalogue, { seed })
      expect(r.rehearsal!.ok).toBe(true)
    }
  })

  it('an undiluted culture is too crowded to count', () => {
    const def = variant((s) => {
      const step = s.find((x) => x.id === 'count')!
      step.params = { ...step.params, sample: 'yeast', dilution: 1 }
      s.splice(0, s.length, step)
    })
    const r = compile(def, catalogue, { seed: 3 })
    const rec = r.kernel!.world.measurements.find((m) => m.unit === '{cells}')!
    expect(rec.flags[rec.subject]).toContain('too-many')
    expect(r.rehearsal!.ok).toBe(false)
  })

  it('without trypan blue every cell looks alive', () => {
    const r = compile(variant((s) => (s.find((x) => x.id === 'count')!.params!.stain = 'water')), catalogue, { seed: 2 })
    const env = runEnv(r.run!)
    expect(evaluate("first(recorded('viability'))", env)).toBe(1)
    expect(r.rehearsal!.goals.find((g) => g.id === 'g-viability')!.passed).toBe(false)
  })

  it('draws Poisson counts with the right mean and variance', () => {
    const rng = createRng('poisson')
    const xs = Array.from({ length: 4000 }, () => poissonFrom(rng, 20))
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length
    const v = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1)
    expect(mean).toBeGreaterThan(19.5)
    expect(mean).toBeLessThan(20.5)
    expect(v).toBeGreaterThan(18)
    expect(v).toBeLessThan(22)
  })
})
