// Gases and metals through the kernel (models/surface.ts, models/gases.ts, kernel/ops-gas.ts): solids
// that react at their surface, the gas they give off, where it goes and how it is tested. Each
// consequence follows from data (standard potentials, rate constants per m², Henry's constants and
// the ionic model's log K), not from rules about particular reagents.
import { describe, expect, it } from 'vitest'
import { loadAllPacks } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { addEquipment, addSupply, createKernel, emptyWorld } from '../src/kernel/index.ts'
import { contentsMassKg } from '../src/kernel/materials.ts'
import { meanLayer } from '../src/kernel/state.ts'
import { layerPH } from '../src/models/acidbase.ts'
import { daviesA, isIonic } from '../src/models/ionic.ts'
import { appearance } from '../src/models/measurement.ts'

const { catalogue: cat } = Catalogue.build(loadAllPacks())

function lab(reagents: Array<[id: string, substance: string, conc: string]>) {
  const w = emptyWorld(1)
  addEquipment(w, cat, 'syringe', 'core:gas-syringe-100ml')
  for (const [id, substance, conc] of reagents) {
    addSupply(w, cat, { id, label: id, container: 'core:reagent-bottle-250ml', amount: '200 mL', components: [{ substance, conc }] })
  }
  const k = createKernel(cat, w)
  const run = (op: string, params: Record<string, unknown>) => {
    const r = k.execute({ op, params })
    if (!r.ok) throw new Error(`${op}: ${r.refusal.message}`)
    return r.outputs as Record<string, unknown>
  }
  const solid = (id: string, s: string) => {
    const c = k.world.containers[id].contents
    return (c.solid[s] ?? 0) + c.layers.reduce((a, l) => a + (l.particles?.[s] ?? 0), 0)
  }
  return { k, run, solid }
}
const MG = 24.305

describe('metals and acid', () => {
  it('magnesium ribbon gives the hydrogen its mass predicts, into a gas syringe', () => {
    const { k, run, solid } = lab([['hcl', 'aq:hydrochloric-acid', '1 mol/L']])
    run('core:fetch', { equipment: 'core:conical-flask-100ml', id: 'f' })
    run('core:transfer', { source: 'hcl', destination: 'f', volume: '50 mL', tool: 'pour' })
    run('core:add-solid', { substance: 'aq:magnesium-ribbon', destination: 'f', mass: '0.05 g' })
    run('core:connect-gas', { container: 'f', syringe: 'syringe' })
    const reads: number[] = []
    for (let i = 0; i < 9; i++) {
      run('core:advance-time', { duration: '10 s' })
      reads.push(parseFloat(String(run('core:measure', { instrument: 'syringe', subject: 'f' }).value)))
    }
    // A ribbon thins at constant area: a steady rate, then done within about a minute.
    expect(reads[1] - reads[0]).toBeGreaterThan(5)
    expect(solid('f', 'aq:magnesium-ribbon')).toBeLessThan(1e-6)
    // 0.05 g / 24.3 g/mol of hydrogen at 20 °C and 1 atm, less the little that stays dissolved.
    const predicted = (0.05 / MG) * 0.082057 * 293.15 * 1000
    expect(reads.at(-1)!).toBeGreaterThan(predicted - 3)
    expect(reads.at(-1)!).toBeLessThan(predicted + 2)
    // The acid paid for it: two H⁺ per magnesium, so 1 M → about 0.92 M; the pH is −log of its
    // activity (Davies, the ionic strength about 1 M).
    const left = 1 - (2 * 0.05) / MG / 0.05
    const logGamma = -daviesA(298) * (1 / 2 - 0.3)
    expect(layerPH(cat, meanLayer(k.world.containers.f.contents), 298)!).toBeCloseTo(-Math.log10(left) - logGamma, 1)
  })

  it('powder reacts faster than ribbon of the same mass, and hotter acid faster than cold', () => {
    const left = (form: string, kelvin: number) => {
      const { k, run, solid } = lab([['hcl', 'aq:hydrochloric-acid', '0.5 mol/L']])
      run('core:fetch', { equipment: 'core:conical-flask-100ml', id: 'f' })
      run('core:transfer', { source: 'hcl', destination: 'f', volume: '50 mL', tool: 'pour' })
      k.world.containers.f.contents.temperatureK = kelvin
      run('core:add-solid', { substance: form, destination: 'f', mass: '0.05 g' })
      run('core:advance-time', { duration: '5 s' })
      return solid('f', form) / (0.05 / MG)
    }
    expect(left('aq:magnesium-powder', 293)).toBeLessThan(left('aq:magnesium-ribbon', 293) - 0.2)
    expect(left('aq:magnesium-ribbon', 313)).toBeLessThan(left('aq:magnesium-ribbon', 293))
  })

  it('copper does not react with dilute acid', () => {
    const { run, solid } = lab([['hcl', 'aq:hydrochloric-acid', '1 mol/L']])
    run('core:fetch', { equipment: 'core:test-tube', id: 't' })
    run('core:transfer', { source: 'hcl', destination: 't', volume: '5 mL', tool: 'pour' })
    run('core:add-solid', { substance: 'aq:copper-turnings', destination: 't', mass: '0.2 g' })
    const added = solid('t', 'aq:copper-turnings')
    run('core:advance-time', { duration: '5 min' })
    expect(solid('t', 'aq:copper-turnings')).toBe(added)
    expect(String(run('core:test-gas', { container: 't', test: 'lighted-splint' }).appearance)).not.toMatch(/squeaky/)
  })
})

describe('displacement', () => {
  it('zinc takes the copper out of copper sulfate; the blue fades and copper deposits', () => {
    const { k, run, solid } = lab([['cu', 'aq:copper-ii-sulfate', '0.5 mol/L']])
    run('core:fetch', { equipment: 'core:test-tube', id: 't' })
    run('core:transfer', { source: 'cu', destination: 't', volume: '5 mL', tool: 'pour' })
    const before = appearance(cat, k.world.containers.t, 1.4)!
    run('core:add-solid', { substance: 'aq:zinc-powder', destination: 't', mass: '0.5 g' })
    const zincAdded = solid('t', 'aq:zinc-powder')
    run('core:advance-time', { duration: '10 min' })
    const cuIn = 0.5 * 0.005
    // Electrons balance: each zinc that goes into solution puts one copper out as metal (and a
    // little zinc goes to the H⁺ that copper ions' hydrolysis makes, as hydrogen).
    const zincUsed = zincAdded - solid('t', 'aq:zinc-powder')
    expect(solid('t', 'aq:copper-metal')).toBeLessThanOrEqual(zincUsed)
    expect(solid('t', 'aq:copper-metal')).toBeGreaterThan(0.99 * zincUsed)
    expect(solid('t', 'aq:copper-metal')).toBeGreaterThan(0.9 * cuIn)
    expect(before.liquidName).toMatch(/blue/)
    expect(appearance(cat, k.world.containers.t, 1.4)!.liquidName).not.toMatch(/blue/)
  })

  it('copper does not displace zinc, but does displace silver', () => {
    const { run, solid } = lab([['zn', 'aq:zinc-sulfate', '0.5 mol/L'], ['ag', 'aq:silver-nitrate', '0.1 mol/L']])
    run('core:fetch', { equipment: 'core:test-tube', id: 'a' })
    run('core:fetch', { equipment: 'core:test-tube', id: 'b' })
    run('core:transfer', { source: 'zn', destination: 'a', volume: '5 mL', tool: 'pour' })
    run('core:transfer', { source: 'ag', destination: 'b', volume: '5 mL', tool: 'pour' })
    run('core:add-solid', { substance: 'aq:copper-turnings', destination: 'a', mass: '0.5 g' })
    run('core:add-solid', { substance: 'aq:copper-turnings', destination: 'b', mass: '0.5 g' })
    run('core:advance-time', { duration: '10 min' })
    expect(solid('a', 'aq:zinc-metal')).toBe(0)
    expect(solid('b', 'aq:silver-metal')).toBeGreaterThan(0)
  })
})

describe('carbonates and acid', () => {
  it('the flask loses exactly the carbon dioxide that leaves it, and powder loses it sooner than chips', () => {
    const run30 = (form: string) => {
      const { k, run, solid } = lab([['hcl', 'aq:hydrochloric-acid', '1 mol/L']])
      run('core:fetch', { equipment: 'core:conical-flask-100ml', id: 'f' })
      run('core:transfer', { source: 'hcl', destination: 'f', volume: '50 mL', tool: 'pour' })
      // The kernel replaces the world on each operation: read the flask afresh each time.
      const grams = () => contentsMassKg(cat, k.world.containers.f.contents) * 1000
      const m0 = grams()
      run('core:add-solid', { substance: form, destination: 'f', mass: '2 g' })
      const added = grams() - m0
      run('core:advance-time', { duration: '1 min' })
      const early = m0 + added - grams()
      run('core:advance-time', { duration: '30 min' })
      const reacted = added / 100.0869 - solid('f', form)
      const lost = m0 + added - grams()
      return { early, lost, reacted, left: solid('f', form) }
    }
    const chips = run30('aq:marble-chips')
    const powder = run30('aq:powdered-marble')
    expect(powder.early).toBeGreaterThan(2 * chips.early)
    // All 2 g react (the acid is in excess); what is lost is CO₂ (44.01 g/mol) that left, less
    // what is still dissolved at saturation or in the headspace.
    expect(powder.left).toBeLessThan(1e-9)
    const co2 = powder.reacted * 44.0095
    expect(powder.lost).toBeLessThanOrEqual(co2 + 1e-6)
    expect(powder.lost).toBeGreaterThan(co2 - 0.05 * 44.0095 * 0.0339 - 0.1)
  })

  it('carbon dioxide turns limewater milky, and dilute limewater clears as hydrogencarbonate forms', () => {
    const bubble = (lime: string, times: string[]) => {
      const { k, run } = lab([['hcl', 'aq:hydrochloric-acid', '2 mol/L'], ['lime', 'aq:calcium-hydroxide', lime]])
      run('core:fetch', { equipment: 'core:boiling-tube', id: 'gen' })
      run('core:fetch', { equipment: 'core:test-tube', id: 'lw' })
      run('core:transfer', { source: 'lime', destination: 'lw', volume: '5 mL', tool: 'pour' })
      run('core:transfer', { source: 'hcl', destination: 'gen', volume: '15 mL', tool: 'pour' })
      run('core:add-solid', { substance: 'aq:marble-chips', destination: 'gen', mass: '1 g' })
      run('core:connect-gas', { container: 'gen', into: 'lw' })
      return times.map((d) => {
        run('core:advance-time', { duration: d })
        const c = k.world.containers.lw
        return { cloudyMg: appearance(cat, c, 1.4)?.precipitate?.suspendedMg ?? 0, pH: layerPH(cat, meanLayer(c.contents), 298)! }
      })
    }
    // The acid in the generator takes up the first CO₂ itself; then bubbles reach the limewater.
    const [, milky] = bubble('0.02 mol/L', ['2 s', '25 s'])
    expect(milky.cloudyMg).toBeGreaterThan(3)
    const [, , dilute] = bubble('0.004 mol/L', ['2 s', '25 s', '2 min'])
    // Ca(HCO₃)₂ dissolves: clear again, and acidic from the dissolved CO₂.
    expect(dilute.cloudyMg).toBe(0)
    expect(dilute.pH).toBeLessThan(6.5)
  })
})

describe('carbon dioxide from dissolved carbonate', () => {
  it('an alkaline carbonate buffer keeps the cheaper solver; acid on sodium carbonate fizzes', () => {
    const buffer = { volumeL: 0.1, species: { 'core:sodium-carbonate': 0.0015, 'core:sodium-bicarbonate': 0.0035 } }
    expect(isIonic(cat, buffer)).toBe(false)
    const { run } = lab([['co3', 'core:sodium-carbonate', '0.5 mol/L'], ['hcl', 'aq:hydrochloric-acid', '1 mol/L']])
    run('core:fetch', { equipment: 'core:boiling-tube', id: 't' })
    run('core:transfer', { source: 'co3', destination: 't', volume: '10 mL', tool: 'pour' })
    run('core:transfer', { source: 'hcl', destination: 't', volume: '15 mL', tool: 'pour' })
    run('core:advance-time', { duration: '5 s' })
    expect(String(run('core:test-gas', { container: 't', test: 'lighted-splint' }).appearance)).toMatch(/goes out/)
  })
})

describe('gas tests', () => {
  it('hydrogen pops, oxygen-free air leaves a glowing splint as it was', () => {
    const { run } = lab([['hcl', 'aq:hydrochloric-acid', '2 mol/L']])
    run('core:fetch', { equipment: 'core:test-tube', id: 't' })
    run('core:transfer', { source: 'hcl', destination: 't', volume: '5 mL', tool: 'pour' })
    expect(String(run('core:test-gas', { container: 't', test: 'lighted-splint' }).appearance)).not.toMatch(/squeaky/)
    run('core:add-solid', { substance: 'aq:magnesium-ribbon', destination: 't', mass: '0.03 g' })
    run('core:advance-time', { duration: '10 s' })
    expect(String(run('core:test-gas', { container: 't', test: 'lighted-splint' }).appearance)).toMatch(/squeaky pop/)
    expect(String(run('core:test-gas', { container: 't', test: 'glowing-splint' }).appearance)).not.toMatch(/relights/)
  })

  it('carbon dioxide puts a lighted splint out', () => {
    const { run } = lab([['hcl', 'aq:hydrochloric-acid', '2 mol/L']])
    run('core:fetch', { equipment: 'core:boiling-tube', id: 't' })
    run('core:transfer', { source: 'hcl', destination: 't', volume: '10 mL', tool: 'pour' })
    run('core:add-solid', { substance: 'aq:powdered-marble', destination: 't', mass: '1 g' })
    run('core:advance-time', { duration: '20 s' })
    expect(String(run('core:test-gas', { container: 't', test: 'lighted-splint' }).appearance)).toMatch(/goes out/)
  })

  it('ammonia from an ammonium salt and alkali, warmed, turns damp red litmus blue', () => {
    const { k, run } = lab([['nh4', 'aq:ammonium-chloride', '1 mol/L'], ['naoh', 'aq:sodium-hydroxide', '2 mol/L']])
    run('core:fetch', { equipment: 'core:test-tube', id: 't' })
    run('core:transfer', { source: 'nh4', destination: 't', volume: '2 mL', tool: 'pour' })
    expect(String(run('core:test-gas', { container: 't', test: 'damp-red-litmus' }).appearance)).toMatch(/stays red/)
    run('core:transfer', { source: 'naoh', destination: 't', volume: '2 mL', tool: 'pour' })
    k.world.containers.t.contents.temperatureK = 333
    expect(String(run('core:test-gas', { container: 't', test: 'damp-red-litmus' }).appearance)).toMatch(/blue/)
  })
})
