// Reversion of histidine auxotrophs (the Ames test): a trace of histidine lets His⁻ cells divide a
// few times, so mutations can be fixed; revertants found colonies; a mutagen induces only its own
// kind of mutation, and kills where it is concentrated, so revertants rise with dose and then fall.
// Also molten top agar, which sets as it cools, and heat killing above the growth range.
import { describe, expect, it } from 'vitest'
import { loadAllPacks } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { addEquipment, addPlace, addSupply, createKernel, emptyWorld, type Kernel } from '../src/kernel/index.ts'

const { catalogue: cat } = Catalogue.build(loadAllPacks())
const TA1535 = 'micro:salmonella-typhimurium-ta1535'
const TA1538 = 'micro:salmonella-typhimurium-ta1538'

function run(k: Kernel, op: string, params: Record<string, unknown>) {
  const r = k.execute({ op, params })
  if (!r.ok) throw new Error(`${op}: ${r.refusal.message}`)
  return r
}

interface Plate {
  strain: string
  /** Mutagen on the disc (µg in 50 µL), or mixed into the top agar (`mixed`). */
  disc?: { substance: string; ug: number }
  mixed?: { substance: string; ug: number }
  top?: string
}

/** Pour each plate (100 µL of culture in 2 mL of top agar at 50 °C), add its disc, incubate 48 h at 37 °C. */
function ames(plates: Plate[], seed = 1) {
  const w = emptyWorld(seed)
  addEquipment(w, cat, 'p200', 'core:micropipette-p200')
  addEquipment(w, cat, 'counter', 'core:colony-counter')
  addPlace(w, cat, 'incubator', 'core:incubator')
  for (const s of [TA1535, TA1538]) addSupply(w, cat, { id: s, label: s, container: 'core:microtube-1.5ml', amount: '1 mL', preparation: 'micro:nutrient-broth-sterile', populations: [{ substance: s, perL: 1.5e12 }] })
  plates.forEach((p, i) => {
    const agent = p.disc ?? p.mixed
    if (agent) addSupply(w, cat, { id: `m${i}`, label: 'mutagen', container: 'core:microtube-1.5ml', amount: '1 mL', preparation: 'core:water-deionised', components: [{ substance: agent.substance, conc: `${agent.ug * 20} ug/mL` }] })
    addSupply(w, cat, { id: `top${i}`, label: 'top', container: 'core:culture-tube-20ml', amount: '2 mL', preparation: p.top ?? 'micro:minimal-top-agar', temperature: '50 Cel' })
    addSupply(w, cat, { id: `p${i}`, label: `plate ${i}`, container: 'core:petri-dish-90mm', amount: '20 mL', preparation: 'micro:minimal-glucose-agar-plate' })
  })
  const k = createKernel(cat, w)
  plates.forEach((p, i) => {
    run(k, 'core:attach-tip', { pipette: 'p200' })
    run(k, 'core:transfer', { source: p.strain, destination: `top${i}`, volume: '100 uL', tool: 'p200' })
    run(k, 'core:eject-tip', { pipette: 'p200' })
    if (p.mixed) {
      run(k, 'core:attach-tip', { pipette: 'p200' })
      run(k, 'core:transfer', { source: `m${i}`, destination: `top${i}`, volume: '50 uL', tool: 'p200' })
      run(k, 'core:eject-tip', { pipette: 'p200' })
    }
    run(k, 'core:mix', { container: `top${i}`, method: 'swirl' })
    run(k, 'core:transfer', { source: `top${i}`, destination: `p${i}`, all: true })
  })
  run(k, 'core:advance-time', { duration: '5 min' })
  plates.forEach((p, i) => {
    run(k, 'core:fetch', { equipment: 'core:filter-disc-13mm', id: `d${i}`, label: `disc ${i}` })
    if (p.disc) {
      run(k, 'core:attach-tip', { pipette: 'p200' })
      run(k, 'core:transfer', { source: `m${i}`, destination: `d${i}`, volume: '50 uL', tool: 'p200' })
      run(k, 'core:eject-tip', { pipette: 'p200' })
    }
    run(k, 'core:apply-disc', { disc: `d${i}`, plate: `p${i}`, position: 1 })
    run(k, 'core:place-in', { container: `p${i}`, place: 'incubator' })
  })
  run(k, 'core:advance-time', { duration: '48 h' })
  return plates.map((p, i) => {
    const surface = k.world.containers[`p${i}`].contents.surface!
    const display = (run(k, 'core:measure', { instrument: 'counter', subject: `p${i}` }).outputs as { display: string }).display
    // Expected revertants (the colonies are a Poisson draw from this).
    const revertants = Object.entries(surface).filter(([key]) => key.endsWith('-revertant')).reduce((a, [, s]) => a + s.viable, 0)
    return { revertants, display, background: surface[p.strain] }
  })
}

const AZIDE = 'micro:sodium-azide'
const NOPD = 'micro:4-nitro-o-phenylenediamine'

describe('the Ames test', () => {
  it('each tester strain reverts with its own kind of mutagen; spontaneous revertants on the controls', () => {
    const [c35, az35, np35, c38, az38, np38] = ames([
      { strain: TA1535 }, { strain: TA1535, disc: { substance: AZIDE, ug: 1 } }, { strain: TA1535, disc: { substance: NOPD, ug: 10 } },
      { strain: TA1538 }, { strain: TA1538, disc: { substance: AZIDE, ug: 1 } }, { strain: TA1538, disc: { substance: NOPD, ug: 10 } },
    ])
    // Spontaneous: TA1535 about 10-20, TA1538 about 15-30 per plate.
    expect(c35.revertants).toBeGreaterThan(8)
    expect(c35.revertants).toBeLessThan(20)
    expect(c38.revertants).toBeGreaterThan(15)
    expect(c38.revertants).toBeLessThan(30)
    // Azide (base substitutions) reverts hisG46, 4-NOPD (frameshifts) hisD3052; neither the other.
    expect(az35.revertants).toBeGreaterThan(5 * c35.revertants)
    expect(np38.revertants).toBeGreaterThan(4 * c38.revertants)
    expect(np35.revertants).toBeLessThan(1.2 * c35.revertants)
    expect(az38.revertants).toBeLessThan(1.2 * c38.revertants)
    // The His⁻ cells divided a few times on the trace of histidine: a faint lawn behind the colonies.
    expect(c35.background.doublings).toBeGreaterThan(3)
    expect(c35.background.doublings).toBeLessThan(6)
    expect(c35.display).toContain('faint background lawn')
  }, 120000)

  it('without histidine in the top agar the cells cannot divide, so the mutagen induces nothing', () => {
    const [plain, his] = ames([
      { strain: TA1535, disc: { substance: AZIDE, ug: 1 }, top: 'micro:soft-agar' },
      { strain: TA1535, disc: { substance: AZIDE, ug: 1 } },
    ])
    expect(plain.background.doublings).toBeLessThan(0.5)
    expect(plain.revertants).toBeLessThan(12)
    expect(his.revertants).toBeGreaterThan(5 * plain.revertants)
    expect(plain.display).not.toContain('background lawn')
  }, 120000)

  it('revertants rise with the dose, then fall as the mutagen kills round the disc', () => {
    const [low, mid, high] = ames([1, 15, 50].map((ug) => ({ strain: TA1535, disc: { substance: AZIDE, ug } })))
    expect(mid.revertants).toBeGreaterThan(1.5 * low.revertants)
    expect(high.revertants).toBeLessThan(mid.revertants)
    expect(high.display).toMatch(/no background growth within a (2|3)\d mm circle/)
    expect(low.display).not.toContain('no background growth')
  }, 120000)

  it('a mutagen mixed into the top agar acts all over the plate', () => {
    const [control, mixed] = ames([{ strain: TA1535 }, { strain: TA1535, mixed: { substance: AZIDE, ug: 1 } }])
    expect(mixed.revertants).toBeGreaterThan(5 * control.revertants)
  }, 120000)
})

describe('molten agar and heat', () => {
  function bench(tempC: number) {
    const w = emptyWorld(1)
    addEquipment(w, cat, 'p200', 'core:micropipette-p200')
    addPlace(w, cat, 'block', 'core:heating-block')
    addSupply(w, cat, { id: 'cells', label: 'cells', container: 'core:microtube-1.5ml', amount: '1 mL', preparation: 'micro:nutrient-broth-sterile', populations: [{ substance: TA1535, perL: 1.5e12 }] })
    addSupply(w, cat, { id: 'top', label: 'top', container: 'core:culture-tube-20ml', amount: '2 mL', preparation: 'micro:minimal-top-agar', temperature: `${tempC} Cel` })
    addSupply(w, cat, { id: 'plate', label: 'plate', container: 'core:petri-dish-90mm', amount: '20 mL', preparation: 'micro:minimal-glucose-agar-plate' })
    const k = createKernel(cat, w)
    run(k, 'core:set-environment', { device: 'block', temperature: `${tempC} Cel` })
    run(k, 'core:place-in', { container: 'top', place: 'block' })
    return k
  }
  const viable = (k: Kernel, id: string) => Object.values(k.world.containers[id].contents.layers[0]?.populations ?? {}).reduce((a, p) => a + p.viable, 0)

  it('top agar left to cool on the bench sets in its tube and cannot be poured', () => {
    const k = bench(50)
    run(k, 'core:remove-from', { container: 'top' })
    run(k, 'core:advance-time', { duration: '1 min' })
    expect(k.world.containers.top.contents.gelled).toBeUndefined()
    run(k, 'core:advance-time', { duration: '15 min' })
    expect(k.world.containers.top.contents.gelled).toBe(true)
    const r = k.execute({ op: 'core:transfer', params: { source: 'top', destination: 'plate', all: true } })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.refusal.code).toBe('SET')
    // Agar supplied at room temperature has set already.
    const w = emptyWorld(1)
    const cold = addSupply(w, cat, { id: 'cold', label: 'cold', container: 'core:culture-tube-20ml', amount: '2 mL', preparation: 'micro:minimal-top-agar' })
    expect(cold.contents.gelled).toBe(true)
  })

  it('cells poured in molten top agar are spread through it, not left where they fell', () => {
    const k = bench(50)
    run(k, 'core:attach-tip', { pipette: 'p200' })
    run(k, 'core:transfer', { source: 'cells', destination: 'top', volume: '100 uL', tool: 'p200' })
    run(k, 'core:transfer', { source: 'top', destination: 'plate', all: true })
    expect(Object.values(k.world.containers.plate.contents.surface!).every((s) => s.spread)).toBe(true)
  })

  it('cells die in agar held too hot, and survive a short spell at pouring temperature', () => {
    const hot = bench(60)
    run(hot, 'core:attach-tip', { pipette: 'p200' })
    run(hot, 'core:transfer', { source: 'cells', destination: 'top', volume: '100 uL', tool: 'p200' })
    const before = viable(hot, 'top')
    run(hot, 'core:advance-time', { duration: '10 min' })
    expect(viable(hot, 'top') / before).toBeLessThan(0.01)
    const warm = bench(47)
    run(warm, 'core:attach-tip', { pipette: 'p200' })
    run(warm, 'core:transfer', { source: 'cells', destination: 'top', volume: '100 uL', tool: 'p200' })
    const start = viable(warm, 'top')
    run(warm, 'core:advance-time', { duration: '2 min' })
    expect(viable(warm, 'top') / start).toBeGreaterThan(0.9)
  })
})

describe('auxotrophs in broth', () => {
  it('a His⁻ culture grows only as far as its histidine allows, and holds its spontaneous revertants', () => {
    const w = emptyWorld(1)
    addPlace(w, cat, 'incubator', 'core:incubator')
    // 10 µM histidine makes about 3 × 10⁸ cells per mL at 3.4e-17 mol a cell.
    addSupply(w, cat, { id: 'broth', label: 'broth', container: 'core:culture-tube-20ml', amount: '10 mL', preparation: 'micro:mineral-salts-medium',
      components: [{ substance: 'core:glucose', conc: '4 g/L' }, { substance: 'micro:l-histidine', conc: '10 uM' }, { substance: 'micro:biotin', conc: '1 uM' }], populations: [{ substance: TA1538, perL: 1e10 }] })
    const k = createKernel(cat, w)
    const pops = () => k.world.containers.broth.contents.layers[0].populations!
    expect(pops()[`${TA1538}-revertant`].count).toBeCloseTo(1e8 * 1e-7, 3)
    run(k, 'core:place-in', { container: 'broth', place: 'incubator' })
    run(k, 'core:advance-time', { duration: '24 h' })
    const his = pops()[TA1538].count / 0.01
    expect(his).toBeGreaterThan(2.5e11)
    expect(his).toBeLessThan(3.2e11)
    // The revertants need no histidine: they go on to the medium's full density.
    expect(pops()[`${TA1538}-revertant`].count / 0.01).toBeGreaterThan(1e12)
  }, 120000)
})
