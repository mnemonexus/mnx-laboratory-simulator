// Beer–Lambert with copper(II) sulfate in cuvettes: standards, a water blank, a fit through the
// origin and an unknown read from the line.
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { loadAllPacks, PACKAGES, readJson } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { compile } from '../src/compile/compile.ts'
import { evaluate } from '../src/expr/evaluate.ts'
import type { ExperimentDefinition } from '../src/format/types.ts'
import { runEnv } from '../src/run/env.ts'

const { catalogue } = Catalogue.build(loadAllPacks())
const bl = readJson(join(PACKAGES, 'pack-chemistry', 'definitions', 'chem3-beer-lambert-copper.labx.json')) as ExperimentDefinition

function relativeError(def: ExperimentDefinition, seed: number): number {
  const r = compile(def, catalogue, { seed })
  const env = runEnv(r.run!)
  const got = (evaluate("reported(conc, 'unknown')", env) as unknown as { si: number }).si
  const truth = (evaluate("truth(conc, 'unknown', 'core:copper-ii-sulfate')", env) as unknown as { si: number }).si
  return Math.abs(got / truth - 1)
}

describe('conformance: Beer–Lambert', () => {
  it('rehearses for several seeds: a straight line, ε near 12, the unknown within 3 %', () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const r = compile(bl, catalogue, { seed })
      expect(r.rehearsal!.ok).toBe(true)
      expect(r.rehearsal!.expectedObservations.every((o) => o.passed)).toBe(true)
    }
  })

  it('without the water blank the cuvette’s own absorbance biases the result', () => {
    const noBlank = structuredClone(bl)
    noBlank.procedure!.steps = noBlank.procedure!.steps!.filter((s) => s.id !== 'blank')
    const seeds = [1, 2, 3, 4]
    const withBlank = seeds.reduce((a, s) => a + relativeError(bl, s), 0) / seeds.length
    const without = seeds.reduce((a, s) => a + relativeError(noBlank, s), 0) / seeds.length
    expect(without).toBeGreaterThan(withBlank)
  })
})
