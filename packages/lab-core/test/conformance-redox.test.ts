// Redox: couples in one solution share a potential, set by the Nernst equation and the electrons
// they hold. Permanganate oxidises iron(II) completely in acid, colours the solution only once it
// is in excess, and a platinum electrode follows the potential through the equivalence point.
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { loadAllPacks, PACKAGES, readJson } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { compile } from '../src/compile/compile.ts'
import { evaluate } from '../src/expr/evaluate.ts'
import type { ExperimentDefinition } from '../src/format/types.ts'
import type { Layer } from '../src/kernel/state.ts'
import { visibleColour } from '../src/models/acidbase.ts'
import { epsilon } from '../src/models/measurement.ts'
import { nernstSlope, redoxEquilibrate } from '../src/models/redox.ts'
import { runEnv } from '../src/run/env.ts'

const { catalogue } = Catalogue.build(loadAllPacks())
const permanganate = readJson(join(PACKAGES, 'pack-chemistry', 'definitions', 'chem12-permanganate-iron.labx.json')) as ExperimentDefinition
const FE2 = 'chem:ammonium-iron-ii-sulfate'
const FE3 = 'chem:iron-iii-aq'
const MNO4 = 'core:potassium-permanganate'
const MN2 = 'core:manganese-ii-aq'
const layer = (species: Record<string, number>): Layer => ({ volumeL: 0.05, species })

describe('redox equilibrium', () => {
  it('permanganate oxidises five iron(II) per manganese, all but completely in acid', () => {
    const eq = redoxEquilibrate(catalogue, layer({ [FE2]: 2.5e-3, [MNO4]: 0.4e-3 }), 0, 298.15)!
    expect(eq.layer.species[FE3]).toBeCloseTo(2.0e-3, 8)
    expect(eq.layer.species[MN2]).toBeCloseTo(0.4e-3, 8)
    expect(eq.layer.species[MNO4]).toBeLessThan(1e-12)
  })

  it('before equivalence the potential follows Fe³⁺/Fe²⁺ by the Nernst equation', () => {
    const E = (fraction: number) => redoxEquilibrate(catalogue, layer({ [FE2]: 2.5e-3, [MNO4]: (fraction * 2.5e-3) / 5 }), 0, 298.15)!.potentialV
    expect(E(0.5)).toBeCloseTo(0.68, 3)
    // From 10 % to 90 % titrated: 2 log 9 Nernst slopes.
    expect(E(0.9) - E(0.1)).toBeCloseTo(2 * Math.log10(9) * nernstSlope(298.15), 3)
  })

  it('the flask stays colourless while iron(II) remains, and turns pink with a slight excess', () => {
    const colour = (mno4: number) => visibleColour(catalogue, layer({ [FE2]: 2.5e-3, [MNO4]: mno4, 'core:sulfuric-acid': 0.05 }), 298.15, (s, nm) => epsilon(catalogue, s, nm))
    expect(colour(0.49e-3)).toBe('colourless')
    expect(colour(0.5e-3 + 2e-6)).toBe('pink')
  })
})

describe('conformance: iron(II) by permanganate', () => {
  it('rehearses for several seeds: titre and electrode agree, the half-equivalence potential is E°′', () => {
    for (const seed of [1, 2, 3]) {
      const r = compile(permanganate, catalogue, { seed })
      expect(r.rehearsal!.ok).toBe(true)
      expect(r.rehearsal!.expectedObservations.every((o) => o.passed)).toBe(true)
      expect(r.run!.decisions['why-no-indicator']).toBe('self')
    }
  }, 120000)

  it('the electrode wanders in a solution with no redox couple', () => {
    const r = compile(permanganate, catalogue, { seed: 1 })
    const k = r.kernel!
    const beaker = k.world.containers['curve-beaker']
    beaker.contents.layers = [{ volumeL: 0.05, species: { 'core:sulfuric-acid': 0.05 } }]
    const before = k.world.measurements.length
    k.execute({ op: 'core:measure', params: { instrument: 'electrode', subject: 'curve-beaker' } })
    const rec = k.world.measurements[before]
    expect(rec.flags['curve-beaker']).toContain('unstable')
    expect(evaluate("colour('curve-beaker')", runEnv(r.run!))).toBe('colourless')
  }, 60000)
})
