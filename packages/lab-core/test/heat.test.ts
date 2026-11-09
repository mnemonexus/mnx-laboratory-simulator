// Reaction heats by Hess's law (models/thermochem.ts): ion carriers at their standard enthalpies of
// formation, species and solids by PHREEQC's ΔH, crystalline salts and solutes by theirs. Each
// temperature change follows from that data through the kernel, in an insulated cup so that
// little heat is lost, and is compared with the textbook enthalpy (q = m c ΔT, c = 4.184 J/g/K).
import { describe, expect, it } from 'vitest'
import { loadAllPacks } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { addSupply, createKernel, emptyWorld } from '../src/kernel/index.ts'

const { catalogue: cat } = Catalogue.build(loadAllPacks())

function cup(liquids: Array<[id: string, substance: string, conc: string]>, solids: string[] = []) {
  const w = emptyWorld(1)
  for (const [id, substance, conc] of liquids) addSupply(w, cat, { id, label: id, container: 'core:reagent-bottle-250ml', amount: '200 mL', components: [{ substance, conc }] })
  for (const s of solids) addSupply(w, cat, { id: s, label: s, container: 'core:weighing-bottle', solids: [{ substance: s, massG: 50 }] } as never)
  const k = createKernel(cat, w)
  const run = (op: string, params: Record<string, unknown>) => {
    const r = k.execute({ op, params })
    if (!r.ok) throw new Error(`${op}: ${r.refusal.message}`)
  }
  run('core:fetch', { equipment: 'core:calorimeter-cup', id: 'cup' })
  const T = () => k.world.containers.cup.contents.temperatureK
  // The highest temperature over a time (the reaction against the cup's slow heat loss).
  const peak = (seconds: number, every = 5) => {
    let max = T()
    for (let t = 0; t < seconds; t += every) {
      run('core:advance-time', { duration: `${every} s` })
      max = Math.max(max, T())
    }
    return max
  }
  return { k, run, T, peak }
}
const dT = (kJPerMol: number, mol: number, grams: number) => (-kJPerMol * 1000 * mol) / (4.184 * grams)

describe('heat of reactions in solution', () => {
  it('neutralisation: strong acid and base, −55.8 kJ per mole of water', () => {
    const { run, T } = cup([['acid', 'aq:hydrochloric-acid', '1 mol/L'], ['base', 'aq:sodium-hydroxide', '1 mol/L']])
    run('core:transfer', { source: 'acid', destination: 'cup', volume: '25 mL', tool: 'pour' })
    const t0 = T()
    run('core:transfer', { source: 'base', destination: 'cup', volume: '25 mL', tool: 'pour' })
    run('core:mix', { container: 'cup', method: 'stir', cycles: 5 })
    expect(T() - t0).toBeCloseTo(dT(-55.8, 0.025, 50), 0)
  })

  it('silver chloride precipitating gives out its heat of precipitation (−65 kJ/mol)', () => {
    const { run, T } = cup([['ag', 'aq:silver-nitrate', '0.5 mol/L'], ['cl', 'aq:sodium-chloride', '0.5 mol/L']])
    run('core:transfer', { source: 'ag', destination: 'cup', volume: '25 mL', tool: 'pour' })
    const t0 = T()
    run('core:transfer', { source: 'cl', destination: 'cup', volume: '25 mL', tool: 'pour' })
    run('core:mix', { container: 'cup', method: 'stir', cycles: 5 })
    const expected = dT(-65.2, 0.0125, 50)
    expect(T() - t0).toBeGreaterThan(0.9 * expected)
    expect(T() - t0).toBeLessThan(1.1 * expected)
  })
})

describe('heat of reactions at surfaces', () => {
  it('zinc displacing copper: −218.7 kJ/mol from the ions’ standard enthalpies', () => {
    const { run, T, peak } = cup([['cu', 'aq:copper-ii-sulfate', '0.5 mol/L']], ['aq:zinc-powder'])
    run('core:transfer', { source: 'cu', destination: 'cup', volume: '25 mL', tool: 'pour' })
    const t0 = T()
    run('core:add-solid', { substance: 'aq:zinc-powder', destination: 'cup', mass: '1.5 g' })
    run('core:mix', { container: 'cup', method: 'stir', cycles: 3 })
    const rise = peak(240) - t0
    const expected = dT(-218.7, 0.0125, 25)
    expect(rise).toBeGreaterThan(0.85 * expected)
    expect(rise).toBeLessThan(1.05 * expected)
  })

  it('magnesium in acid: −466.9 kJ/mol', () => {
    const { run, T, peak } = cup([['acid', 'aq:hydrochloric-acid', '1 mol/L']], ['aq:magnesium-powder'])
    run('core:transfer', { source: 'acid', destination: 'cup', volume: '50 mL', tool: 'pour' })
    const t0 = T()
    run('core:add-solid', { substance: 'aq:magnesium-powder', destination: 'cup', mass: '0.1 g' })
    const rise = peak(60)
    const expected = dT(-466.9, 0.1 / 24.305, 50)
    expect(rise - t0).toBeGreaterThan(0.85 * expected)
    expect(rise - t0).toBeLessThan(1.05 * expected)
  })

  it('hydrogen peroxide decomposing on manganese(IV) oxide warms the liquid (−98 kJ/mol), and with catalase too', () => {
    const mno2 = cup([['p', 'core:hydrogen-peroxide', '1 mol/L']])
    mno2.run('core:transfer', { source: 'p', destination: 'cup', volume: '20 mL', tool: 'pour' })
    const t0 = mno2.T()
    mno2.run('core:add-solid', { substance: 'aq:manganese-dioxide', destination: 'cup', mass: '1 g' })
    expect(mno2.peak(300, 10) - t0).toBeGreaterThan(0.8 * dT(-98.2, 0.02, 20))
    const enzyme = cup([['p', 'core:hydrogen-peroxide', '1 mol/L'], ['e', 'bio:catalase', '0.5 mg/mL']])
    enzyme.run('core:transfer', { source: 'p', destination: 'cup', volume: '20 mL', tool: 'pour' })
    const t1 = enzyme.T()
    enzyme.run('core:transfer', { source: 'e', destination: 'cup', volume: '1 mL', tool: 'pour' })
    enzyme.run('core:mix', { container: 'cup', method: 'stir', cycles: 3 })
    expect(enzyme.peak(300, 10) - t1).toBeGreaterThan(2)
  })
})

describe('heat of solution', () => {
  it('ammonium nitrate cools the water, sodium hydroxide and calcium chloride warm it; salt barely changes it', () => {
    const dissolve = (salt: string) => {
      const { run, T } = cup([['water', 'core:sodium-chloride', '0 mol/L']], [salt])
      run('core:transfer', { source: 'water', destination: 'cup', volume: '50 mL', tool: 'pour' })
      const t0 = T()
      run('core:add-solid', { substance: salt, destination: 'cup', mass: '5 g' })
      run('core:mix', { container: 'cup', method: 'stir', cycles: 5 })
      return T() - t0
    }
    expect(dissolve('aq:ammonium-nitrate')).toBeLessThan(-6)
    expect(dissolve('core:sodium-hydroxide')).toBeGreaterThan(20)
    expect(dissolve('aq:calcium-chloride')).toBeGreaterThan(13)
    expect(Math.abs(dissolve('core:sodium-chloride'))).toBeLessThan(2)
    // Anhydrous copper sulfate warms; the pentahydrate cools (Hess's law: the hydration enthalpy).
    expect(dissolve('aq:copper-ii-sulfate')).toBeGreaterThan(5)
    expect(dissolve('aq:copper-ii-sulfate-pentahydrate')).toBeLessThan(0)
  })
})
