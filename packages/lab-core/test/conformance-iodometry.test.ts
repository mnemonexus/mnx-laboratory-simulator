// Iodometry: the I₂/2I⁻ couple (two reduced units per oxidised, so its potential depends on
// concentration), vitamin C reducing iodine completely, and starch binding the first excess as
// a blue-black complex. Without starch the eye waits for iodine's own pale yellow, and overshoots.
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
const vitc = readJson(join(PACKAGES, 'pack-chemistry', 'definitions', 'chem13-vitamin-c-iodine.labx.json')) as ExperimentDefinition
type Result = ReturnType<typeof compile>
const layer = (species: Record<string, number>, volumeL = 0.05): Layer => ({ volumeL, species })
const colour = (species: Record<string, number>) => visibleColour(catalogue, layer(species), 298.15, (s, nm) => epsilon(catalogue, s, nm))
const errorOf = (r: Result) => {
  const found = r.kernel!.world.notebook.find((e) => e.field === 'vitC-mg-per-100mL')!.value as number
  const truth = (evaluate("value(truth(conc, 'juice', 'chem:ascorbic-acid'), 'mol/L')", runEnv(r.run!)) as number) * 176.12 * 100
  return (found - truth) / truth
}

describe('iodine and iodide', () => {
  it('the potential of I₂/2I⁻ follows [I₂]/[I⁻]², so it depends on concentration, not only the ratio', () => {
    // A lone couple: E = E° + (s/2) log([I₂]/[I⁻]²).
    const E = (i2: number, i: number) => redoxEquilibrate(catalogue, layer({ 'core:iodine': i2 * 0.05, 'core:potassium-iodide': i * 0.05 }), 7, 298.15)!.potentialV
    const s = nernstSlope(298.15)
    expect(E(5e-3, 5e-2)).toBeCloseTo(0.535 + (s / 2) * Math.log10(5e-3 / 5e-2 ** 2), 6)
    // Diluting both ten-fold keeps the ratio but raises the potential by s/2.
    expect(E(5e-4, 5e-3) - E(5e-3, 5e-2)).toBeCloseTo(s / 2, 6)
  })

  it('vitamin C reduces iodine one to one, completely', () => {
    const eq = redoxEquilibrate(catalogue, layer({ 'chem:ascorbic-acid': 1e-4, 'core:iodine': 0.6e-4, 'core:potassium-iodide': 1e-3 }), 3, 298.15)!
    expect(eq.layer.species['chem:dehydroascorbic-acid']).toBeCloseTo(0.6e-4, 9)
    expect(eq.layer.species['core:iodine']).toBeLessThan(1e-12)
    expect(eq.layer.species['core:potassium-iodide']).toBeCloseTo(1e-3 + 1.2e-4, 9)
  })

  it('starch turns a trace of iodine blue-black that alone would be invisible', () => {
    const trace = { 'core:iodine': 2e-7, 'core:potassium-iodide': 2.5e-3 }
    expect(colour(trace)).toBe('colourless')
    // 1 mL of 1 % starch in 50 mL: 0.2 g/L, so 1e-5 mol of helix turns.
    expect(colour({ ...trace, 'core:starch-soluble': 1e-5 })).toBe('blue-black')
  })
})

describe('conformance: vitamin C by iodine titration', () => {
  it('rehearses for several seeds: concordant titres and the vitamin C within 1 %', () => {
    for (const seed of [1, 2, 3]) {
      const r = compile(vitc, catalogue, { seed })
      expect(r.rehearsal!.ok).toBe(true)
      expect(r.rehearsal!.expectedObservations.every((o) => o.passed)).toBe(true)
      expect(Math.abs(errorOf(r))).toBeLessThan(0.01)
    }
  }, 120000)

  it('without starch the end point is iodine’s own yellow, reached only after a clear excess: the result is high', () => {
    const def = structuredClone(vitc)
    const strip = (steps: NonNullable<ExperimentDefinition['procedure']>['steps']) =>
      steps!.filter((s) => !s.id.includes('starch')).map((s) => {
        if (s.ref === 'core:titrate-to-endpoint') s.params = { ...s.params, endColour: 'yellow' }
        if (s.steps) s.steps = strip(s.steps)
        return s
      })
    def.procedure!.steps = strip(def.procedure!.steps)
    const r = compile(def, catalogue, { seed: 1 })
    expect(errorOf(r)).toBeGreaterThan(0.03)
  }, 120000)
})
