// Complexation: EDTA and Eriochrome Black T competing for calcium and magnesium, with conditional
// constants set by the pH and the protons complexing releases. The water hardness titration
// follows, and so do its classic failures: no buffer, and calcium alone with this indicator.
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { loadAllPacks, PACKAGES, readJson } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { compile } from '../src/compile/compile.ts'
import { evaluate } from '../src/expr/evaluate.ts'
import type { ExperimentDefinition } from '../src/format/types.ts'
import type { Layer } from '../src/kernel/state.ts'
import { layerSpeciation } from '../src/models/acidbase.ts'
import { complexSystemIn, speciate } from '../src/models/complexation.ts'
import { runEnv } from '../src/run/env.ts'

const { catalogue } = Catalogue.build(loadAllPacks())
const hardness = readJson(join(PACKAGES, 'pack-chemistry', 'definitions', 'chem10-edta-water-hardness.labx.json')) as ExperimentDefinition
type Result = ReturnType<typeof compile>
const noted = (r: Result, field: string) => r.kernel!.world.notebook.find((e) => e.field === field)?.value as number
const truthMgPerL = (r: Result, both = true) => {
  const env = runEnv(r.run!)
  const ca = evaluate("value(truth(conc, 'water-sample', 'core:calcium-chloride'), 'mol/L')", env) as number
  const mg = both ? (evaluate("value(truth(conc, 'water-sample', 'core:magnesium-chloride'), 'mol/L')", env) as number) : 0
  return (ca + mg) * 100.09 * 1000
}
const layer = (species: Record<string, number>): Layer => ({ volumeL: 0.1, species })

describe('complexation', () => {
  it('EDTA binds magnesium at pH 10 but hardly at pH 5: the conditional constant follows its deprotonation', () => {
    const cs = complexSystemIn(catalogue, layer({ 'core:edta': 1e-4, 'core:magnesium-chloride': 1e-4 }))!
    expect(speciate(cs, 10).bound['core:edta']['Mg2+']).toBeGreaterThan(0.97)
    expect(speciate(cs, 5).bound['core:edta']['Mg2+']).toBeLessThan(0.3)
  })

  it('EDTA takes calcium before magnesium, and the indicator only once EDTA runs short', () => {
    const cs = complexSystemIn(catalogue, layer({ 'core:edta': 1e-4, 'core:calcium-chloride': 1e-4, 'core:magnesium-chloride': 1e-4, 'chem:eriochrome-black-t': 3e-6 }))!
    const sp = speciate(cs, 10)
    expect(sp.bound['core:edta']['Ca2+']).toBeGreaterThan(0.85)
    expect(sp.bound['chem:eriochrome-black-t']['Mg2+']).toBeGreaterThan(0.9)
  })

  it('complexing releases the ligand’s protons: metal ions turn an unbuffered EDTA solution more acid', () => {
    const pH = (species: Record<string, number>) => layerSpeciation(catalogue, layer(species), 298.15).pH!
    const edta = pH({ 'core:edta': 1e-3 })
    const withMg = pH({ 'core:edta': 1e-3, 'core:magnesium-chloride': 1e-3 })
    const withCa = pH({ 'core:edta': 1e-3, 'core:calcium-chloride': 1e-3 })
    expect(edta).toBeGreaterThan(4.2)
    expect(edta).toBeLessThan(5.0)
    // In acid little EDTA is fully deprotonated, so binding (and the protons it frees) limits itself;
    // calcium, bound a hundred times more firmly, gets further.
    expect(withMg).toBeLessThan(edta - 0.3)
    expect(withCa).toBeLessThan(withMg - 0.3)
  })

  it('Eriochrome Black T is wine red holding magnesium and blue when free at pH 10', () => {
    const buffer = { 'core:ammonia': 0.0036, 'core:ammonium-chloride': 0.00064, 'chem:eriochrome-black-t': 3e-6 }
    const env = (species: Record<string, number>) => {
      const r = compile(hardness, catalogue, { seed: 1 })
      r.kernel!.world.containers['flask-1'].contents.layers = [layer(species)]
      return evaluate("colour('flask-1')", runEnv(r.run!))
    }
    expect(env({ ...buffer, 'core:magnesium-chloride': 5e-5 })).toBe('wine red')
    expect(env(buffer)).toBe('blue')
  }, 60000)
})

describe('conformance: water hardness by EDTA titration', () => {
  it('rehearses for several seeds: concordant titres, hardness within 1 % (the end point a little early)', () => {
    for (const seed of [1, 2, 3]) {
      const r = compile(hardness, catalogue, { seed })
      expect(r.rehearsal!.ok).toBe(true)
      expect(r.rehearsal!.expectedObservations.every((o) => o.passed)).toBe(true)
      const err = (noted(r, 'hardness-mg-per-L') - truthMgPerL(r)) / truthMgPerL(r)
      expect(err).toBeLessThan(0)
      expect(err).toBeGreaterThan(-0.01)
    }
  }, 120000)

  it('without the buffer the released protons acidify the flask and the blue end point never comes', () => {
    // The rough titration alone: it runs on past every end point until the burette is spent.
    const def = structuredClone(hardness)
    def.procedure!.steps = def.procedure!.steps!.filter((s) => s.id === 'fill' || s.id === 'rough')
    def.procedure!.steps = def.procedure!.steps.map((s) => ({ ...s, ...(s.steps ? { steps: s.steps.filter((x) => !x.id.includes('buffer')) } : {}) }))
    const r = compile(def, catalogue, { seed: 1 })
    const env = runEnv(r.run!)
    expect(evaluate("pH('flask-rough')", env) as number).toBeLessThan(5)
    expect(evaluate("colour('flask-rough')", env)).not.toBe('blue')
    const expected = (truthMgPerL(r) / 100.09 / 1000) * 0.05 / 0.01
    expect(evaluate("value(first(recorded('rough-titre')), 'L')", env) as number).toBeGreaterThan(1.5 * expected)
  }, 120000)

  it('with calcium alone the indicator lets go too soon: the titre is about 10 % low', () => {
    const def = structuredClone(hardness)
    def.materials!.samples![0].contains = [def.materials!.samples![0].contains![0]]
    const r = compile(def, catalogue, { seed: 1 })
    const err = (noted(r, 'hardness-mg-per-L') - truthMgPerL(r, false)) / truthMgPerL(r, false)
    expect(err).toBeLessThan(-0.08)
  }, 120000)
})
