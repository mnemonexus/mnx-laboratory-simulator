// Four-parameter logistic calibration: the fit, its inverse, the working range it allows, and an
// ELISA read with it, where a sample on the plateau must be diluted before it can be read.
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { loadAllPacks, PACKAGES, readJson } from '../../../apps/cli/fs-packs.ts'
import { fitFourPL, fitLinear, inverse, predict } from '../src/analysis/analysis.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { compile } from '../src/compile/compile.ts'
import type { ExperimentDefinition } from '../src/format/types.ts'

const { catalogue } = Catalogue.build(loadAllPacks())
const elisa = readJson(join(PACKAGES, 'pack-biochemistry', 'definitions', 'bio14-elisa-four-parameter.labx.json')) as ExperimentDefinition
const xs = [0, 1 / 243, 1 / 81, 1 / 27, 1 / 9, 1 / 3, 1, 3]
const truth = (x: number) => 2.3 + (0.05 - 2.3) / (1 + Math.pow(x / 0.12, 1.4))

describe('four-parameter logistic', () => {
  it('recovers the parameters of an exact curve, with small standard errors', () => {
    const f = fitFourPL(xs, xs.map(truth))
    expect(f.a).toBeCloseTo(0.05, 4)
    expect(f.d).toBeCloseTo(2.3, 4)
    expect(f.c).toBeCloseTo(0.12, 4)
    expect(f.b).toBeCloseTo(1.4, 3)
    expect(f.r2).toBeGreaterThan(0.99999)
  })

  it('inverts exactly between the asymptotes and gives nothing beyond them', () => {
    const f = fitFourPL(xs, xs.map(truth))
    expect(inverse(f, predict(f, 0.05))).toBeCloseTo(0.05, 6)
    expect(inverse(f, 2.5)).toBeNaN()
  })

  it('needs five points', () => {
    expect(() => fitFourPL([0, 1, 2, 3], [0, 1, 2, 3])).toThrow(/five/)
  })
})

describe('conformance: ELISA with a four-parameter logistic', () => {
  it('rehearses for several seeds: both samples found, the neat high sample out of range', () => {
    for (const seed of [1, 2, 3]) {
      const r = compile(elisa, catalogue, { seed })
      expect(r.rehearsal!.ok).toBe(true)
      expect(r.rehearsal!.expectedObservations.every((o) => o.passed)).toBe(true)
      expect(r.run!.decisions['above-range']).toBe('dilute')
    }
  }, 180000)

  it('a straight line cannot describe the standards; the logistic can', () => {
    const r = compile(elisa, catalogue, { seed: 1 })
    const ys = r.kernel!.world.notebook.find((e) => e.field === 'A450-standards')!.value as number[]
    const concs = [3, 1, 1 / 3, 1 / 9, 1 / 27, 1 / 81, 1 / 243, 0]
    expect(fitLinear(concs, ys).r2).toBeLessThan(0.8)
    expect(fitFourPL(concs, ys).r2).toBeGreaterThan(0.99)
  }, 60000)
})
