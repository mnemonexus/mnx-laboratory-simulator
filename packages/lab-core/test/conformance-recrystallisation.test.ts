// Solids and separations: solubility over temperature and pH, boiling, filtration and washing,
// drying, and melting point (spec example 4's capabilities, as a prescribed practical).
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { docExamples, loadAllPacks, PACKAGES, readJson } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { compile } from '../src/compile/compile.ts'
import { evaluate } from '../src/expr/evaluate.ts'
import type { ExperimentDefinition, StepDef } from '../src/format/types.ts'
import { addPlace, addSupply, createKernel, emptyWorld, liquidVolume } from '../src/kernel/index.ts'
import { meltingRange } from '../src/models/melting.ts'
import { runEnv } from '../src/run/env.ts'

const { catalogue } = Catalogue.build(loadAllPacks())
const recryst = readJson(join(PACKAGES, 'pack-chemistry', 'definitions', 'chem2-recrystallise-benzoic-acid.labx.json')) as ExperimentDefinition
const BA = 'chem:benzoic-acid'

function variant(change: (steps: StepDef[]) => void): ExperimentDefinition {
  const def = structuredClone(recryst)
  change(def.procedure!.steps!)
  return def
}
const step = (steps: StepDef[], id: string) => steps.find((s) => s.id === id)!

/** Recovered fraction, purity and the melting-point record of a rehearsal. */
function outcome(def: ExperimentDefinition, seed = 1) {
  const r = compile(def, catalogue, { seed })
  const env = runEnv(r.run!)
  const num = (e: string) => {
    const v = evaluate(e, env) as unknown as { si?: number } | number
    return typeof v === 'number' ? v : v.si!
  }
  const mp = r.kernel!.world.measurements.find((m) => m.quantity === 'temperature')
  return {
    r,
    recovery: num(`mass('dish', '${BA}') / truth(mass, 'mix', '${BA}')`),
    purity: num(`purity('dish', '${BA}')`),
    mp,
  }
}

describe('conformance: recrystallising benzoic acid', () => {
  it('rehearses for several seeds: >80 % recovery, pure, sharp melting point', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const { r, recovery, purity, mp } = outcome(recryst, seed)
      expect(r.rehearsal!.ok).toBe(true)
      expect(r.rehearsal!.expectedObservations.every((o) => o.passed)).toBe(true)
      expect(recovery).toBeGreaterThan(0.8)
      expect(recovery).toBeLessThan(1)
      expect(purity).toBeGreaterThan(0.995)
      expect(mp!.range![1] - mp!.range![0]).toBeLessThan(1.5)
    }
  }, 30000)

  it('without washing, the dried mother liquor leaves salt in the product', () => {
    const { r, purity, mp } = outcome(variant((s) => (step(s, 'collect').params!.washes = 0)))
    expect(purity).toBeLessThan(0.98)
    expect(r.rehearsal!.goals[0].passed).toBe(false)
    // Salt does not dissolve in the melt: the range stays sharp but a residue is left.
    expect(mp!.flags.dish).toContain('residue')
  })

  it('washing with warm water or using too much solvent costs yield', () => {
    const ref = outcome(recryst).recovery
    const warm = outcome(variant((s) => Object.assign(step(s, 'collect').params!, { wash: 'water', washVolume: '20 mL' }))).recovery
    const dilute = outcome(variant((s) => (step(s, 'recrystallise').params!.volume = '80 mL'))).recovery
    expect(warm).toBeLessThan(ref - 0.05)
    expect(dilute).toBeLessThan(ref - 0.05)
  })

  it('filtering while the solution is still hot collects nothing', () => {
    const r = compile(variant((s) => Object.assign(step(s, 'recrystallise').params!, { benchCool: '2 min', iceCool: '1 s' })), catalogue, { seed: 1 })
    expect(r.rehearsal!.ok).toBe(false)
    expect(r.rehearsal!.issues.some((i) => i.message.includes('holds no solid'))).toBe(true)
  })

  it('a product that is not dry weighs heavy and melts low and broad', () => {
    const { r, mp } = outcome(variant((s) => Object.assign(step(s, 'dry').params!, { method: 'air', duration: '1 min' })))
    expect(parseFloat(String(r.run!.outputs.weigh.value))).toBeGreaterThan(1.5)
    expect(mp!.flags.dish).toContain('wet')
    expect(mp!.range![1]).toBeLessThan(118)
    expect(mp!.range![1] - mp!.range![0]).toBeGreaterThan(5)
  })
})

describe('solubility, boiling and melting', () => {
  function flask(seed = 1) {
    const w = emptyWorld(seed)
    addPlace(w, catalogue, 'hot', 'core:hot-plate')
    addPlace(w, catalogue, 'ice', 'core:ice-bath')
    addSupply(w, catalogue, { id: 'f', label: 'Flask', container: 'core:conical-flask-100ml', amount: '0 g', solids: [{ substance: BA, massG: 1.0 }] })
    addSupply(w, catalogue, { id: 'water', label: 'Water', container: 'core:reagent-bottle-1l', amount: '500 mL', preparation: 'core:water-deionised' })
    return createKernel(catalogue, w)
  }
  const dissolvedG = (k: ReturnType<typeof flask>) => k.world.containers.f.contents.layers.reduce((a, l) => a + (l.species[BA] ?? 0), 0) * 122.12

  it('follows the solubility curve: little dissolves cold, all of it near boiling, and it comes back out on cooling', () => {
    const k = flask()
    k.execute({ op: 'core:transfer', params: { source: 'water', destination: 'f', volume: '40 mL', tool: 'pour' } })
    k.execute({ op: 'core:mix', params: { container: 'f', method: 'swirl', cycles: 3 } })
    const v = liquidVolume(k.world.containers.f.contents) * 1000
    expect(dissolvedG(k)).toBeCloseTo((3.0 * v) / 1000, 1) // about 3 g/L at 21 °C
    k.execute({ op: 'core:set-environment', params: { device: 'hot', temperature: '150 Cel' } })
    k.execute({ op: 'core:place-in', params: { container: 'f', place: 'hot' } })
    k.execute({ op: 'core:advance-time', params: { duration: '12 min' } })
    k.execute({ op: 'core:mix', params: { container: 'f', method: 'swirl', cycles: 3 } })
    expect(k.world.containers.f.contents.temperatureK).toBeCloseTo(373.15, 5)
    expect(dissolvedG(k)).toBeCloseTo(1.0, 6)
    // Boiling took solvent away.
    expect(liquidVolume(k.world.containers.f.contents) * 1000).toBeLessThan(v - 1)
    k.execute({ op: 'core:place-in', params: { container: 'f', place: 'ice' } })
    k.execute({ op: 'core:advance-time', params: { duration: '30 min' } })
    expect(dissolvedG(k)).toBeLessThan(0.1)
    expect((k.world.containers.f.contents.solid[BA] ?? 0) * 122.12).toBeGreaterThan(0.9)
  })

  it('dissolves as benzoate in excess hydroxide and precipitates again when acidified', () => {
    const w = emptyWorld(1)
    addSupply(w, catalogue, { id: 'f', label: 'Flask', container: 'core:conical-flask-100ml', amount: '0 g', solids: [{ substance: BA, massG: 0.5 }] })
    addSupply(w, catalogue, { id: 'naoh', label: 'NaOH 1 M', container: 'core:reagent-bottle-50ml', amount: '50 mL', components: [{ substance: 'core:sodium-hydroxide', conc: '1 mol/L' }] })
    addSupply(w, catalogue, { id: 'hcl', label: 'HCl 1 M', container: 'core:reagent-bottle-50ml', amount: '50 mL', components: [{ substance: 'core:hydrochloric-acid', conc: '1 mol/L' }] })
    addSupply(w, catalogue, { id: 'water', label: 'Water', container: 'core:reagent-bottle-1l', amount: '500 mL', preparation: 'core:water-deionised' })
    const k = createKernel(catalogue, w)
    const solidG = () => (k.world.containers.f.contents.solid[BA] ?? 0) * 122.12
    k.execute({ op: 'core:transfer', params: { source: 'water', destination: 'f', volume: '30 mL', tool: 'pour' } })
    k.execute({ op: 'core:mix', params: { container: 'f', method: 'swirl', cycles: 3 } })
    expect(solidG()).toBeGreaterThan(0.3)
    // 5 mmol of hydroxide for 4.1 mmol of acid.
    k.execute({ op: 'core:transfer', params: { source: 'naoh', destination: 'f', volume: '5 mL' } })
    k.execute({ op: 'core:mix', params: { container: 'f', method: 'swirl', cycles: 3 } })
    expect(solidG()).toBeLessThan(1e-6)
    k.execute({ op: 'core:transfer', params: { source: 'hcl', destination: 'f', volume: '6 mL' } })
    k.execute({ op: 'core:mix', params: { container: 'f', method: 'swirl', cycles: 3 } })
    expect(solidG()).toBeGreaterThan(0.35)
  })

  it('depresses and broadens the melting point by about the ideal amount for a soluble impurity', () => {
    const pure = meltingRange(catalogue, { layers: [], solid: { [BA]: 0.98 }, temperatureK: 294 })!
    const impure = meltingRange(catalogue, { layers: [], solid: { [BA]: 0.98, 'core:potassium-hydrogen-phthalate': 0.02 }, temperatureK: 294 })!
    // ΔT = R·Tm²/ΔHfus · x = 8.314 × 395.55² / 18000 × 0.02 ≈ 1.45 K
    expect(pure.clearK - impure.clearK).toBeCloseTo(1.45, 1)
    expect(impure.clearK - impure.onsetK).toBeGreaterThan(pure.clearK - pure.onsetK + 1.5)
    const salty = meltingRange(catalogue, { layers: [], solid: { [BA]: 0.98, 'core:sodium-chloride': 0.05 }, temperatureK: 294 })!
    expect(salty.clearK).toBeCloseTo(pure.clearK, 6)
    expect(salty.residue).toBe(true)
  })

  it('a filter keeps the solid and passes the liquid, minus what the wet cake holds', () => {
    const w = emptyWorld(1)
    addSupply(w, catalogue, { id: 'slurry', label: 'Slurry', container: 'core:beaker-100ml', amount: '50 mL', preparation: 'core:water-deionised' })
    w.containers.slurry.contents.solid[BA] = 2.0 / 122.12
    const k = createKernel(catalogue, w)
    k.execute({ op: 'core:fetch', params: { equipment: 'core:buchner-funnel-70mm', id: 'funnel' } })
    k.execute({ op: 'core:fetch', params: { equipment: 'core:filter-flask-250ml', id: 'flask' } })
    const r = k.execute({ op: 'core:filter', params: { source: 'slurry', filter: 'funnel', filtrate: 'flask' } })
    expect(r.ok).toBe(true)
    const cakeL = liquidVolume(k.world.containers.funnel.contents)
    expect(cakeL * 1000).toBeGreaterThan(1.5)
    expect(cakeL * 1000).toBeLessThan(2.1)
    expect(liquidVolume(k.world.containers.flask.contents) * 1000).toBeGreaterThan(47.5)
    expect(k.execute({ op: 'core:filter', params: { source: 'slurry', filter: 'flask', filtrate: 'funnel' } })).toMatchObject({ ok: false, refusal: { code: 'NOT-A-FILTER' } })
  })

  it('the objective-mode challenge is fully supported and is not rehearsed', () => {
    const ex = docExamples().find((d) => d.title.startsWith('4. Transferal'))!
    const r = compile(ex.json, catalogue, { seed: 1 })
    expect(r.coverage!.verdict).toBe('fully-supported')
    expect(r.validation.findings.some((f) => f.code === 'ED-V4-NO-REFERENCE')).toBe(true)
    expect(r.rehearsal!.events).toBe(0)
  })
})
