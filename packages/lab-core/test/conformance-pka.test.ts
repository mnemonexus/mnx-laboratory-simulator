// The pKa of acetic acid from a pH titration curve: a calibrated pH meter, the equivalence point
// where the curve is steepest, and the pH at half of it.
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { loadAllPacks, PACKAGES, readJson } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { compile } from '../src/compile/compile.ts'
import { evaluate, makeEnv } from '../src/expr/evaluate.ts'
import type { ExperimentDefinition } from '../src/format/types.ts'

const { catalogue } = Catalogue.build(loadAllPacks())
const pka = readJson(join(PACKAGES, 'pack-chemistry', 'definitions', 'chem4-acetic-acid-pka.labx.json')) as ExperimentDefinition
const pKaOf = (r: ReturnType<typeof compile>) => r.kernel!.world.notebook.find((n) => n.field === 'pKa')!.value as number

describe('conformance: pKa of acetic acid', () => {
  it('rehearses for several seeds: pKa within 0.05 of 4.76 and a basic equivalence point', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const r = compile(pka, catalogue, { seed })
      expect(r.rehearsal!.ok).toBe(true)
      expect(r.rehearsal!.expectedObservations.every((o) => o.passed)).toBe(true)
      expect(Math.abs(pKaOf(r) - 4.76)).toBeLessThan(0.05)
    }
  }, 30000)

  it('an uncalibrated meter shifts the whole curve, and the pKa with it', () => {
    const def = structuredClone(pka)
    def.procedure!.steps = def.procedure!.steps!.filter((s) => s.id !== 'calibrate')
    const errors = [1, 2, 3, 4].map((seed) => Math.abs(pKaOf(compile(def, catalogue, { seed })) - 4.76))
    expect(Math.max(...errors)).toBeGreaterThan(0.1)
  })

  it('steepest() and interpolateAt() find an equivalence point and read between points', () => {
    const env = makeEnv({ v: [0, 1, 2, 3, 4], y: [3, 3.5, 4, 9, 11] })
    expect(evaluate('steepest(v, y)', env)).toBe(2.5)
    expect(evaluate('interpolateAt(v, y, 1.5)', env)).toBe(3.75)
    expect(() => evaluate('interpolateAt(v, y, 9)', env)).toThrow(/outside/)
  })
})
